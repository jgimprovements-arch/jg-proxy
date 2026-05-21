// ============================================================================
// /api/render-contract.js
//
// Vercel serverless function — fetches JG_Contract_Template.html, fills in
// 29 project-data fields via DOM injection, renders to PDF via headless
// Chrome, uploads to Supabase storage, returns the public URL.
//
// Deploy: drop into jg-proxy/api/render-contract.js, commit, Vercel deploys.
//
// Dependencies (in package.json):
//   - @sparticuz/chromium  (Chrome binary for Vercel's 50MB limit)
//   - puppeteer-core       (browser automation, lightweight version)
//   - pdf-lib              (already there for packet-merge)
//
// Required env vars (already set):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Request shape (POST JSON):
//   {
//     packet_id: "<uuid>",                  // for storage path uniqueness
//     project_id: "<uuid>",                 // for storage path
//     fields: {                             // object of 29 field IDs → values
//       cover_owner_name: "Jane Lam",
//       cover_project_site: "1234 Main St, Appleton WI 54913",
//       cover_contract_date: "May 21, 2026",
//       cover_project_ref: "Lam-2214-REB",
//       owner_name: "Jane Lam",
//       owner_address: "1234 Main St, Appleton WI 54913",
//       owner_phone: "(920) 555-1234",
//       owner_email: "jane@example.com",
//       contract_price: "103,874.51",
//       sales_rep_name: "Josh Greil",
//       project_site_addr_1: "1234 Main St",
//       project_site_addr_2: "Appleton, WI 54913",
//       commencement_date: "Jun 1, 2026",
//       completion_date: "Sep 1, 2026",
//       ... (see full list in fillTemplate function below)
//     },
//     draws: [                              // SOV draws for the page-3 table
//       { num: 1, pct: "50%", amount: "51,937.26", trigger: "Contract signing & material deposits" },
//       { num: 2, pct: "50%", amount: "51,937.25", trigger: "Substantial completion & punch list sign-off" }
//     ]
//   }
//
// Response shape:
//   { ok: true, contract_pdf_url: "https://...contract.pdf", page_count: 27 }
//   { ok: false, error: "..." }
// ============================================================================

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

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

// Escapes user input for safe HTML injection
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
      drawTbody.innerHTML = draws.map(d => `
        <tr>
          <td>${d.num != null ? String(d.num) : ''}</td>
          <td>${d.pct || ''}</td>
          <td>$ ${d.amount || ''}</td>
          <td>${d.trigger || ''}</td>
        </tr>
      `).join('');
    }
  }, { fields, draws });
}

async function uploadToSupabase(bytes, path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');

  const uploadUrl = `${url}/storage/v1/object/rebuild-documents/${path}`;
  const r = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'false',
    },
    body: bytes,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Storage upload failed (${r.status}): ${txt}`);
  }
  return `${url}/storage/v1/object/public/rebuild-documents/${path}`;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  let browser = null;
  try {
    const { packet_id, project_id, fields, draws } = req.body || {};
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
      throw new Error(`Template fetch failed: ${resp ? resp.status() : 'no response'}`);
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
    const path = `projects/${project_id}/packets/${packet_id}-contract.pdf`;
    const contract_pdf_url = await uploadToSupabase(pdfBuffer, path);

    return res.status(200).json({
      ok: true,
      contract_pdf_url,
      byte_size: pdfBuffer.length,
    });

  } catch (err) {
    console.error('render-contract error:', err);
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '5mb' },
  },
  maxDuration: 60,
};
