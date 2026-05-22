// /api/packet-merge.js
// Vercel serverless function — merges Xactimate + SOV + Contract PDFs into one
// signed-packet PDF, uploads to Supabase storage, returns the public URL.
//
// Deploy: drop into jg-proxy-v2/api/packet-merge.js, commit, Vercel auto-deploys.
//
// Required env vars (set in Vercel dashboard):
//   SUPABASE_URL              = https://nuykvchgecpiuikoerze.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY = (service role key — NOT anon)
//
// Why service role: we upload to the rebuild-documents storage bucket; anon
// key won't have insert permission. Service role bypasses RLS, which is
// correct here because this endpoint is server-side only.
//
// Request shape (POST JSON):
//   {
//     packet_id:        "<uuid of rebuild_contract_packets row>",
//     project_id:       "<uuid of rebuild_projects row>",
//     xact_pdf_url:     "https://...xactimate.pdf",
//     sov_pdf_url:      "https://...sov.pdf",        // (or inline base64; see below)
//     contract_pdf_url: "https://...contract.pdf",
//     albi_job_number:  "2214-FRE-Lam"                // for filename
//   }
//
// Response shape:
//   { ok: true, merged_pdf_url: "https://...packet-vN.pdf", page_count: N }
//   { ok: false, error: "..." }

const { PDFDocument } = require('pdf-lib');

// CORS — GitHub Pages origin only (locks down to JG platform)
const ALLOWED_ORIGINS = [
  'https://jgimprovements-arch.github.io',
  'http://localhost:5500',   // local dev
  'http://127.0.0.1:5500',
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchPdfBytes(url) {
  if (!url) throw new Error('PDF URL missing');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed (${r.status}) for ${url}`);
  const ct = r.headers.get('content-type') || '';
  // Permissive: some Supabase URLs return application/octet-stream
  if (!ct.includes('pdf') && !ct.includes('octet-stream') && !ct.includes('binary')) {
    console.warn('Unexpected content-type', ct, 'for', url);
  }
  return new Uint8Array(await r.arrayBuffer());
}

async function mergePdfs(xactBytes, sovBytes, contractBytes) {
  const merged = await PDFDocument.create();
  merged.setTitle('JG Restoration — Contract Packet');
  merged.setProducer('JG Platform');
  merged.setCreator('jg-proxy-v2/api/packet-merge');
  merged.setCreationDate(new Date());

  // Order matters: Contract first (legal terms), then SOV (scope of work
  // & draw schedule), then Xactimate (estimate detail). Customer reads
  // top-to-bottom: "what I'm agreeing to" → "what I'm getting" → "how it was
  // priced". This order also matches the order referenced in contract.html.
  const sources = [
    { bytes: contractBytes, label: 'Contract' },
    { bytes: sovBytes,      label: 'SOV' },
    { bytes: xactBytes,     label: 'Xactimate' },
  ];

  for (const src of sources) {
    if (!src.bytes || src.bytes.length === 0) {
      throw new Error(`Empty PDF: ${src.label}`);
    }
    let doc;
    try {
      doc = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
    } catch (e) {
      throw new Error(`${src.label} PDF could not be parsed: ${e.message}`);
    }
    const indices = doc.getPageIndices();
    const copied = await merged.copyPages(doc, indices);
    copied.forEach(p => merged.addPage(p));
  }

  const pageCount = merged.getPageCount();
  const bytes = await merged.save({ useObjectStreams: false });
  return { bytes, pageCount };
}

async function uploadToSupabase(bytes, path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing on Vercel');

  // Direct REST upload to storage bucket
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
  // Public URL
  return `${url}/storage/v1/object/public/rebuild-documents/${path}`;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const {
      packet_id,
      project_id,
      xact_pdf_url,
      sov_pdf_url,
      contract_pdf_url,
      albi_job_number,
    } = req.body || {};

    if (!packet_id || !project_id) {
      return res.status(400).json({ ok: false, error: 'packet_id and project_id required' });
    }
    if (!xact_pdf_url || !sov_pdf_url || !contract_pdf_url) {
      return res.status(400).json({ ok: false, error: 'xact_pdf_url, sov_pdf_url, contract_pdf_url all required' });
    }

    // Fetch all three in parallel
    const [xactBytes, sovBytes, contractBytes] = await Promise.all([
      fetchPdfBytes(xact_pdf_url),
      fetchPdfBytes(sov_pdf_url),
      fetchPdfBytes(contract_pdf_url),
    ]);

    const { bytes, pageCount } = await mergePdfs(xactBytes, sovBytes, contractBytes);

    // Storage path — include project_id + packet_id so re-issues don't collide
    const safeJob = (albi_job_number || project_id).replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `projects/${project_id}/packets/${packet_id}-${safeJob}-packet.pdf`;
    const merged_pdf_url = await uploadToSupabase(bytes, path);

    return res.status(200).json({
      ok: true,
      merged_pdf_url,
      page_count: pageCount,
      byte_size: bytes.length,
    });
  } catch (err) {
    console.error('packet-merge error:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}

// Larger body limit (PDFs are big — Xact can be 30MB)
module.exports.config = {
  api: {
    bodyParser: { sizeLimit: '50mb' },
  },
  maxDuration: 60, // Vercel hobby/pro: allow 60s for big merges
};
