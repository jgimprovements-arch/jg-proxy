// ============================================================================
// /api/expire-packets.js
//
// Vercel cron endpoint — runs daily to mark overdue contract packets as
// 'expired' and unlock their SOVs. Calls the Supabase RPC
// `expire_overdue_contract_packets()` which does the actual work atomically.
//
// Logs one row per run to `enrichment_runs` for audit / diligence trail.
// Audit row is inserted at end with final status only — matches the existing
// rebuttals cron pattern (status enum: success / failed / partial).
//
// Scheduled via vercel.json (daily at 9 AM UTC = 4 AM Central).
//
// Security:
//   - Endpoint requires PACKET_CRON_SECRET header. Requests without the
//     correct secret get 401.
//   - Uses SUPABASE_SERVICE_ROLE_KEY (not anon key) so it can bypass RLS
//     and update locked rows.
//
// Environment variables required (set in Vercel project settings):
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
//   - PACKET_CRON_SECRET
// ============================================================================

module.exports = async function handler(req, res) {
  // -- AUTH GUARD ------------------------------------------------------------
  const authHeader = req.headers.authorization || '';
  const expected = `Bearer ${process.env.PACKET_CRON_SECRET}`;
  if (!process.env.PACKET_CRON_SECRET || authHeader !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // -- ENV CHECK -------------------------------------------------------------
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({
      error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars'
    });
  }

  con
