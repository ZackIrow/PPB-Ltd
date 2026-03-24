// ============================================================
// PINNACLE PROPERTY BROKER — Planning Alert Backend
// ============================================================
// Deploy this to Railway.app (free)
// Set environment variables:
//   SEARCHLAND_API_KEY = your key from app.searchland.co.uk
//   SENDGRID_API_KEY   = your key from sendgrid.com (free)
//   ALERT_EMAIL        = jake@pinnaclepropertybroker.co.uk
//   FROM_EMAIL         = alerts@pinnaclepropertybroker.co.uk
// ============================================================

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const sgMail = require('@sendgrid/mail');

const app = express();
app.use(cors());
app.use(express.json());

// ── Config ────────────────────────────────────────────────
const SEARCHLAND_API_KEY = process.env.SEARCHLAND_API_KEY;
const SEARCHLAND_BASE    = 'https://api.searchland.co.uk/v1';
const ALERT_EMAIL        = process.env.ALERT_EMAIL  || 'jake@pinnaclepropertybroker.co.uk';
const FROM_EMAIL         = process.env.FROM_EMAIL   || 'alerts@pinnaclepropertybroker.co.uk';
const MIN_UNITS          = 30;

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ── Target regions (your 7 areas mapped to Searchland region slugs)
const TARGET_REGIONS = [
  'north-west',      // Manchester
  'south-west',      // Cornwall, Devon, Bristol
  'east-midlands',   // Leicester, Derby
  'west-midlands',   // Birmingham
];

// ── LPA codes for your specific cities (more precise targeting)
// These are the official ONS LPA codes Searchland uses
const TARGET_LPA_CODES = [
  // Manchester & surrounds
  'E08000003', // Manchester
  'E08000004', // Oldham
  'E08000006', // Salford
  'E08000007', // Stockport
  'E08000008', // Tameside
  'E08000009', // Trafford
  'E08000010', // Wigan
  'E08000001', // Bolton
  'E08000002', // Bury
  'E08000005', // Rochdale
  // Cornwall
  'E06000052', // Cornwall
  // Devon
  'E10000008', // Devon County
  'E06000020', // Torbay
  'E06000027', // Plymouth
  // Leicester
  'E06000016', // Leicester City
  'E10000018', // Leicestershire
  // Derby
  'E06000015', // Derby City
  'E10000007', // Derbyshire
  // Birmingham & surrounds
  'E08000025', // Birmingham
  'E08000026', // Coventry
  'E08000027', // Dudley
  'E08000028', // Sandwell
  'E08000029', // Solihull
  'E08000030', // Walsall
  'E08000031', // Wolverhampton
  // Bristol & surrounds
  'E06000023', // Bristol
  'E06000022', // Bath & NE Somerset
  'E06000025', // South Gloucestershire
  'E07000245', // South Somerset
];

// ── In-memory store of seen application IDs (prevents duplicate alerts)
// In production swap this for a simple DB table
const seenApplicationIds = new Set();
let lastCheckTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // start: 24h ago

// ── Helper: call Searchland API ───────────────────────────
async function searchlandPost(endpoint, body) {
  const response = await fetch(`${SEARCHLAND_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': SEARCHLAND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Searchland API error ${response.status}: ${err}`);
  }

  return response.json();
}

// ── Fetch all 30+ unit residential applications for target areas
async function fetchApplications({ dateFrom, page = 0 } = {}) {
  const lpaCodes = TARGET_LPA_CODES.join(',');
  const dateFilter = dateFrom
    ? ` AND calculatedDateReceived >= '${dateFrom}'`
    : '';

  const body = {
    perPage: 100,
    page,
    return_full_meta_data: true,
    whereQuery: `noDwellings >= ${MIN_UNITS}${dateFilter}`,
    search_proposals: 'residential dwellings apartments flats homes',
  };

  // Searchland supports lpaCodes as a query param on the OGC endpoint
  // For the search endpoint we filter post-fetch by lpaCode field
  const result = await searchlandPost('/planning_applications/search', body);

  // Filter to only our target LPA codes
  const filtered = (result.data || []).filter(a =>
    TARGET_LPA_CODES.includes(a.lpaCode)
  );

  return {
    total: result.count || 0,
    applications: filtered,
    cost: result.cost || 0,
  };
}

// ── Map Searchland data → dashboard format ────────────────
function mapApplication(a) {
  const applicant = a.applicantDetails?.[0] || {};
  const agent     = a.agentDetails?.[0] || {};

  return {
    id:             a.reference || a.id,
    searchlandId:   a.id,
    address:        a.address || 'Address not available',
    units:          a.noDwellings || 0,
    status:         mapStatus(a.calculatedDecision, a.status),
    council:        a.lpaName || 'Unknown Council',
    lpaCode:        a.lpaCode,
    type:           'Residential',
    proposal:       a.proposal || '',
    submitted:      a.calculatedDateReceived || '',
    lastUpdate:     a.updatedAt || '',
    decisionDate:   a.decisionIssuedDate || '',
    isMajor:        a.isMajorDevelopment || false,
    portalUrl:      a.url || '',
    applicant: {
      name:    applicant.companyName || applicant.name || 'Not listed',
      contact: applicant.name || '—',
      email:   applicant.email || '—',
      phone:   applicant.phone || '—',
      address: applicant.address || '—',
    },
    agent: {
      name:    agent.companyName || agent.name || 'Not listed',
      contact: agent.name || '—',
      email:   agent.email || '—',
      phone:   agent.phone || '—',
    },
  };
}

