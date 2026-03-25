const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const PLANNING_API_KEY = process.env.PLANNING_API_KEY || "73vctsvl4j0fyag5";
const ALERT_EMAIL      = process.env.ALERT_EMAIL      || "zack@pinnaclepropertybroker.com";
const SENDGRID_KEY     = process.env.SENDGRID_API_KEY;
const MIN_UNITS        = 30;
const BASE             = "https://api.planning.org.uk/v1";

// ─────────────────────────────────────────────
// TARGET COUNCILS
// ─────────────────────────────────────────────
const COUNCILS = [
  { name: "manchester",             area: "Manchester" },
  { name: "salford",                area: "Manchester" },
  { name: "trafford",               area: "Manchester" },
  { name: "stockport",              area: "Manchester" },
  { name: "oldham",                 area: "Manchester" },
  { name: "bolton",                 area: "Manchester" },
  { name: "bury",                   area: "Manchester" },
  { name: "rochdale",               area: "Manchester" },
  { name: "tameside",               area: "Manchester" },
  { name: "wigan",                  area: "Manchester" },
  { name: "birmingham",             area: "Birmingham" },
  { name: "coventry",               area: "Birmingham" },
  { name: "dudley",                 area: "Birmingham" },
  { name: "sandwell",               area: "Birmingham" },
  { name: "solihull",               area: "Birmingham" },
  { name: "walsall",                area: "Birmingham" },
  { name: "wolverhampton",          area: "Birmingham" },
  { name: "bristol",                area: "Bristol"    },
  { name: "south-gloucestershire",  area: "Bristol"    },
  { name: "cornwall",               area: "Cornwall"   },
];

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let cache       = [];
let seenIds     = new Set();
let lpaMap      = {};
let lastUpdated = null;
let loading     = false;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function extractUnits(text) {
  if (!text) return 0;
  const patterns = [
    /(\d{2,4})\s*(no\.?\s*)?(dwelling|dwellings|unit|units|apartment|apartments|flat|flats|home|homes|house|houses|bed|bedroom)/i,
    /(erection|construction|development|provision)\s+of\s+(\d{2,4})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseInt(m[1]) || parseInt(m[2]);
      if (n >= MIN_UNITS) return n;
    }
  }
  return 0;
}

function isResidential(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return t.includes("dwelling") || t.includes("residential") ||
         t.includes("apartment") || t.includes("flat") ||
         t.includes("housing") || t.includes("homes") ||
         t.includes("house") || t.includes("living");
}

function mapStatus(decision) {
  const d = (decision || "").toLowerCase();
  if (d.includes("approv") || d.includes("grant") || d.includes("permitted")) return "approved";
  if (d.includes("refus"))    return "refused";
  if (d.includes("withdraw")) return "withdrawn";
  return "awaiting";
}

function mapApp(raw, area) {
  const units = extractUnits(raw.title) || extractUnits(raw.description) || 0;
  return {
    id:          raw.keyval   || raw.reference || String(Math.random()),
    reference:   raw.reference || raw.keyval   || "—",
    address:     raw.address   || "Address not available",
    proposal:    raw.title     || raw.description || "",
    units,
    status:      mapStatus(raw.decision),
    council:     raw.authority_name || "—",
    area,
    submitted:   raw.validated || raw.received_date || "",
    decided:     raw.decision_date || "",
    portalUrl:   raw.url || raw.external_url || "",
    applicant: {
      name:    raw.applicant_name    || "Not listed",
      email:   raw.applicant_email   || "—",
      phone:   raw.applicant_phone   || "—",
      address: raw.applicant_address || "—",
    },
    agent: {
      name:  raw.agent_name  || "—",
      email: raw.agent_email || "—",
      phone: raw.agent_phone || "—",
    },
  };
}

