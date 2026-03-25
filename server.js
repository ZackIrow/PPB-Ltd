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
// AREA KEYWORDS — used to filter results by location
// ─────────────────────────────────────────────
const AREA_KEYWORDS = {
  Manchester: ["manchester","salford","trafford","stockport","oldham","bolton","bury","rochdale","tameside","wigan","greater manchester"],
  Birmingham: ["birmingham","coventry","dudley","sandwell","solihull","walsall","wolverhampton","west midlands"],
  Bristol:    ["bristol","south gloucestershire","bath","somerset"],
  Cornwall:   ["cornwall","truro","penzance","falmouth","newquay","camborne","redruth","bodmin","st austell"],
};

const ALL_KEYWORDS = Object.values(AREA_KEYWORDS).flat();

function getArea(address, authority) {
  const text = ((address||"") + " " + (authority||"")).toLowerCase();
  for (const [area, keywords] of Object.entries(AREA_KEYWORDS)) {
    if (keywords.some(k => text.includes(k))) return area;
  }
  return null;
}

function isTargetArea(address, authority) {
  return getArea(address, authority) !== null;
}

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let cache       = [];
let seenIds     = new Set();
let lastUpdated = null;
let loading     = false;
let lpaList     = [];
let targetLpaIds = [];

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function extractUnits(text) {
  if (!text) return 0;
  const patterns = [
    /(\d{2,4})\s*(no\.?\s*)?(new\s*)?(dwelling|dwellings|unit|units|apartment|apartments|flat|flats|home|homes|house|houses|bed|bedroom|studio)/i,
    /(erection|construction|development|provision|creation)\s+of\s+(\d{2,4})\s*(no\.?\s*)?(new\s*)?(dwelling|residential|apartment|flat|unit|home)/i,
    /(\d{2,4})\s*x\s*(dwelling|unit|apartment|flat|home)/i,
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
         t.includes("housing") || t.includes("homes") ||
         t.includes("house") || t.includes("living") ||
         t.includes("affordable housing");
}

function mapStatus(decision) {
  const d = (decision || "").toLowerCase();
  if (d.includes("approv") || d.includes("grant") || d.includes("permitted")) return "approved";
  if (d.includes("refus"))    return "refused";
  if (d.includes("withdraw")) return "withdrawn";
  return "awaiting";
}

function mapApp(raw) {
  const text  = (raw.title || "") + " " + (raw.description || "");
  const units = extractUnits(text);
  const area  = getArea(raw.address, raw.authority_name) || "Other";

  return {
    id:        raw.keyval || raw.reference || String(Date.now() + Math.random()),
    reference: raw.reference || raw.keyval || "—",
    address:   raw.address   || "Address not available",
    proposal:  raw.title     || raw.description || "",
    units,
    status:    mapStatus(raw.decision),
    council:   raw.authority_name || "—",
    area,
    submitted: raw.validated || raw.received_date || "",
    decided:   raw.decision_date || "",
    portalUrl: raw.url || raw.external_url || "",
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
// LOAD ALL LPAS AND FIND TARGET IDS
// ─────────────────────────────────────────────
async function loadLPAs() {
  try {
    console.log("Loading LPA list...");
    const r = await fetch(`${BASE}/lpas`);
    const d = await r.json();
    lpaList  = d?.response?.data || [];
    console.log(`Total LPAs available: ${lpaList.length}`);

    // Find LPAs that match our target areas
    targetLpaIds = lpaList
      .filter(lpa => {
        const name = (lpa.name || "").toLowerCase();
        return ALL_KEYWORDS.some(k => name.includes(k));
      })
      .map(lpa => ({ id: lpa.id, name: lpa.name }));

    console.log(`Target LPAs found: ${targetLpaIds.length}`);
    console.log(targetLpaIds.map(l => l.name).join(", "));

    return targetLpaIds;
  } catch(e) {
    console.error("LPA load failed:", e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// FETCH BY LPA ID
// ─────────────────────────────────────────────
async function fetchByLPA(lpaId, lpaName, dateFrom) {
  try {
    const params = new URLSearchParams({
      key:         PLANNING_API_KEY,
      lpa_id:      lpaId,
      return_data: "1",
      date_from:   dateFrom || "2024-01-01",
    });

    const r = await fetch(`${BASE}/search?${params}`);
    const d = await r.json();

    if (d?.response?.status !== "OK") {
      console.log(`No data for ${lpaName}: ${JSON.stringify(d?.response?.status)}`);
      return [];
    }

    const apps = d?.response?.data || [];
    console.log(`${lpaName}: ${apps.length} total applications`);

    // Filter for residential 30+ units OR major residential
    const filtered = apps.filter(a => {
      const text  = (a.title || "") + " " + (a.description || "");
      const units = extractUnits(text);
      const major = (a.app_size || "").toLowerCase().includes("major");
      const residential = isResidential(text);
      return (units >= MIN_UNITS) || (major && residential);
    });

    console.log(`${lpaName}: ${filtered.length} matching 30+ unit residential`);
    return filtered.map(mapApp);

  } catch(e) {
    console.error(`Failed ${lpaName}:`, e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// FETCH ALL TARGET AREAS
// ─────────────────────────────────────────────
async function fetchAll(dateFrom) {
  loading = true;
  console.log(`\nFetching applications from ${dateFrom || "2024-01-01"}...`);

  // Make sure we have LPAs loaded
  if (targetLpaIds.length === 0) {
    await loadLPAs();
  }

  if (targetLpaIds.length === 0) {
    console.error("No target LPAs found — check API key");
    loading = false;
    return [];
  }

  const results = [];

  for (const lpa of targetLpaIds) {
    const apps = await fetchByLPA(lpa.id, lpa.name, dateFrom);
    results.push(...apps);
    // Polite delay between requests
    await new Promise(r => setTimeout(r, 500));
  }

  // Deduplicate by ID
  const unique = [];
  const seen   = new Set();
  for (const a of results) {
    if (!seen.has(a.id)) { seen.add(a.id); unique.push(a); }
  }

  loading     = false;
  lastUpdated = new Date().toISOString();
  console.log(`\nTotal: ${unique.length} unique matching applications found`);
  return unique;
}

// ─────────────────────────────────────────────
// SEND EMAIL ALERT
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
          <p style="color:#888;margin:4px 0 0;font-size:12px;">Planning Alert · ${new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</p>
        </div>
        <div style="background:#fff;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee;">
          <h2 style="color:#111;font-size:16px;margin-top:0;">${newApps.length} New Application${newApps.length>1?"s":""}</h2>
          ${newApps.map(a => `
            <div style="border:1px solid #ddd;border-left:4px solid ${a.status==="approved"?"#00c96e":"#ffab00"};border-radius:6px;padding:14px;margin-bottom:14px;">
              <h3 style="margin:0 0 4px;font-size:14px;">${a.address}</h3>
              <p style="margin:0 0 8px;font-size:12px;color:#888;">${a.council} · ${a.area} · Ref: ${a.reference}</p>
              <p style="margin:0 0 8px;font-size:13px;">
                <strong>Units:</strong> <span style="color:#c8a96e;font-weight:bold;">${a.units||"Major"}</span> &nbsp;·&nbsp;
                <strong>Status:</strong> ${a.status==="approved"?"✅ FULL CONSENT":"⏳ AWAITING"}
              </p>
              ${a.proposal?`<p style="font-size:12px;color:#666;font-style:italic;">"${a.proposal.substring(0,180)}..."</p>`:""}
              <p style="font-size:13px;"><strong>Applicant:</strong> ${a.applicant.name} ${a.applicant.email!=="—"?`· <a href="mailto:${a.applicant.email}">${a.applicant.email}</a>`:""}</p>
              ${a.portalUrl?`<a href="${a.portalUrl}" style="display:inline-block;background:#000;color:#c8a96e;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:12px;font-weight:bold;margin-top:6px;">View Application →</a>`:""}
            </div>
          `).join("")}
        </div>
      </div>`;

    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method:  "POST",
      headers: { "Authorization":`Bearer ${SENDGRID_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: ALERT_EMAIL }] }],
        from:    { email: ALERT_EMAIL, name: "Pinnacle Planning Alerts" },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
    });
    console.log(`Alert sent for ${newApps.length} apps`);
  } catch(e) { console.error("Email failed:", e.message); }
}

// ─────────────────────────────────────────────
// HOURLY CHECK
// ─────────────────────────────────────────────
async function hourlyCheck() {
  console.log(`\nHourly check — ${new Date().toLocaleTimeString("en-GB")}`);
  const dateFrom = new Date(Date.now() - 48*3600000).toISOString().split("T")[0];
  const fresh    = await fetchAll(dateFrom);
  const newOnes  = fresh.filter(a => !seenIds.has(a.id));
  if (newOnes.length) {
    newOnes.forEach(a => seenIds.add(a.id));
    cache = [...newOnes, ...cache];
    await sendAlert(newOnes);
    console.log(`${newOnes.length} new applications alerted`);
  } else {
    console.log("No new applications");
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
    targetLPAs:   targetLpaIds.length,
    areas:        ["Manchester","Birmingham","Bristol","Cornwall"],
    minUnits:     MIN_UNITS,
    apiKey:       !!PLANNING_API_KEY,
    emailAlerts:  !!SENDGRID_KEY,
  });
});

// Debug — see all available LPAs
app.get("/api/lpas", (req, res) => {
  res.json({ count: lpaList.length, targetCount: targetLpaIds.length, targets: targetLpaIds });
});

// All applications
app.get("/api/applications", async (req, res) => {
  if (cache.length === 0 && !loading) {
    cache = await fetchAll("2024-01-01");
    cache.forEach(a => seenIds.add(a.id));
  }
  res.json({ success: true, count: cache.length, data: cache });
});

// Refresh
app.get("/api/refresh", async (req, res) => {
  console.log("Manual refresh triggered");
  cache = await fetchAll("2024-01-01");
  cache.forEach(a => seenIds.add(a.id));
  res.json({ success: true, count: cache.length, message: `Found ${cache.length} applications` });
});

// Check for new only
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
  console.log(`Planning Backend running on port ${PORT}`);
  console.log(`Areas: Manchester · Birmingham · Bristol · Cornwall`);
  console.log(`Min Units: ${MIN_UNITS}+\n`);

  // Load LPAs first, then fetch data
  await loadLPAs();

  cache = await fetchAll("2024-01-01");
  cache.forEach(a => seenIds.add(a.id));
  console.log(`\nReady — ${cache.length} applications loaded`);
});

// Run every hour
cron.schedule("0 * * * *", hourlyCheck);
