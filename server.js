const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.options("*", cors());
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIG
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
// PDF CONTACT EXTRACTION
// Fetches planning portal docs page, finds application form PDF,
// extracts text and parses out applicant/agent contact details
// ─────────────────────────────────────────────
async function extractContactFromDocs(portalUrl, docsUrl) {
  try {
    // Try docs URL first, fall back to portal URL
    const targetUrl = docsUrl || portalUrl;
    if (!targetUrl) return null;

    // Fetch the documents page from the council portal
    const pageRes = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PinnaclePropertyBroker/1.0)",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    // Find PDF links — look for application form documents
    const pdfMatches = [...html.matchAll(/href="([^"]*\.pdf[^"]*)"/gi)];
    const appFormKeywords = [
      "application", "form", "app1", "applic", "1app", "planning-app",
      "planning_app", "pa1", "planning-form", "applicationform"
    ];

    // Score each PDF by how likely it is to be the application form
    const scoredPdfs = pdfMatches.map(m => {
      let url = m[1];
      if (!url.startsWith("http")) {
        try {
          url = new URL(url, targetUrl).href;
        } catch { return null; }
      }
      const urlLower = url.toLowerCase();
      const score = appFormKeywords.reduce((s, k) => urlLower.includes(k) ? s + 1 : s, 0);
      return { url, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);

    if (!scoredPdfs.length) return null;

    // Try top 3 most likely PDFs
    for (const pdfInfo of scoredPdfs.slice(0, 3)) {
      const contact = await extractFromPDF(pdfInfo.url);
      if (contact && (contact.email || contact.phone || contact.applicantName)) {
        return contact;
      }
    }

    return null;
  } catch(e) {
    console.log(`Doc extraction failed: ${e.message}`);
    return null;
  }
}

async function extractFromPDF(pdfUrl) {
  const tmpFile = path.join(os.tmpdir(), `plan_${Date.now()}.pdf`);
  try {
    // Download PDF
    const res = await fetch(pdfUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PinnaclePropertyBroker/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 10 * 1024 * 1024) return null; // Skip files > 10MB

    fs.writeFileSync(tmpFile, Buffer.from(buffer));

    // Extract text using pdftotext (installed on Railway with poppler-utils)
    let text = "";
    try {
      text = execSync(`pdftotext -f 1 -l 3 "${tmpFile}" -`, {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      }).toString();
    } catch(e) {
      // pdftotext not available or failed
      return null;
    }

    if (!text || text.length < 50) return null;

    return parseContactFromText(text);

  } catch(e) {
    return null;
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
  }
}

function parseContactFromText(text) {
  const contact = {
    applicantName:  null,
    applicantEmail: null,
    applicantPhone: null,
    agentName:      null,
    agentCompany:   null,
    agentEmail:     null,
    agentPhone:     null,
  };

  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  // ── Email extraction (most reliable) ──
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const emails = text.match(emailRegex) || [];
  // Filter out generic/system emails
  const realEmails = emails.filter(e =>
    !e.includes("planning@") &&
    !e.includes("@gov.uk") &&
    !e.includes("@councillor") &&
    !e.includes("noreply") &&
    !e.includes("donotreply")
  );
  if (realEmails.length > 0) contact.agentEmail = realEmails[0];
  if (realEmails.length > 1) contact.applicantEmail = realEmails[1];

  // ── Phone extraction ──
  const phoneRegex = /(\+44|0)[\s\-]?[0-9]{2,4}[\s\-]?[0-9]{3,4}[\s\-]?[0-9]{3,4}/g;
  const phones = text.match(phoneRegex) || [];
  if (phones.length > 0) contact.agentPhone = phones[0].replace(/\s+/g, " ").trim();
  if (phones.length > 1) contact.applicantPhone = phones[1].replace(/\s+/g, " ").trim();

  // ── Name extraction — look for standard form field patterns ──
  const namePatterns = [
    // "Applicant Name: John Smith" style
    /applicant['\s]*s?[\s]*name[\s:]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
    /name\s+of\s+applicant[\s:]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
    /1\.\s*applicant[\s:]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
    // Company names
    /applicant[\s:]+([A-Z][A-Za-z\s&]+(?:Ltd|Limited|PLC|LLP|LLC|Group|Homes|Developments?|Properties|Estates?|Investments?))/i,
  ];

  for (const pattern of namePatterns) {
    const m = text.match(pattern);
    if (m && m[1]) { contact.applicantName = m[1].trim(); break; }
  }

  // ── Agent name and company ──
  const agentPatterns = [
    /agent[\s']*s?\s*name[\s:]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
    /name\s+of\s+agent[\s:]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
    /agent[\s:]+([A-Z][A-Za-z\s&]+(?:Ltd|Limited|PLC|LLP|Planning|Architects?|Consultants?|Associates?))/i,
    /agent\s+company[\s:]+([A-Z][A-Za-z\s&]+(?:Ltd|Limited|PLC|LLP|Planning|Architects?))/i,
  ];

  for (const pattern of agentPatterns) {
    const m = text.match(pattern);
    if (m && m[1]) { contact.agentName = m[1].trim(); break; }
  }

  // ── Look for company names near "agent" or "applicant" sections ──
  const companyPatterns = [
    /([A-Z][A-Za-z\s&]+(?:Ltd|Limited|PLC|LLP|Homes|Developments?|Properties|Planning|Architects?))/g,
  ];
  const companies = [];
  for (const p of companyPatterns) {
    const matches = [...text.matchAll(p)];
    matches.forEach(m => { if(m[1] && m[1].length > 5) companies.push(m[1].trim()); });
  }
  if (companies.length > 0 && !contact.agentName) contact.agentCompany = companies[0];
  if (companies.length > 1 && !contact.applicantName) contact.applicantName = companies[1];

  // Return null if we found nothing useful
  if (!contact.applicantName && !contact.agentName && !contact.agentEmail && !contact.applicantEmail && !contact.agentPhone) {
    return null;
  }

  return contact;
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function extractUnits(text) {
  if (!text) return 0;
  const patterns = [
    /(\d{2,4})\s*(no\.?\s*)?(new\s*)?(dwelling|dwellings|unit|units|apartment|apartments|flat|flats|home|homes)/i,
    /(erection|construction|development|provision)\s+of\s+(\d{2,4})\s*(no\.?\s*)?(residential|dwelling|apartment|flat|unit|home)/i,
    /(\d{2,4})\s*x\s*(dwelling|unit|apartment|flat|bed)/i,
    /comprising\s+(\d{2,4})\s*(residential|dwelling|apartment|flat|unit)/i,
    /total\s+of\s+(\d{2,4})\s*(residential|dwelling|apartment|flat|unit|home)/i,
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

function mapStatus(appState) {
  const s = (appState || "").toLowerCase();
  if (s === "permitted" || s === "conditions") return "approved";
  if (s === "rejected")  return "refused";
  if (s === "withdrawn") return "withdrawn";
  return "awaiting";
}

function mapApp(raw, area) {
  const of    = raw.other_fields || {};
  const desc  = raw.description  || "";
  const units = of.n_dwellings   || extractUnits(desc) || 0;

  // Build docs URL from portal URL
  const docsUrl = of.docs_url || null;

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
    appType:   raw.app_type  || "—",
    submitted: raw.start_date || of.date_received || "",
    decided:   raw.decided_date || of.decision_date || "",
    portalUrl: raw.url || raw.link || "",
    docsUrl,
    contactScraped: false,
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
// ENRICH APPLICATION WITH PDF CONTACTS
// Run after initial fetch to add email/phone
// ─────────────────────────────────────────────
async function enrichWithContacts(applications) {
  console.log(`\nEnriching ${applications.length} applications with PDF contact data...`);
  let enriched = 0;

  for (const app of applications) {
    if (app.contactScraped) continue;
    try {
      const contact = await extractContactFromDocs(app.portalUrl, app.docsUrl);
      app.contactScraped = true;

      if (contact) {
        // Merge contact data — prefer scraped data over PlanIt data
        if (contact.applicantEmail) app.applicant.email = contact.applicantEmail;
        if (contact.applicantPhone) app.applicant.phone = contact.applicantPhone;
        if (contact.applicantName && app.applicant.name === "Not listed") app.applicant.name = contact.applicantName;
        if (contact.agentEmail)     app.agent.email = contact.agentEmail;
        if (contact.agentPhone)     app.agent.phone = contact.agentPhone;
        if (contact.agentName && app.agent.name === "—") app.agent.name = contact.agentName;
        if (contact.agentCompany && app.agent.company === "—") app.agent.company = contact.agentCompany;

        enriched++;
        console.log(`  ✓ ${app.address.split(",")[0]} — found: ${contact.agentEmail || contact.applicantEmail || contact.agentPhone || "name only"}`);
      }

      // Rate limit — be respectful to council servers
      await new Promise(r => setTimeout(r, 1500));
    } catch(e) {
      console.log(`  ✗ ${app.address.split(",")[0]}: ${e.message}`);
    }
  }

  console.log(`Contact enrichment complete: ${enriched}/${applications.length} enriched`);
  return applications;
}

// ─────────────────────────────────────────────
// FETCH ONE COUNCIL
// ─────────────────────────────────────────────
async function fetchCouncil(auth, area) {
  const results = [];
  const seen    = new Set();

  try {
    const params = new URLSearchParams({
      auth:     auth,
      app_size: "Large,Medium",
      recent:   "365",
      pg_sz:    "300",
      compress: "on",
    });

    const r = await fetch(`${PLANIT_BASE}/api/applics/json?${params}`, {
      headers: { "User-Agent": "Pinnacle-Property-Broker/1.0" }
    });

    if (!r.ok) return [];

    const d       = await r.json();
    const records = d.records || [];
    console.log(`${auth}: ${records.length} Large/Medium applications`);

    for (const a of records) {
      if (seen.has(a.name)) continue;
      seen.add(a.name);

      const of   = a.other_fields || {};
      const desc = a.description  || "";
      const units = of.n_dwellings || extractUnits(desc) || 0;
      const isLarge = a.app_size === "Large";
      const hasUnits = units >= MIN_UNITS;
      const residential = isResidential(desc);

      if (hasUnits || (isLarge && residential)) {
        results.push(mapApp(a, area));
      }
    }

    console.log(`${auth}: ${results.length} qualifying applications`);
    return results;

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
  console.log("\nFetching all councils from PlanIt.org.uk...");
  const results = [];

  for (const c of COUNCILS) {
    const apps = await fetchCouncil(c.auth, c.area);
    results.push(...apps);
    await new Promise(r => setTimeout(r, 1200));
  }

  // Deduplicate
  const unique = [];
  const seen   = new Set();
  for (const a of results) {
    if (!seen.has(a.id)) { seen.add(a.id); unique.push(a); }
  }

  unique.sort((a, b) => new Date(b.submitted || 0) - new Date(a.submitted || 0));

  loading     = false;
  lastUpdated = new Date().toISOString();
  console.log(`\nFetch complete — ${unique.length} applications`);

  // Enrich with PDF contact data in background (don't block the response)
  enrichWithContacts(unique).catch(e => console.error("Enrichment error:", e.message));

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
        <div style="background:#1a1a2e;padding:20px;border-radius:8px 8px 0 0;">
          <h1 style="color:#fff;margin:0;font-size:20px;">PINNACLE PROPERTY BROKER</h1>
          <p style="color:rgba(255,255,255,0.5);margin:4px 0 0;font-size:12px;">Planning Alert · ${new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</p>
        </div>
        <div style="background:#fff;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee;">
          <h2 style="color:#1a1a2e;font-size:16px;margin-top:0;">${newApps.length} New Application${newApps.length>1?"s":""}</h2>
          ${newApps.map(a=>`
            <div style="border:1px solid #e0e0e0;border-left:4px solid ${a.status==="approved"?"#059669":"#d97706"};border-radius:6px;padding:14px;margin-bottom:14px;">
              <h3 style="margin:0 0 4px;font-size:14px;color:#1a1a2e">${a.address}</h3>
              <p style="margin:0 0 8px;font-size:12px;color:#888">${a.council} · Ref: ${a.reference}</p>
              <p style="margin:0 0 8px;font-size:13px"><strong>Units:</strong> <span style="color:#1a1a2e;font-weight:800">${a.units||"Major"}</span> &nbsp;·&nbsp; <strong>Status:</strong> ${a.status==="approved"?"✅ FULL CONSENT":"⏳ AWAITING"}</p>
              ${a.proposal?`<p style="font-size:12px;color:#888;font-style:italic;margin-bottom:10px">"${a.proposal.substring(0,180)}..."</p>`:""}
              <div style="background:#f9f9f9;padding:10px;border-radius:5px;margin-bottom:10px;font-size:13px">
                <strong>Applicant:</strong> ${a.applicant.name}<br/>
                ${a.applicant.email!=="—"?`📧 <a href="mailto:${a.applicant.email}">${a.applicant.email}</a><br/>`:""}
                ${a.applicant.phone!=="—"?`📞 ${a.applicant.phone}`:""}
              </div>
              ${a.agent.name!=="—"?`<div style="background:#f9f9f9;padding:10px;border-radius:5px;margin-bottom:10px;font-size:13px">
                <strong>Agent:</strong> ${a.agent.name}<br/>
                ${a.agent.email!=="—"?`📧 <a href="mailto:${a.agent.email}">${a.agent.email}</a><br/>`:""}
                ${a.agent.phone!=="—"?`📞 ${a.agent.phone}`:""}
              </div>`:""}
              ${a.portalUrl?`<a href="${a.portalUrl}" style="display:inline-block;background:#1a1a2e;color:#fff;padding:8px 14px;border-radius:5px;text-decoration:none;font-size:12px;font-weight:bold">View Application →</a>`:""}
            </div>`).join("")}
        </div>
      </div>`;

    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method:  "POST",
      headers: { "Authorization":`Bearer ${SENDGRID_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({
        personalizations: [{ to:[{ email:ALERT_EMAIL }] }],
        from: { email:ALERT_EMAIL, name:"Pinnacle Planning Alerts" },
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
    source:       "PlanIt.org.uk (free) + PDF contact extraction",
    councils:     COUNCILS.length,
    areas:        ["Manchester","Birmingham","Bristol","Cornwall"],
    minUnits:     MIN_UNITS,
    emailAlerts:  !!SENDGRID_KEY,
    contactsFound: cache.filter(a => a.applicant.email !== "—" || a.agent.email !== "—").length,
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

// Manually enrich contacts for cached applications
app.get("/api/enrich", async (req, res) => {
  res.json({ success:true, message:"Enrichment started in background", count:cache.length });
  enrichWithContacts(cache).catch(console.error);
});

// Test PDF extraction on a single URL
app.get("/api/test-pdf", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Pass ?url=... parameter" });
  const contact = await extractContactFromDocs(url, null);
  res.json({ url, contact });
});

app.get("/api/test/:council", async (req, res) => {
  const params = new URLSearchParams({
    auth:     req.params.council,
    app_size: "Large,Medium",
    recent:   "365",
    pg_sz:    "3",
    compress: "on",
  });
  const r = await fetch(`${PLANIT_BASE}/api/applics/json?${params}`, {
    headers: { "User-Agent": "Pinnacle-Property-Broker/1.0" }
  });
  const d = await r.json();
  res.json({
    council: req.params.council,
    total:   d.total,
    sample:  (d.records||[]).slice(0,3).map(a=>({
      address:     a.address,
      description: a.description?.substring(0,80),
      app_size:    a.app_size,
      app_state:   a.app_state,
      n_dwellings: a.other_fields?.n_dwellings,
      docs_url:    a.other_fields?.docs_url,
      url:         a.url,
    }))
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n▲ PINNACLE PROPERTY BROKER`);
  console.log(`Backend on port ${PORT}`);
  console.log(`Source: PlanIt.org.uk + PDF contact extraction`);
  console.log(`Areas: Manchester · Birmingham · Bristol · Cornwall\n`);

  cache = await fetchAll();
  cache.forEach(a => seenIds.add(a.id));
  console.log(`\nReady — ${cache.length} applications loaded`);
});

cron.schedule("0 * * * *", hourlyCheck);
