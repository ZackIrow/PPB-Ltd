const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.options("*", cors());
app.use(express.json());

const PLANIT_BASE  = "https://www.planit.org.uk";
const CH_BASE      = "https://api.company-information.service.gov.uk";
const CH_API_KEY   = process.env.COMPANIES_HOUSE_API_KEY;
const ALERT_EMAIL  = process.env.ALERT_EMAIL  || "zack@pinnaclepropertybroker.com";
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const MIN_UNITS    = 30;

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

let cache       = [];
let seenIds     = new Set();
let lastUpdated = null;
let loading     = false;
const chCache   = {};

// ── Companies House API ────────────────────────────────────
function chHeaders() {
  return {
    "Authorization": "Basic " + Buffer.from(CH_API_KEY + ":").toString("base64"),
  };
}

async function searchCompaniesHouse(companyName) {
  if (!CH_API_KEY || !companyName || companyName === "—" || companyName === "Not listed") return null;

  const key = companyName.toLowerCase().trim();
  if (chCache[key]) return chCache[key];

  try {
    // Search for company
    const sr = await fetch(
      `${CH_BASE}/search/companies?q=${encodeURIComponent(companyName)}&items_per_page=5`,
      { headers: chHeaders(), signal: AbortSignal.timeout(8000) }
    );
    if (!sr.ok) return null;
    const sd = await sr.json();
    const items = sd.items || [];
    if (!items.length) return null;

    // Prefer active companies, and prefer ones where name closely matches
    const nameLower = companyName.toLowerCase();
    const best = items.find(c => c.company_status === "active" && c.title.toLowerCase().includes(nameLower.split(" ")[0]))
      || items.find(c => c.company_status === "active")
      || items[0];

    const num = best.company_number;

    // Get officers (directors)
    const or = await fetch(
      `${CH_BASE}/company/${num}/officers?items_per_page=10`,
      { headers: chHeaders(), signal: AbortSignal.timeout(8000) }
    );

    let directors = [];
    if (or.ok) {
      const od = await or.json();
      directors = (od.items || [])
        .filter(o => o.officer_role === "director" && !o.resigned_on)
        .slice(0, 5)
        .map(o => {
          const a = o.address || {};
          return {
            name: o.name,
            role: "Director",
            address: [a.premises, a.address_line_1, a.locality, a.postal_code].filter(Boolean).join(", "),
          };
        });
    }

    // Get registered address from profile
    const pr = await fetch(
      `${CH_BASE}/company/${num}`,
      { headers: chHeaders(), signal: AbortSignal.timeout(8000) }
    );

    let registeredAddress = "—";
    if (pr.ok) {
      const pd = await pr.json();
      const a  = pd.registered_office_address || {};
      registeredAddress = [a.premises, a.address_line_1, a.address_line_2, a.locality, a.postal_code].filter(Boolean).join(", ") || "—";
    }

    const result = {
      companyName:       best.title,
      companyNumber:     num,
      companyStatus:     best.company_status,
      registeredAddress,
      directors,
      chUrl:             `https://find-and-update.company-information.service.gov.uk/company/${num}`,
      googleUrl:         `https://www.google.com/search?q="${encodeURIComponent(best.title)}" planning developers contact email`,
    };

    chCache[key] = result;
    console.log(`  CH: ${best.title} — ${directors.length} directors`);
    return result;

  } catch(e) {
    console.log(`  CH failed for "${companyName}": ${e.message}`);
    return null;
  }
}

async function enrichWithCH(applications) {
  if (!CH_API_KEY) { console.log("No CH API key — skipping"); return; }
  console.log(`\nEnriching ${applications.length} apps with Companies House...`);
  let done = 0;

  for (const app of applications) {
    if (app.chEnriched) continue;
    app.chEnriched = true;

    // Try agent company name first, then applicant
    const name =
      (app.agent.company !== "—"      ? app.agent.company      : null) ||
      (app.agent.name    !== "—"      ? app.agent.name         : null) ||
      (app.applicant.company !== "—"  ? app.applicant.company  : null) ||
      (app.applicant.name !== "Not listed" ? app.applicant.name : null);

    if (!name) continue;

    const ch = await searchCompaniesHouse(name);
    if (ch) {
      app.companiesHouse = ch;
      // If agent name is missing, use first director name
      if (app.agent.name === "—" && ch.directors.length > 0) {
        app.agent.name = ch.directors[0].name;
      }
      done++;
    }

    await new Promise(r => setTimeout(r, 250)); // polite rate limiting
  }

  console.log(`CH enrichment done: ${done}/${applications.length} enriched`);
}

