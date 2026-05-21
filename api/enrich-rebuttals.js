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
//   - Endpoint requires Vercel's CRON_SECRET header. Requests without the
//     correct secret get 401.
//   - Uses SUPABASE_SERVICE_ROLE_KEY (not anon key) so it can bypass RLS
//     and update locked rows.
//
// Environment variables required (set in Vercel project settings):
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
//   - CRON_SECRET
// ============================================================================

export default async function handler(req, res) {
  // -- AUTH GUARD ------------------------------------------------------------
  // Vercel cron jobs send Authorization: Bearer ${CRON_SECRET} automatically.
  // Reject anything else.
  const authHeader = req.headers.authorization || '';
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || authHeader !== expected) {
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

// ============================================================================
// DEPLOYMENT NOTES
// ============================================================================
//
// 1. Copy this file to your jg-proxy-v2 repo at:
//      api/expire-packets.js
//
// 2. Add the cron schedule to vercel.json (at repo root). If vercel.json
//    doesn't have a "crons" section yet, add one. If it already does, append
//    this entry to the array:
//
//    {
//      "crons": [
//        {
//          "path": "/api/expire-packets",
//          "schedule": "0 9 * * *"
//        }
//      ]
//    }
//
//    Schedule "0 9 * * *" = 9:00 AM UTC daily = 4:00 AM Central Time.
//    Picked this time to run an hour after the existing rebuttals sweep
//    (which runs at 8 AM UTC / 3 AM CT). Avoids any contention.
//
//    Note: Vercel Hobby tier supports daily crons only. If you're on Pro,
//    you could go hourly, but daily is plenty for packet expiry.
//
// 3. Set environment variable in Vercel project settings:
//      CRON_SECRET = <a random string>
//
//    Generate one with: openssl rand -base64 32
//    Or just: any random 32+ character string.
//
//    SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY should already be set if
//    your rebuttals cron is working.
//
// 4. Deploy. Vercel will register the cron automatically. The first run
//    will happen at the next 9 AM UTC after deployment.
//
// 5. Manual test (use the same Bearer token you set as CRON_SECRET):
//
//      curl -X GET https://jg-proxy-v2.vercel.app/api/expire-packets \
//        -H "Authorization: Bearer YOUR_CRON_SECRET"
//
//    Expected response:
//      { "ok": true, "run_id": 123, "expired_count": 0, ... }
//
//    Then verify the audit row landed:
//      SELECT * FROM enrichment_runs
//       ORDER BY started_at DESC LIMIT 1;
//
//    Should show status='success', steps shows cron name + expired_count.
//
// 6. Test the auth guard (should return 401):
//
//      curl https://jg-proxy-v2.vercel.app/api/expire-packets
//
//    Expected: HTTP 401 with { "error": "Unauthorized" }
//
// ============================================================================
