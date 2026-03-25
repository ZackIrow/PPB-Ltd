const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIG — 100% FREE, no API key needed
// PlanIt.org.uk covers 417 UK planning authorities
// ─────────────────────────────────────────────
const PLANIT_BASE  = "https://www.planit.org.uk";
const ALERT_EMAIL  = process.env.ALERT_EMAIL  || "zack@pinnaclepropertybroker.com";
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const MIN_UNITS    = 30;

// ─────────────────────────────────────────────
// TARGET COUNCILS — exact names used by PlanIt
// ─────────────────────────────────────────────
const COUNCILS = [
  // Manchester
  { auth: "Manchester",  area: "Manchester" },
  { auth: "Salford",     area: "Manchester" },
  { auth: "Trafford",    area: "Manchester" },
  { auth: "Stockport",   area: "Manchester" },
  { auth: "Oldham",      area: "Manchester" },
  { auth: "Bolton",      area: "Manchester" },
  { auth: "Bury",        area: "Manchester" },
  { auth: "Rochdale",    area: "Manchester" },
  { auth: "Tameside",    area: "Manchester" },
  { auth: "Wigan",       area: "Manchester" },
  // Birmingham
  { auth: "Birmingham",  area: "Birmingham" },
  { auth: "Coventry",    area: "Birmingham" },
  { auth: "Dudley",      area: "Birmingham" },
  { auth: "Sandwell",    area: "Birmingham" },
  { auth: "Solihull",    area: "Birmingham" },
  { auth: "Walsall",     area: "Birmingham" },
  { auth: "Wolverhampton", area: "Birmingham" },
  // Bristol
  { auth: "Bristol",               area: "Bristol" },
  { auth: "South Gloucestershire", area: "Bristol" },
  { auth: "Bath",                  area: "Bristol" },
  { auth: "North Somerset",        area: "Bristol" },
  // Cornwall
  { auth: "Cornwall", area: "Cornwall" },
];

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let cache       = [];
let seenIds     = new Set();
let lastUpdated = null;
let loading     = false;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function extractUnits(text) {
  if (!text) return 0;
  const patterns = [
    /(\d{2,4})\s*(no\.?\s*)?(new\s*)?(dwelling|dwellings|unit|units|apartment|apartments|flat|flats|home|homes|house|houses)/i,
    /(erection|construction|development)\s+of\s+(\d{2,4})\s*(no\.?\s*)?(residential|dwelling|apartment|flat|unit|home)/i,
    /(\d{2,4})\s*x\s*(dwelling|unit|apartment|flat)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseInt(m[1]) || parseInt(m[2]);
      if (n && n >= MIN_UNITS && n < 5000) return n;
    }
  }
  return 0;
}

function isResidential(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return t.includes("dwelling") || t.includes("residential") ||
         t.includes("apartment") || t.includes("flat") ||
         t.includes("housing")   || t.includes("homes") ||
         t.includes("house")     || t.includes("affordable");
}

function mapStatus(status, decision) {
  const s = (status   || "").toLowerCase();
  const d = (decision || "").toLowerCase();
  const combined = s + " " + d;
  if (combined.includes("approv") || combined.includes("grant") || combined.includes("permitted")) return "approved";
  if (combined.includes("refus"))    return "refused";
  if (combined.includes("withdraw")) return "withdrawn";
  return "awaiting";
}

function mapApp(raw, area) {
  const description = raw.description || raw.summary || "";
  const units = extractUnits(description);

  return {
    id:        raw.uid  || raw.name || String(Math.random()),
    reference: raw.uid  || raw.reference || "—",
    address:   raw.address || raw.location_text || "Address not available",
    proposal:  description,
    units,
    status:    mapStatus(raw.app_state, raw.decision),
    council:   raw.authority_name || raw.auth_name || "—",
    area,
    submitted: raw.start_date  || raw.date_received || "",
    decided:   raw.decision_date || "",
    portalUrl: raw.url  || raw.link || "",
    applicant: {
      name:    raw.applicant_name    || raw.agent_company || "Not listed",
      email:   raw.applicant_email   || "—",
      phone:   raw.applicant_phone   || "—",
      company: raw.applicant_company || "—",
    },
    agent: {
      name:  raw.agent_name    || raw.agent_company || "—",
      email: raw.agent_email   || "—",
      phone: raw.agent_phone   || "—",
    },
  };
}