function mapStatus(decision, raw) {
  if (!decision && !raw) return 'awaiting';
  const d = (decision || '').toLowerCase();
  const r = (raw || '').toLowerCase();
  if (d.includes('approv') || r.includes('approv')) return 'approved';
  if (d.includes('refus') || r.includes('refus'))   return 'refused';
  if (d.includes('withdrawn'))                        return 'withdrawn';
  return 'awaiting';
}

// ── Send alert email via SendGrid ─────────────────────────
async function sendAlertEmail(newApplications) {
  if (!newApplications.length) return;

  const appList = newApplications.map(app => {
    const applicantInfo = app.applicant.email !== '—'
      ? `📧 ${app.applicant.email}`
      : app.agent.email !== '—'
        ? `📧 Agent: ${app.agent.email}`
        : 'No contact email listed';

    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 ${app.address}
🏗️  ${app.units} units | ${app.council}
📋 Ref: ${app.id}
🔔 Status: ${app.status === 'approved' ? '✅ FULL CONSENT GRANTED' : '⏳ AWAITING DECISION'}
👤 Applicant: ${app.applicant.name}
   Contact: ${app.applicant.contact}
   ${applicantInfo}
🏢 Agent: ${app.agent.name} ${app.agent.phone !== '—' ? `| ${app.agent.phone}` : ''}
🔗 Portal: ${app.portalUrl || 'Not available'}
    `.trim();
  }).join('\n\n');

  const subject = newApplications.length === 1
    ? `🔔 New 30+ Unit Site: ${newApplications[0].address}`
    : `🔔 ${newApplications.length} New Planning Applications — Pinnacle Alert`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; background: #f5f5f5; padding: 20px;">
      <div style="background: #000; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="color: #c8a96e; margin: 0; font-size: 22px;">▲ PINNACLE PROPERTY BROKER</h1>
        <p style="color: #666; margin: 5px 0 0 0; font-size: 13px;">Planning Intelligence Alert</p>
      </div>
      <div style="background: #fff; padding: 24px; border-radius: 0 0 8px 8px;">
        <h2 style="color: #111; font-size: 18px; margin-top: 0;">
          ${newApplications.length} New Application${newApplications.length > 1 ? 's' : ''} — ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
        </h2>
        ${newApplications.map(app => `
          <div style="border: 1px solid #e0e0e0; border-left: 4px solid ${app.status === 'approved' ? '#00d26e' : '#ffab00'}; border-radius: 6px; padding: 16px; margin-bottom: 16px; background: #fafafa;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
              <div>
                <h3 style="margin: 0 0 4px 0; color: #111; font-size: 15px;">${app.address}</h3>
                <span style="font-size: 12px; color: #888;">${app.council} · Ref: ${app.id}</span>
              </div>
              <span style="background: ${app.status === 'approved' ? '#e6f9f0' : '#fff8e6'}; color: ${app.status === 'approved' ? '#00a854' : '#d48000'}; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: bold; white-space: nowrap; margin-left: 12px;">
                ${app.status === 'approved' ? '✅ FULL CONSENT' : '⏳ AWAITING'}
              </span>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 13px; margin-bottom: 12px;">
              <div><strong>Units:</strong> <span style="color: #c8a96e; font-weight: bold; font-size: 16px;">${app.units}</span></div>
              <div><strong>Type:</strong> ${app.type}</div>
              <div><strong>Submitted:</strong> ${app.submitted ? new Date(app.submitted).toLocaleDateString('en-GB') : '—'}</div>
              <div><strong>Major Dev:</strong> ${app.isMajor ? 'Yes' : 'No'}</div>
            </div>
            <div style="background: #f0f0f0; padding: 12px; border-radius: 5px; margin-bottom: 12px;">
              <strong style="font-size: 12px; color: #555; text-transform: uppercase; letter-spacing: 0.05em;">Applicant</strong>
              <div style="margin-top: 6px; font-size: 13px;">
                <div><strong>${app.applicant.name}</strong></div>
                ${app.applicant.contact !== '—' ? `<div>Contact: ${app.applicant.contact}</div>` : ''}
                ${app.applicant.email !== '—' ? `<div>📧 <a href="mailto:${app.applicant.email}" style="color: #1a73e8;">${app.applicant.email}</a></div>` : ''}
                ${app.applicant.phone !== '—' ? `<div>📞 ${app.applicant.phone}</div>` : ''}
              </div>
            </div>
            ${(app.agent.name !== 'Not listed') ? `
            <div style="background: #f0f0f0; padding: 12px; border-radius: 5px; margin-bottom: 12px;">
              <strong style="font-size: 12px; color: #555; text-transform: uppercase; letter-spacing: 0.05em;">Planning Agent</strong>
              <div style="margin-top: 6px; font-size: 13px;">
                <div><strong>${app.agent.name}</strong></div>
                ${app.agent.contact !== '—' ? `<div>Contact: ${app.agent.contact}</div>` : ''}
                ${app.agent.email !== '—' ? `<div>📧 <a href="mailto:${app.agent.email}" style="color: #1a73e8;">${app.agent.email}</a></div>` : ''}
                ${app.agent.phone !== '—' ? `<div>📞 ${app.agent.phone}</div>` : ''}
              </div>
            </div>` : ''}
            ${app.proposal ? `<div style="font-size: 12px; color: #666; font-style: italic; margin-bottom: 10px;">"${app.proposal.substring(0, 200)}${app.proposal.length > 200 ? '...' : ''}"</div>` : ''}
            ${app.portalUrl ? `<a href="${app.portalUrl}" style="display: inline-block; background: #000; color: #c8a96e; padding: 8px 16px; border-radius: 5px; text-decoration: none; font-size: 13px; font-weight: bold;">View on Council Portal →</a>` : ''}
          </div>
        `).join('')}
        <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #e0e0e0; font-size: 12px; color: #999; text-align: center;">
          Pinnacle Property Broker Ltd · Planning Intelligence Platform<br>
          You're receiving this because you set up alerts for 30+ unit residential applications in your target areas.
        </div>
      </div>
    </div>
  `;

  await sgMail.send({
    to: ALERT_EMAIL,
    from: FROM_EMAIL,
    subject,
    text: `Pinnacle Planning Alert\n\n${appList}`,
    html,
  });

  console.log(`✅ Alert email sent for ${newApplications.length} applications`);
}

// ── Check for new applications (runs on cron) ─────────────
async function checkForNewApplications() {
  console.log(`🔍 Checking for new applications since ${lastCheckTime}...`);
  try {
    const dateFrom = lastCheckTime.split('T')[0];
    const { applications } = await fetchApplications({ dateFrom });

    const newApps = applications
      .map(mapApplication)
      .filter(app => !seenApplicationIds.has(app.searchlandId || app.id));

    if (newApps.length > 0) {
      console.log(`🚨 Found ${newApps.length} new applications!`);
      newApps.forEach(app => seenApplicationIds.add(app.searchlandId || app.id));
      await sendAlertEmail(newApps);
    } else {
      console.log('✓ No new applications found.');
    }

    lastCheckTime = new Date().toISOString();
  } catch (err) {
    console.error('❌ Error checking applications:', err.message);
  }
}

// ── API Routes ────────────────────────────────────────────

// GET all current applications (used by dashboard)
app.get('/api/applications', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 0;
    const dateFrom = req.query.dateFrom || '2025-01-01';
    const { applications, total, cost } = await fetchApplications({ dateFrom, page });
    const mapped = applications.map(mapApplication);
    res.json({ success: true, count: mapped.length, total, cost, data: mapped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET single application detail
app.get('/api/applications/:id', async (req, res) => {
  try {
    const response = await fetch(
      `${SEARCHLAND_BASE}/planning_applications/get?_id=${req.params.id}`,
      { headers: { 'Authorization': SEARCHLAND_API_KEY } }
    );
    const data = await response.json();
    res.json({ success: true, data: mapApplication(data.data) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET credit usage
app.get('/api/credits', async (req, res) => {
  try {
    const response = await fetch(
      `${SEARCHLAND_BASE}/api_usage_product/get?product=planning_api`,
      { headers: { 'Authorization': SEARCHLAND_API_KEY } }
    );
    const data = await response.json();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST manually trigger a check (for testing)
app.post('/api/check-now', async (req, res) => {
  await checkForNewApplications();
  res.json({ success: true, message: 'Check complete' });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    lastCheck: lastCheckTime,
    seenCount: seenApplicationIds.size,
    targetAreas: ['Manchester', 'Cornwall', 'Devon', 'Leicester', 'Derby', 'Birmingham', 'Bristol'],
    minUnits: MIN_UNITS,
  });
});

// ── Cron: check every hour ────────────────────────────────
cron.schedule('0 * * * *', checkForNewApplications);

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
  ▲ PINNACLE PROPERTY BROKER
  Planning Alert Backend running on port ${PORT}
  
  Target Areas: Manchester, Cornwall, Devon, Leicester, Derby, Birmingham, Bristol
  Min Units:    ${MIN_UNITS}+
  Alert Email:  ${ALERT_EMAIL}
  Checking:     Every hour on the hour
  
  Endpoints:
    GET  /api/applications   — All live planning applications
    GET  /api/applications/:id — Single application
    GET  /api/credits        — Searchland credit usage
    POST /api/check-now      — Manually trigger a check
    GET  /health             — Server status
  `);

  // Run an initial check on startup
  setTimeout(checkForNewApplications, 5000);
});
