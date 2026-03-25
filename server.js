const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIG — PlanIt.org.uk, 100% FREE
// ─────────────────────────────────────────────
const PLANIT_BASE  = "https://www.planit.org.uk";
const ALERT_EMAIL  = process.env.ALERT_EMAIL  || "zack@pinnaclepropertybroker.com";
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const MIN_UNITS    = 30;

// ─────────────────────────────────────────────
// TARGET COUNCILS
// ─────────────────────────────────────────────
const COUNCILS = [
  { auth: "Manchester",            area: "Manchester" },
  { auth: "Salford",               area: "Manchester" },
  { auth: "Trafford",              area: "Manchester" },
  { auth: "Stockport",             area: "Manchester" },
  { auth: "Oldham",                area: "Manchester" },
  { auth: "Bolton",                area: "Manchester" },
  { auth: "Bury",                  area: "Manchester" },
  { auth: "Rochdale",              area: "Manchester" },
  { auth: "Tameside",              area: "Manchester" },
  { auth: "Wigan",                 area: "Manchester" },
  { auth: "Birmingham",            area: "Birmingham" },
  { auth: "Coventry",              area: "Birmingham" },
  { auth: "Dudley",                area: "Birmingham" },
  { auth: "Sandwell",              area: "Birmingham" },
  { auth: "Solihull",              area: "Birmingham" },
  { auth: "Walsall",               area: "Birmingham" },
  { auth: "Wolverhampton",         area: "Birmingham" },
  { auth: "Bristol",               area: "Bristol"    },
  { auth: "South Gloucestershire", area: "Bristol"    },
  { auth: "Bath",                  area: "Bristol"    },
  { auth: "North Somerset",        area: "Bristol"    },
  { auth: "Cornwall",              area: "Cornwall"   },
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
    /(erection|construction|development|provision)\s+of\s+(\d{2,4})\s*(no\.?\s*)?(residential|dwelling|apartment|flat|unit|home)/i,
    /(\d{2,4})\s*x\s*(dwelling|unit|apartment|flat|bed)/i,
    /comprising\s+(\d{2,4})\s*(residential|dwelling|apartment|flat|unit)/i,
    /total\s+of\s+(\d{2,4})\s*(residential|dwelling|apartment|flat|unit|home)/i,
    /(\d{2,4})\s*(?:no\.?\s*)?(?:new\s*)?(?:residential\s*)?(?:affordable\s*)?(?:dwelling|unit|apartment|flat|home)/i,
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

function mapStatus(appState, decision) {
  const combined = ((appState || "") + " " + (decision || "")).toLowerCase();
  if (combined.includes("approv") || combined.includes("grant") || combined.includes("permitted")) return "approved";
  if (combined.includes("refus"))    return "refused";
  if (combined.includes("withdraw")) return "withdrawn";
  return "awaiting";
}

function mapApp(raw, area) {
  const of    = raw.other_fields || {};
  const desc  = raw.description  || "";
  const units = extractUnits(desc);

  return {
    id:        raw.name || raw.uid || String(Math.random()),
    reference: raw.uid  || "—",
    address:   raw.address || "Address not available",
    proposal:  desc,
    units,
    status:    mapStatus(raw.app_state, of.decision || of.status),
    council:   raw.area_name || "—",
    area,
    appSize:   raw.app_size  || "—",
    appType:   raw.app_type  || "—",
    submitted: raw.start_date || of.date_received || "",
    decided:   raw.decided_date || of.decision_date || "",
    portalUrl: raw.url || raw.link || "",
    applicant: {
      name:    of.applicant_name    || of.applicant_company || "Not listed",
      company: of.applicant_company || "—",
      address: of.applicant_address || "—",
      email:   "—",
      phone:   "—",
    },
    agent: {
      name:    of.agent_name    || of.agent_company || "—",
      company: of.agent_company || "—",
      address: of.agent_address || "—",
      email:   "—",
      phone:   "—",
    },
  };
}

// ─────────────────────────────────────────────
// FETCH ONE COUNCIL — TWO PASSES
// Pass 1: app_size=Major (catches large schemes even without unit numbers)
// Pass 2: keyword search for unit numbers in description
// ─────────────────────────────────────────────
async function fetchCouncil(auth, area) {
  const results = [];
  const seen    = new Set();

  // ── PASS 1: Major residential applications ──
  try {
    const params = new URLSearchParams({
      auth:     auth,
      app_size: "Major",
      search:   "residential OR dwelling OR apartments OR flats OR housing OR homes",
      recent:   "365",
      pg_sz:    "300",
      compress: "on",
    });

    const r = await fetch(`${PLANIT_BASE}/api/applics/json?${params}`, {
      headers: { "User-Agent": "Pinnacle-Property-Broker/1.0" }
    });

    if (r.ok) {
      const d = await r.json();
      const records = d.records || [];
      console.log(`${auth} [Major]: ${records.length} applications`);

      for (const a of records) {
        if (!seen.has(a.name)) {
          seen.add(a.name);
          results.push(mapApp(a, area));
        }
      }
    }
  } catch(e) {
    console.error(`${auth} Pass 1 error:`, e.message);
  }

  await new Promise(r => setTimeout(r, 800));

  // ── PASS 2: Any size but with 30+ unit numbers in description ──
  try {
    const params = new URLSearchParams({
      auth:     auth,
      search:   "dwellings OR apartments OR flats OR \"residential units\"",
      recent:   "365",
      pg_sz:    "300",
      compress: "on",
    });

    const r = await fetch(`${PLANIT_BASE}/api/applics/json?${params}`, {
      headers: { "User-Agent": "Pinnacle-Property-Broker/1.0" }
    });

    if (r.ok) {
      const d = await r.json();
      const records = d.records || [];
      console.log(`${auth} [Keywords]: ${records.length} applications`);

      for (const a of records) {
        if (!seen.has(a.name)) {
          const units = extractUnits(a.description || "");
          if (units >= MIN_UNITS) {
            seen.add(a.name);
            results.push(mapApp(a, area));
          }
        }
      }
    }
  } catch(e) {
    console.error(`${auth} Pass 2 error:`, e.message);
  }

  console.log(`${auth}: ${results.length} qualifying applications`);
  return results;
}

// ─────────────────────────────────────────────
// FETCH ALL COUNCILS
// ─────────────────────────────────────────────
async function fetchAll() {
  loading = true;
  console.log("\nFetching all councils from PlanIt.org.uk...");
  const results = [];

  for (const c of COUNCILS) {
    const apps = await fetchCouncil(c.auth, c.area);
    results.push(...apps);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Global deduplicate
  const unique = [];
  const seen   = new Set();
  for (const a of results) {
    if (!seen.has(a.id)) { seen.add(a.id); unique.push(a); }
  }

  // Sort by submitted date, newest first
  unique.sort((a, b) => new Date(b.submitted || 0) - new Date(a.submitted || 0));

  loading     = false;
  lastUpdated = new Date().toISOString();
  console.log(`\nComplete — ${unique.length} total qualifying applications`);
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
          <p style="color:#888;margin:4px 0 0;font-size:12px;">Planning Alert · ${new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</p>
        </div>
        <div style="background:#fff;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee;">
          <h2 style="color:#111;font-size:16px;margin-top:0;">${newApps.length} New Application${newApps.length>1?"s":""}</h2>
          ${newApps.map(a=>`
            <div style="border:1px solid #ddd;border-left:4px solid ${a.status==="approved"?"#00c96e":"#ffab00"};border-radius:6px;padding:14px;margin-bottom:14px;">
              <h3 style="margin:0 0 4px;font-size:14px;">${a.address}</h3>
              <p style="margin:0 0 6px;font-size:12px;color:#888;">${a.council} · ${a.area} · Ref: ${a.reference}</p>
              <p style="margin:0 0 8px;font-size:13px;">
                <strong>Units:</strong> <span style="color:#c8a96e;font-weight:bold;">${a.units||"Major scheme"}</span> &nbsp;·&nbsp;
                <strong>Status:</strong> ${a.status==="approved"?"✅ FULL CONSENT":"⏳ AWAITING"}
              </p>
              ${a.proposal?`<p style="font-size:12px;color:#666;font-style:italic;margin-bottom:10px;">"${a.proposal.substring(0,200)}..."</p>`:""}
              <p style="font-size:13px;margin-bottom:6px;"><strong>Applicant:</strong> ${a.applicant.name}${a.applicant.company!=="—"?` · ${a.applicant.company}`:""}</p>
              ${a.agent.name!=="—"?`<p style="font-size:13px;margin-bottom:10px;"><strong>Agent:</strong> ${a.agent.name}</p>`:""}
              ${a.portalUrl?`<a href="${a.portalUrl}" style="display:inline-block;background:#000;color:#c8a96e;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:12px;font-weight:bold;">View Application →</a>`:""}
            </div>
          `).join("")}
          <p style="font-size:11px;color:#aaa;text-align:center;margin-top:20px;">Pinnacle Property Broker Ltd · Manchester · Birmingham · Bristol · Cornwall</p>
        </div>
      </div>`;

    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method:  "POST",
      headers: { "Authorization":`Bearer ${SENDGRID_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({
        personalizations: [{ to:[{ email:ALERT_EMAIL }] }],
        from:    { email:ALERT_EMAIL, name:"Pinnacle Planning Alerts" },
        subject,
        content: [{ type:"text/html", value:html }],
      }),
    });
    console.log(`Alert sent for ${newApps.length} applications`);
  } catch(e) { console.error("Email failed:", e.message); }
}

// ─────────────────────────────────────────────
// HOURLY CHECK
// ─────────────────────────────────────────────
async function hourlyCheck() {
  console.log(`\nHourly check — ${new Date().toLocaleTimeString("en-GB")}`);
  const fresh   = await fetchAll();
  const newOnes = fresh.filter(a => !seenIds.has(a.id));
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
    source:       "PlanIt.org.uk (free)",
    councils:     COUNCILS.length,
    areas:        ["Manchester","Birmingham","Bristol","Cornwall"],
    minUnits:     MIN_UNITS,
    emailAlerts:  !!SENDGRID_KEY,
  });
});

app.get("/api/applications", async (req, res) => {
  if (cache.length === 0 && !loading) {
    cache = await fetchAll();
    cache.forEach(a => seenIds.add(a.id));
  }
  res.json({ success:true, count:cache.length, data:cache });
});

app.get("/api/refresh", async (req, res) => {
  cache = await fetchAll();
  cache.forEach(a => seenIds.add(a.id));
  res.json({ success:true, count:cache.length, message:`Found ${cache.length} applications` });
});

app.get("/api/check-now", async (req, res) => {
  await hourlyCheck();
  res.json({ success:true, count:cache.length });
});

// Single council test
app.get("/api/test/:council", async (req, res) => {
  const apps = await fetchCouncil(req.params.council, "Test");
  res.json({ council:req.params.council, count:apps.length, data:apps.slice(0,5) });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n▲ PINNACLE PROPERTY BROKER`);
  console.log(`Backend on port ${PORT} — PlanIt.org.uk (FREE)`);
  console.log(`Areas: Manchester · Birmingham · Bristol · Cornwall\n`);
  cache = await fetchAll();
  cache.forEach(a => seenIds.add(a.id));
  console.log(`\nReady — ${cache.length} applications loaded`);
});

cron.schedule("0 * * * *", hourlyCheck);