// ── Helpers ────────────────────────────────────────────────
function extractUnits(text) {
  if (!text) return 0;
  const patterns = [
    /(\d{2,4})\s*(no\.?\s*)?(new\s*)?(dwelling|dwellings|unit|units|apartment|apartments|flat|flats|home|homes)/i,
    /(erection|construction|development|provision)\s+of\s+(\d{2,4})\s*(no\.?\s*)?(residential|dwelling|apartment|flat|unit|home)/i,
    /(\d{2,4})\s*x\s*(dwelling|unit|apartment|flat|bed)/i,
    /comprising\s+(\d{2,4})\s*(residential|dwelling|apartment|flat|unit)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) { const n = parseInt(m[1])||parseInt(m[2]); if (n && n>=MIN_UNITS && n<5000) return n; }
  }
  return 0;
}

function isResidential(t) {
  if (!t) return false;
  const l = t.toLowerCase();
  return l.includes("dwelling")||l.includes("residential")||l.includes("apartment")||l.includes("flat")||l.includes("housing")||l.includes("homes")||l.includes("affordable");
}

function mapStatus(s) {
  const l = (s||"").toLowerCase();
  if (l==="permitted"||l==="conditions") return "approved";
  if (l==="rejected")  return "refused";
  if (l==="withdrawn") return "withdrawn";
  return "awaiting";
}

function mapApp(raw, area) {
  const of    = raw.other_fields || {};
  const desc  = raw.description  || "";
  const units = of.n_dwellings   || extractUnits(desc) || 0;
  return {
    id:        raw.name || raw.uid || String(Math.random()),
    reference: raw.uid  || "—",
    address:   raw.address || "Address not available",
    proposal:  desc,
    units,
    status:    mapStatus(raw.app_state),
    council:   raw.area_name || "—",
    area,
    appSize:   raw.app_size  || "—",
    submitted: raw.start_date || of.date_received || "",
    decided:   raw.decided_date || of.decision_date || "",
    portalUrl: raw.url || raw.link || "",
    chEnriched:    false,
    companiesHouse: null,
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

// ── Fetch council ──────────────────────────────────────────
async function fetchCouncil(auth, area) {
  const results = []; const seen = new Set();
  try {
    const params = new URLSearchParams({ auth, app_size:"Large,Medium", recent:"365", pg_sz:"300", compress:"on" });
    const r = await fetch(`${PLANIT_BASE}/api/applics/json?${params}`, { headers:{"User-Agent":"Pinnacle-Property-Broker/1.0"} });
    if (!r.ok) return [];
    const d = await r.json();
    for (const a of (d.records||[])) {
      if (seen.has(a.name)) continue; seen.add(a.name);
      const of = a.other_fields||{}; const desc = a.description||"";
      const units = of.n_dwellings||extractUnits(desc)||0;
      if (units>=MIN_UNITS || (a.app_size==="Large" && isResidential(desc))) results.push(mapApp(a,area));
    }
    console.log(`${auth}: ${results.length} qualifying`);
    return results;
  } catch(e) { console.error(`Failed ${auth}:`, e.message); return []; }
}

// ── Fetch all ──────────────────────────────────────────────
async function fetchAll() {
  loading = true;
  console.log("\nFetching from PlanIt...");
  const results = [];
  for (const c of COUNCILS) {
    results.push(...await fetchCouncil(c.auth, c.area));
    await new Promise(r => setTimeout(r, 1200));
  }
  const unique = []; const seen = new Set();
  for (const a of results) { if (!seen.has(a.id)) { seen.add(a.id); unique.push(a); } }
  unique.sort((a,b) => new Date(b.submitted||0)-new Date(a.submitted||0));
  loading = false; lastUpdated = new Date().toISOString();
  console.log(`\nFetch complete — ${unique.length} applications`);
  // Enrich in background
  enrichWithCH(unique).catch(e => console.error("CH error:", e.message));
  return unique;
}

// ── Send alert ─────────────────────────────────────────────
async function sendAlert(newApps) {
  if (!SENDGRID_KEY || !newApps.length) return;
  try {
    const subject = newApps.length===1 ? `NEW SITE: ${newApps[0].address}` : `${newApps.length} New Planning Sites — Pinnacle Alert`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto">
      <div style="background:#1a1a2e;padding:20px;border-radius:8px 8px 0 0"><h1 style="color:#fff;margin:0;font-size:20px">PINNACLE PROPERTY BROKER</h1></div>
      <div style="background:#fff;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee">
        ${newApps.map(a=>`
          <div style="border:1px solid #e0e0e0;border-left:4px solid ${a.status==="approved"?"#059669":"#d97706"};border-radius:6px;padding:14px;margin-bottom:14px">
            <h3 style="margin:0 0 4px;font-size:14px;color:#1a1a2e">${a.address}</h3>
            <p style="margin:0 0 8px;font-size:12px;color:#888">${a.council} · ${a.units||"Major"} units · ${a.status==="approved"?"✅ FULL CONSENT":"⏳ AWAITING"}</p>
            ${a.companiesHouse?`
            <div style="background:#eff6ff;padding:12px;border-radius:6px;font-size:13px;margin-bottom:10px;border:1px solid #bfdbfe">
              <strong style="color:#1d4ed8">📋 Companies House: ${a.companiesHouse.companyName}</strong><br/>
              Address: ${a.companiesHouse.registeredAddress}<br/>
              ${a.companiesHouse.directors.length?`Directors: ${a.companiesHouse.directors.map(d=>d.name).join(", ")}<br/>`:""}
              <a href="${a.companiesHouse.chUrl}">View on Companies House →</a> &nbsp;|&nbsp;
              <a href="${a.companiesHouse.googleUrl}">Find email on Google →</a>
            </div>`:`<p style="font-size:13px">Agent: ${a.agent.name} ${a.agent.company!=="—"?`(${a.agent.company})`:""}</p>`}
            ${a.portalUrl?`<a href="${a.portalUrl}" style="background:#1a1a2e;color:#fff;padding:8px 14px;border-radius:5px;text-decoration:none;font-size:12px;font-weight:bold">View Application →</a>`:""}
          </div>`).join("")}
      </div></div>`;
    await fetch("https://api.sendgrid.com/v3/mail/send",{
      method:"POST", headers:{"Authorization":`Bearer ${SENDGRID_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({ personalizations:[{to:[{email:ALERT_EMAIL}]}], from:{email:ALERT_EMAIL,name:"Pinnacle Alerts"}, subject, content:[{type:"text/html",value:html}] })
    });
  } catch(e) { console.error("Email failed:", e.message); }
}

// ── Hourly check ───────────────────────────────────────────
async function hourlyCheck() {
  const fresh = await fetchAll();
  const newOnes = fresh.filter(a => !seenIds.has(a.id));
  if (newOnes.length) { newOnes.forEach(a=>seenIds.add(a.id)); cache=[...newOnes,...cache]; await sendAlert(newOnes); }
}

// ── Routes ─────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status:"ok", applications:cache.length, lastUpdated, loading,
  source:"PlanIt + Companies House", councils:COUNCILS.length,
  areas:["Manchester","Birmingham","Bristol","Cornwall"], minUnits:MIN_UNITS,
  chApiKey:!!CH_API_KEY, emailAlerts:!!SENDGRID_KEY,
  companiesHouseEnriched: cache.filter(a=>a.companiesHouse).length,
}));

