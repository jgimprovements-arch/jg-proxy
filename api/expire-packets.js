// ============================================================================
// /api/expire-packets.js
//
// Vercel cron endpoint — runs daily to mark overdue contract packets as
// 'expired' and unlock their SOVs. Calls the Supabase RPC
// `expire_overdue_contract_packets()` which does the actual work atomically.
//
// Logs each run to `enrichment_runs` for audit / diligence trail.
//
// Scheduled via vercel.json (see deployment notes at bottom of file).
//
// Security:
//   - Endpoint requires Vercel's PACKET_CRON_SECRET header. Requests without
//     the correct secret get 401.
//   - Uses SUPABASE_SERVICE_ROLE_KEY (not anon key) so it can bypass RLS
//     and update locked rows.
//
// Environment variables required (set in Vercel project settings):
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
//   - PACKET_CRON_SECRET
// ============================================================================

export default async function handler(req, res) {
  // -- AUTH GUARD ------------------------------------------------------------
  // Vercel cron jobs send Authorization: Bearer ${PACKET_CRON_SECRET} automatically.
  // Reject anything else.
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

  // -- CREATE AUDIT ROW ------------------------------------------------------
  // We insert a 'running' row first, then PATCH it at the end with the result.
  // If the function crashes, the row stays in 'running' state which is itself
  // a useful signal ("the cron started but never finished").
  let runId = null;
  const startedAt = new Date().toISOString();

  try {
    const insertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/enrichment_runs`,
      {
        method: 'POST',
        headers: {
          'apikey': SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          status: 'running',
          started_at: startedAt,
          steps: { cron: 'expire_overdue_contract_packets', phase: 'started' }
        })
      }
    );

    if (!insertRes.ok) {
      const text = await insertRes.text();
      console.error('Failed to create enrichment_runs row:', insertRes.status, text);
      // Continue anyway — failing to log shouldn't prevent the sweep
    } else {
      const rows = await insertRes.json();
      runId = rows?.[0]?.id;
    }
  } catch (e) {
    console.error('Exception creating enrichment_runs row:', e);
  }

  // -- CALL THE RPC ----------------------------------------------------------
  // Returns an integer count of packets expired.
  let expiredCount = null;
  let rpcError = null;

  try {
    const rpcRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/expire_overdue_contract_packets`,
      {
        method: 'POST',
        headers: {
          'apikey': SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      }
    );

    if (!rpcRes.ok) {
      rpcError = {
        status: rpcRes.status,
        body: await rpcRes.text()
      };
    } else {
      expiredCount = await rpcRes.json();
      // PostgREST returns scalar RPC results as a bare number, not wrapped in
      // an object, but handle both cases defensively.
      if (typeof expiredCount === 'object' && expiredCount !== null) {
        expiredCount = expiredCount.expire_overdue_contract_packets ?? null;
      }
    }
  } catch (e) {
    rpcError = { message: e.message, stack: e.stack };
  }

  // -- UPDATE AUDIT ROW ------------------------------------------------------
  const finishedAt = new Date().toISOString();
  const finalStatus = rpcError ? 'failed' : 'success';
  const stepsPayload = {
    cron: 'expire_overdue_contract_packets',
    phase: 'completed',
    expired_count: expiredCount
  };

  if (runId !== null) {
    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/enrichment_runs?id=eq.${runId}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SERVICE_KEY,
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            status: finalStatus,
            finished_at: finishedAt,
            steps: stepsPayload,
            errors: rpcError ? rpcError : null
          })
        }
      );
    } catch (e) {
      console.error('Failed to update enrichment_runs row:', e);
    }
  }

  // -- RESPONSE --------------------------------------------------------------
  if (rpcError) {
    return res.status(500).json({
      ok: false,
      run_id: runId,
      error: rpcError
    });
  }

  return res.status(200).json({
    ok: true,
    run_id: runId,
    expired_count: expiredCount,
    started_at: startedAt,
    finished_at: finishedAt
  });
}
