// ============================================================================
// /api/render-contract.js
//
// Vercel serverless function — fetches JG_Contract_Template.html, fills in
// 27 project-data fields via DOM injection, renders to PDF via headless
// Chrome, uploads to Supabase storage, returns the public URL.
//
// COMMONJS — matches other endpoints in this project (albi, packet-merge, etc.)
// to avoid mixed-module-system deploy warnings.
//
// Dependencies (in package.json):
//   - @sparticuz/chromium  (Chrome binary for Vercel's 50MB limit)
//   - puppeteer-core       (browser automation, lightweight version)
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Request shape (POST JSON):
//   {
//     packet_id: "<uuid>",                  // for storage path uniqueness
//     project_id: "<uuid>",                 // for storage path
//     fields: { /* 27 field IDs → string values */ },
//     draws: [ { num, pct, amount, trigger }, ... ]
//   }
//
// Response shape:
//   { ok: true, contract_pdf_url: "https://...", byte_size: 12345 }
//   { ok: false, error: "..." }
// ============================================================================

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const ALLOWED_ORIGINS = [
  'https://jgimprovements-arch.github.io',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const TEMPLATE_URL = 'https://jgimprovements-arch.github.io/jg-dispatch/JG_Contract_Template.html';

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Inject field values + draw rows into the template via Puppeteer page.evaluate
async function fillTemplate(page, fields, draws) {
  await page.evaluate(({ fields, draws }) => {
    // Set value on each ID; missing IDs are skipped silently (template version safety)
    for (const [id, value] of Object.entries(fields || {})) {
      const el = document.getElementById(id);
      if (el && value != null) {
        el.textContent = value;
      }
    }

    // Replace draw table body with rows from data
    const drawTbody = document.getElementById('draw_table_body');
    if (drawTbody && Array.isArray(draws) && draws.length > 0) {
      drawTbody.innerHTML = draws.map(function(d) {
        return '<tr>' +
          '<td>' + (d.num != null ? String(d.num) : '') + '</td>' +
          '<td>' + (d.pct || '') + '</td>' +
          '<td>$ ' + (d.amount || '') + '</td>' +
          '<td>' + (d.trigger || '') + '</td>' +
        '</tr>';
      }).join('');
    }
  }, { fields: fields, draws: draws });
}

async function uploadToSupabase(bytes, path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');

  const uploadUrl = url + '/storage/v1/object/rebuild-documents/' + path;
  const r = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/pdf',
      'x-upsert': 'false',
    },
    body: bytes,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('Storage upload failed (' + r.status + '): ' + txt);
  }
  return url + '/storage/v1/object/public/rebuild-documents/' + path;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  let browser = null;
  try {
    const body = req.body || {};
    const packet_id = body.packet_id;
    const project_id = body.project_id;
    const fields = body.fields;
    const draws = body.draws;

    if (!packet_id || !project_id) {
      return res.status(400).json({ ok: false, error: 'packet_id and project_id required' });
    }
    if (!fields || typeof fields !== 'object') {
      return res.status(400).json({ ok: false, error: 'fields object required' });
    }

    // Launch headless Chrome with Sparticuz binary
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Navigate to template (waits for logo image, fonts, CSS to load)
    const resp = await page.goto(TEMPLATE_URL, { waitUntil: 'networkidle0', timeout: 30000 });
    if (!resp || !resp.ok()) {
      throw new Error('Template fetch failed: ' + (resp ? resp.status() : 'no response'));
    }

    // Inject field values
    await fillTemplate(page, fields, draws);

    // Render to PDF — letter size, preserve CSS @page margins
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    });

    await browser.close();
    browser = null;

    // Upload to Supabase
    const path = 'projects/' + project_id + '/packets/' + packet_id + '-contract.pdf';
    const contract_pdf_url = await uploadToSupabase(pdfBuffer, path);

    return res.status(200).json({
      ok: true,
      contract_pdf_url: contract_pdf_url,
      byte_size: pdfBuffer.length,
    });

  } catch (err) {
    console.error('render-contract error:', err);
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
};

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: '5mb' },
  },
  maxDuration: 60,
};