// ─────────────────────────────────────────────
// LOAD LPA MAP
// ─────────────────────────────────────────────
async function loadLPAs() {
  try {
    const r = await fetch(`${BASE}/lpas`);
    const d = await r.json();
    (d?.response?.data || []).forEach(l => {
      lpaMap[l.name.toLowerCase().replace(/\s+/g, "-")] = l.id;
    });
    console.log(`Loaded ${Object.keys(lpaMap).length} LPAs`);
  } catch (e) {
    console.error("LPA load failed:", e.message);
  }
}

// ─────────────────────────────────────────────
// FETCH ONE COUNCIL
// ─────────────────────────────────────────────
async function fetchCouncil(councilName, area, dateFrom) {
  const id = lpaMap[councilName];
  if (!id) { console.log(`LPA not found: ${councilName}`); return []; }

  try {
    const params = new URLSearchParams({
      key:         PLANNING_API_KEY,
      lpa_id:      id,
      return_data: "1",
      date_from:   dateFrom || "2024-01-01",
    });
    const r = await fetch(`${BASE}/search?${params}`);
    const d = await r.json();
    const apps = d?.response?.data || [];

    return apps
      .filter(a => {
        const text  = (a.title || "") + " " + (a.description || "");
        const units = extractUnits(text);
        const major = (a.app_size || "").toLowerCase().includes("major");
        return (units >= MIN_UNITS) || (major && isResidential(text));
      })
      .map(a => mapApp(a, area));
  } catch (e) {
    console.error(`Fetch failed for ${councilName}:`, e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// FETCH ALL COUNCILS
// ─────────────────────────────────────────────
async function fetchAll(dateFrom) {
  loading = true;
  const results = [];
  for (const c of COUNCILS) {
    const apps = await fetchCouncil(c.name, c.area, dateFrom);
    results.push(...apps);
    await new Promise(r => setTimeout(r, 300));
  }
  loading     = false;
  lastUpdated = new Date().toISOString();
  console.log(`Fetched ${results.length} applications`);
  return results;
}

// ─────────────────────────────────────────────
// SEND EMAIL VIA SENDGRID
// ─────────────────────────────────────────────
async function sendAlert(newApps) {
  if (!SENDGRID_KEY || !newApps.length) return;
  try {
    const subject = newApps.length === 1
      ? `NEW SITE: ${newApps[0].address}`
      : `${newApps.length} New Planning Sites — Pinnacle Alert`;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;">
        <div style="background:#000;padding:20px;border-radius:8px 8px 0 0;">
          <h1 style="color:#c8a96e;margin:0;font-size:20px;">▲ PINNACLE PROPERTY BROKER</h1>
          <p style="color:#888;margin:4px 0 0;font-size:12px;">Planning Intelligence Alert · ${new Date().toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long", year:"numeric" })}</p>
        </div>
        <div style="background:#fff;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee;">
          <h2 style="color:#111;font-size:16px;margin-top:0;">${newApps.length} New Application${newApps.length > 1 ? "s" : ""}</h2>
          ${newApps.map(a => `
            <div style="border:1px solid #ddd;border-left:4px solid ${a.status === "approved" ? "#00c96e" : "#ffab00"};border-radius:6px;padding:14px;margin-bottom:14px;">
              <h3 style="margin:0 0 6px;font-size:14px;color:#111;">${a.address}</h3>
              <p style="margin:0 0 8px;font-size:12px;color:#888;">${a.council} · Ref: ${a.reference}</p>
              <p style="margin:0 0 8px;font-size:13px;">
                <strong>Units:</strong> <span style="color:#c8a96e;font-weight:bold;">${a.units || "Major scheme"}</span> &nbsp;·&nbsp;
                <strong>Status:</strong> <span style="color:${a.status === "approved" ? "#00a854" : "#d48000"}">${a.status === "approved" ? "✅ FULL CONSENT" : "⏳ AWAITING DECISION"}</span>
              </p>
              ${a.proposal ? `<p style="margin:0 0 10px;font-size:12px;color:#666;font-style:italic;">"${a.proposal.substring(0, 180)}${a.proposal.length > 180 ? "..." : ""}"</p>` : ""}
              <div style="background:#f5f5f5;padding:10px;border-radius:4px;margin-bottom:10px;font-size:13px;">
                <strong>Applicant:</strong> ${a.applicant.name}<br/>
                ${a.applicant.email !== "—" ? `📧 <a href="mailto:${a.applicant.email}">${a.applicant.email}</a><br/>` : ""}
                ${a.applicant.phone !== "—" ? `📞 ${a.applicant.phone}` : ""}
              </div>
              ${a.agent.name !== "—" ? `
              <div style="background:#f5f5f5;padding:10px;border-radius:4px;margin-bottom:10px;font-size:13px;">
                <strong>Agent:</strong> ${a.agent.name}<br/>
                ${a.agent.email !== "—" ? `📧 <a href="mailto:${a.agent.email}">${a.agent.email}</a>` : ""}
              </div>` : ""}
              ${a.portalUrl ? `<a href="${a.portalUrl}" style="display:inline-block;background:#000;color:#c8a96e;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:12px;font-weight:bold;">View Application →</a>` : ""}
            </div>
          `).join("")}
          <p style="font-size:11px;color:#aaa;text-align:center;margin-top:20px;">
            Pinnacle Property Broker Ltd · Monitoring Manchester · Birmingham · Bristol · Cornwall
          </p>
        </div>
      </div>`;

    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${SENDGRID_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: ALERT_EMAIL }] }],
        from:    { email: ALERT_EMAIL, name: "Pinnacle Planning Alerts" },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
    });
    console.log(`Alert sent to ${ALERT_EMAIL} for ${newApps.length} applications`);
  } catch (e) {
    console.error("Email send failed:", e.message);
  }
}

// ─────────────────────────────────────────────
// HOURLY CHECK
// ─────────────────────────────────────────────
async function hourlyCheck() {
  console.log(`Hourly check — ${new Date().toLocaleTimeString("en-GB")}`);
  const fresh = await fetchAll(new Date(Date.now() - 48 * 3600000).toISOString().split("T")[0]);
  const newOnes = fresh.filter(a => !seenIds.has(a.id));
  if (newOnes.length) {
    newOnes.forEach(a => seenIds.add(a.id));
    cache = [...newOnes, ...cache];
    await sendAlert(newOnes);
    console.log(`${newOnes.length} new applications found and alerted`);
  } else {
    console.log("No new applications");
  }
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Health
app.get("/health", (req, res) => {
  res.json({
    status:       "ok",
    applications: cache.length,
    lastUpdated,
    loading,
    areas:        ["Manchester", "Birmingham", "Bristol", "Cornwall"],
    minUnits:     MIN_UNITS,
    apiKey:       !!PLANNING_API_KEY,
    emailAlerts:  !!SENDGRID_KEY,
  });
});

// All applications
app.get("/api/applications", async (req, res) => {
  if (cache.length === 0 && !loading) {
    cache = await fetchAll("2024-01-01");
    cache.forEach(a => seenIds.add(a.id));
  }
  res.json({ success: true, count: cache.length, data: cache });
});

// Single application
app.get("/api/applications/:id", (req, res) => {
  const app = cache.find(a => a.id === req.params.id);
  if (!app) return res.status(404).json({ success: false, error: "Not found" });
  res.json({ success: true, data: app });
});

// Force refresh
app.get("/api/refresh", async (req, res) => {
  cache = await fetchAll("2024-01-01");
  cache.forEach(a => seenIds.add(a.id));
  res.json({ success: true, count: cache.length });
});

// Manual alert check
app.get("/api/check-now", async (req, res) => {
  await hourlyCheck();
  res.json({ success: true, count: cache.length });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  console.log(`Pinnacle Planning Backend running on port ${PORT}`);
  await loadLPAs();
  cache = await fetchAll("2024-01-01");
  cache.forEach(a => seenIds.add(a.id));
  console.log(`Ready — ${cache.length} applications loaded`);
});

// Run every hour
cron.schedule("0 * * * *", hourlyCheck);