app.get("/api/applications", async (req, res) => {
  if (cache.length===0 && !loading) { cache=await fetchAll(); cache.forEach(a=>seenIds.add(a.id)); }
  res.json({ success:true, count:cache.length, data:cache });
});

app.get("/api/refresh", async (req, res) => {
  cache=await fetchAll(); cache.forEach(a=>seenIds.add(a.id));
  res.json({ success:true, count:cache.length });
});

app.get("/api/enrich", async (req, res) => {
  res.json({ success:true, message:"CH enrichment started in background" });
  enrichWithCH(cache).catch(console.error);
});

// Test CH lookup directly — e.g. /api/ch-lookup?name=Serviam+Planning
app.get("/api/ch-lookup", async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error:"Pass ?name=Company+Name" });
  const result = await searchCompaniesHouse(name);
  res.json({ name, result });
});

app.get("/api/test/:council", async (req, res) => {
  const params = new URLSearchParams({ auth:req.params.council, app_size:"Large,Medium", recent:"90", pg_sz:"3", compress:"on" });
  const r = await fetch(`${PLANIT_BASE}/api/applics/json?${params}`, { headers:{"User-Agent":"Pinnacle-Property-Broker/1.0"} });
  const d = await r.json();
  res.json({ council:req.params.council, total:d.total, sample:(d.records||[]).slice(0,3).map(a=>({ address:a.address, description:(a.description||"").substring(0,80), agent:a.other_fields?.agent_company||a.other_fields?.agent_name, applicant:a.other_fields?.applicant_company||a.other_fields?.applicant_name, n_dwellings:a.other_fields?.n_dwellings })) });
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n▲ PINNACLE PROPERTY BROKER`);
  console.log(`Companies House API: ${CH_API_KEY?"✓ Connected":"✗ No key — add COMPANIES_HOUSE_API_KEY to Railway"}`);
  console.log(`Areas: Manchester · Birmingham · Bristol · Cornwall\n`);
  cache = await fetchAll();
  cache.forEach(a => seenIds.add(a.id));
  console.log(`\nReady — ${cache.length} applications loaded`);
});

cron.schedule("0 * * * *", hourlyCheck);