// ─────────────────────────────────────────────
// FETCH ONE COUNCIL FROM PLANIT (FREE)
// ─────────────────────────────────────────────
async function fetchCouncil(auth, area) {
  try {
    // Search for major residential applications in the last 365 days
    const params = new URLSearchParams({
      auth:       auth,
      app_size:   "Major",
      search:     "residential OR dwelling OR apartments OR flats OR housing",
      recent:     "365",
      pg_sz:      "100",
      compress:   "on",
    });

    const url = `${PLANIT_BASE}/api/applics/json?${params}`;
    console.log(`Fetching ${auth}...`);

    const r = await fetch(url, {
      headers: { "User-Agent": "Pinnacle-Property-Broker/1.0 (zack@pinnaclepropertybroker.com)" }
    });

    if (!r.ok) {
      console.log(`${auth}: HTTP ${r.status}`);
      return [];
    }

    const d = await r.json();
    const records = d.records || [];
    console.log(`${auth}: ${records.length} major residential applications`);

    // Filter for 30+ units OR major residential
    const filtered = records.filter(a => {
      const desc  = a.description || a.summary || "";
      const units = extractUnits(desc);
      return units >= MIN_UNITS || (isResidential(desc) && (a.app_size === "Major" || (a.app_size || "").toLowerCase().includes("major")));
    });

    console.log(`${auth}: ${filtered.length} matching 30+ units`);
    return filtered.map(a => mapApp(a, area));

  } catch(e) {
    console.error(`Failed ${auth}:`, e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// FETCH ALL COUNCILS
// ─────────────────────────────────────────────
async function fetchAll() {
  loading = true;
  console.log("\nFetching from PlanIt.org.uk (free)...");
  const results = [];

  for (const c of COUNCILS) {
    const apps = await fetchCouncil(c.auth, c.area);
    results.push(...apps);
    // Polite delay — PlanIt has rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  // Deduplicate
  const unique = [];
  const seen   = new Set();
  for (const a of results) {
    if (!seen.has(a.id)) { seen.add(a.id); unique.push(a); }
  }

  loading     = false;
  lastUpdated = new Date().toISOString();
  console.log(`\nTotal: ${unique.length} applications found across all areas`);
  return unique;
}

// ─────────────────────────────────────────────
// SEND EMAIL ALERT
// ─────────────────────────────────────────────
async function sendAlert(newApps) {
  if (!SENDGRID_KEY || !newApps.length) return;
  try {
    const subject = newApps.length === 1
      ? `🔔 NEW SITE: ${newApps[0].address}`
      : `🔔 ${newApps.length} New Planning Sites — Pinnacle Alert`;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;">
        <div style="background:#000;padding:20px;border-radius:8px 8px 0 0;">
          <h1 style="color:#c8a96e;margin:0;font-size:20px;">▲ PINNACLE PROPERTY BROKER</h1>
          <p style="color:#888;margin:4px 0 0;font-size:12px;">Planning Alert · ${new Date().toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long", year:"numeric" })}</p>
        </div>
        <div style="background:#fff;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee;">
          <h2 style="color:#111;font-size:16px;margin-top:0;">${newApps.length} New Application${newApps.length > 1 ? "s" : ""}</h2>
          ${newApps.map(a => `
            <div style="border:1px solid #ddd;border-left:4px solid ${a.status === "approved" ? "#00c96e" : "#ffab00"};border-radius:6px;padding:14px;margin-bottom:14px;">
              <h3 style="margin:0 0 4px;font-size:14px;">${a.address}</h3>
              <p style="margin:0 0 8px;font-size:12px;color:#888;">${a.council} · ${a.area} · Ref: ${a.reference}</p>
              <p style="margin:0 0 8px;font-size:13px;">
                <strong>Units:</strong> <span style="color:#c8a96e;font-weight:bold;">${a.units || "Major"}</span> &nbsp;·&nbsp;
                <strong>Status:</strong> ${a.status === "approved" ? "✅ FULL CONSENT" : "⏳ AWAITING DECISION"}
              </p>
              ${a.proposal ? `<p style="font-size:12px;color:#666;font-style:italic;">"${a.proposal.substring(0, 200)}..."</p>` : ""}
              <p style="font-size:13px;"><strong>Applicant:</strong> ${a.applicant.name}</p>
              ${a.portalUrl ? `<a href="${a.portalUrl}" style="display:inline-block;background:#000;color:#c8a96e;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:12px;font-weight:bold;margin-top:6px;">View Application →</a>` : ""}
            </div>
          `).join("")}
          <p style="font-size:11px;color:#aaa;text-align:center;margin-top:20px;">Pinnacle Property Broker Ltd · Manchester · Birmingham · Bristol · Cornwall</p>
        </div>
      </div>`;

    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${SENDGRID_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: ALERT_EMAIL }] }],
        from:    { email: ALERT_EMAIL, name: "Pinnacle Planning Alerts" },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
    });
    console.log(`Alert sent for ${newApps.length} applications`);
  } catch(e) {
    console.error("Email failed:", e.message);
  }
}

// ─────────────────────────────────────────────
// HOURLY CHECK FOR NEW APPLICATIONS
// ─────────────────────────────────────────────
async function hourlyCheck() {
  console.log(`\nHourly check — ${new Date().toLocaleTimeString("en-GB")}`);
  const fresh   = await fetchAll();
  const newOnes = fresh.filter(a => !seenIds.has(a.id));
  if (newOnes.length) {
    newOnes.forEach(a => seenIds.add(a.id));
    cache = [...newOnes, ...cache];
    await sendAlert(newOnes);
    console.log(`${newOnes.length} new applications found and alerted`);
  } else {
    console.log("No new applications since last check");
  }
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status:       "ok",
    applications: cache.length,
    lastUpdated,
    loading,
    source:       "PlanIt.org.uk (free)",
    councils:     COUNCILS.length,
    areas:        ["Manchester", "Birmingham", "Bristol", "Cornwall"],
    minUnits:     MIN_UNITS,
    emailAlerts:  !!SENDGRID_KEY,
  });
});

app.get("/api/applications", async (req, res) => {
  if (cache.length === 0 && !loading) {
    cache = await fetchAll();
    cache.forEach(a => seenIds.add(a.id));
  }
  res.json({ success: true, count: cache.length, data: cache });
});

app.get("/api/refresh", async (req, res) => {
  console.log("Manual refresh triggered");
  cache = await fetchAll();
  cache.forEach(a => seenIds.add(a.id));
  res.json({ success: true, count: cache.length, message: `Found ${cache.length} applications` });
});

app.get("/api/check-now", async (req, res) => {
  await hourlyCheck();
  res.json({ success: true, count: cache.length });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  console.log(`\n▲ PINNACLE PROPERTY BROKER`);
  console.log(`Backend running on port ${PORT}`);
  console.log(`Source: PlanIt.org.uk (FREE — no API key needed)`);
  console.log(`Areas: Manchester · Birmingham · Bristol · Cornwall`);
  console.log(`Councils: ${COUNCILS.length}`);
  console.log(`Min Units: ${MIN_UNITS}+\n`);

  cache = await fetchAll();
  cache.forEach(a => seenIds.add(a.id));
  console.log(`\nReady — ${cache.length} applications loaded`);
});

cron.schedule("0 * * * *", hourlyCheck);
