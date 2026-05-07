// ═══════════════════════════════════════════════════════════════════════════
// JG Restoration — Nightly Rebuttal Enrichment via Albi
// ═══════════════════════════════════════════════════════════════════════════
// Runs nightly at 8 AM UTC (3 AM Central CDT / 2 AM CST).
//
// For every adjuster_rebuttal where final_outcome IS NULL, queries Albi
// for the matching project (by name). If the project is closed and has a
// paid amount, writes back:
//   - payment_received_amount
//   - payment_received_date     (uses Albi's updatedAt as proxy)
//   - days_to_payment           (rebuttal created_at → close date)
//   - final_outcome             (paid_full / paid_partial / denied)
//   - outcome_notes             (Albi project ID, billed %, etc.)
//
// Also captures bonus diagnostics:
//   - actualRevenue vs jg_total → flags scope adjustments
//   - projectBilledPercent     → flags partial billings
//   - insuranceCompany         → validates against rebuttal's carrier
//
// Required env vars (set in Vercel dashboard):
//   ALBI_API_KEY            — already exists or to be added; falls back to
//                             hardcoded key in albi.js (which itself should
//                             be migrated to env var)
//   SUPABASE_URL            — already exists
//   SUPABASE_SERVICE_ROLE_KEY — already exists (the "Needs Attention" one;
//                               will work fine for writes)
//   CRON_SECRET             — shared secret for cron auth; generate with
//                             `openssl rand -hex 32`
// ═══════════════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  // ── Cron auth gate ─────────────────────────────────────────────────────
  // Vercel cron sets 'authorization: Bearer <CRON_SECRET>' automatically.
  // Reject anything else so this can't be hit publicly.
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const startedAt = new Date().toISOString();
  const log = { started_at: startedAt, steps: [], errors: [] };

  try {
    // ── Config check ─────────────────────────────────────────────────────
    const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
      log.errors.push({ step: 'config', missing });
      return res.status(500).json({ ok: false, error: 'missing env vars', missing });
    }

    const SB = {
      url: process.env.SUPABASE_URL,
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      }
    };

    // Albi key — env var first, fallback to known production key
    const ALBI_KEY = process.env.ALBI_API_KEY || '135e4c0e-9d1b-46be-8f47-94951e93ffab';

    // ── Pull pending rebuttals ───────────────────────────────────────────
    // Criteria: no final_outcome yet, created within last 365 days.
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const pendingRes = await fetch(
      `${SB.url}/rest/v1/adjuster_rebuttals?select=id,project_name,carrier,claim_number,created_at,jg_total&final_outcome=is.null&created_at=gte.${cutoff}&order=created_at.asc`,
      { headers: SB.headers }
    );
    if (!pendingRes.ok) {
      const body = await pendingRes.text();
      throw new Error(`supabase pending fetch failed ${pendingRes.status}: ${body.slice(0, 200)}`);
    }
    const pending = await pendingRes.json();
    log.steps.push({ step: 'pending_count', value: pending.length });

    if (pending.length === 0) {
      log.steps.push({ step: 'done', reason: 'nothing to enrich' });
      await writeLog(SB, log, 'success');
      return res.status(200).json({ ok: true, enriched: 0, pending: 0 });
    }

    // ── Enrich each rebuttal ─────────────────────────────────────────────
    let enrichedCount = 0;
    let stillOpenCount = 0;
    let noMatchCount = 0;
    let mismatchedCount = 0;

    for (const reb of pending) {
      try {
        const project = await findAlbiProject(ALBI_KEY, reb.project_name, log);

        if (!project) {
          noMatchCount++;
          log.steps.push({ step: 'no_match', project: reb.project_name });
          continue;
        }

        // Validate carrier match (warning, not blocker)
        if (reb.carrier && project.insuranceCompany &&
            !carrierMatches(reb.carrier, project.insuranceCompany)) {
          mismatchedCount++;
          log.errors.push({
            step: 'carrier_mismatch_warning',
            project: reb.project_name,
            rebuttal_carrier: reb.carrier,
            albi_carrier: project.insuranceCompany,
            note: 'enriching anyway — verify manually'
          });
        }

        // Skip if project is still open
        if (!project.closedBoolean) {
          stillOpenCount++;
          log.steps.push({ step: 'still_open', project: reb.project_name, status: project.status });
          continue;
        }

        // Project is closed — calculate outcome
        const outcome = classifyAlbiProject(project, reb);

        const updateRes = await fetch(
          `${SB.url}/rest/v1/adjuster_rebuttals?id=eq.${reb.id}`,
          {
            method: 'PATCH',
            headers: { ...SB.headers, Prefer: 'return=minimal' },
            body: JSON.stringify({
              payment_received_amount: outcome.payment_received_amount,
              payment_received_date:   outcome.payment_received_date,
              days_to_payment:         outcome.days_to_payment,
              final_outcome:           outcome.final_outcome,
              outcome_notes:           outcome.notes
            })
          }
        );

        if (updateRes.ok) {
          enrichedCount++;
          log.steps.push({
            step: 'enriched',
            project: reb.project_name,
            albi_id: project.id,
            outcome: outcome.final_outcome,
            paid: outcome.payment_received_amount,
            days: outcome.days_to_payment
          });
        } else {
          const errBody = await updateRes.text();
          log.errors.push({ step: 'supabase_update_failed', project: reb.project_name, status: updateRes.status, body: errBody.slice(0, 200) });
        }
      } catch (e) {
        log.errors.push({ step: 'enrich_row_failed', project: reb.project_name, message: e.message });
      }
    }

    log.steps.push({
      step: 'summary',
      pending: pending.length,
      enriched: enrichedCount,
      still_open: stillOpenCount,
      no_match: noMatchCount,
      carrier_mismatches: mismatchedCount
    });
    await writeLog(SB, log, 'success');
    return res.status(200).json({
      ok: true,
      pending: pending.length,
      enriched: enrichedCount,
      still_open: stillOpenCount,
      no_match: noMatchCount,
      carrier_mismatches: mismatchedCount
    });
  } catch (e) {
    log.errors.push({ step: 'fatal', message: e.message });
    try {
      await writeLog({
        url: process.env.SUPABASE_URL,
        headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }
      }, log, 'failed');
    } catch (_) { /* swallow */ }
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Find a single Albi project by exact name match (case-insensitive).
// Walks pages until match or exhaustion.
// ─────────────────────────────────────────────────────────────────────────
async function findAlbiProject(apiKey, projectName, log) {
  const target = (projectName || '').trim().toLowerCase();
  if (!target) return null;

  const maxPages = 30; // 1,500 projects scanned worst case — Albi has ~3,000 total
  for (let p = 1; p <= maxPages; p++) {
    const url = `https://app.albiware.com/api/v5/Integrations/Projects?pageSize=50&page=${p}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    });
    if (!r.ok) {
      log.errors.push({ step: 'albi_fetch_failed', page: p, status: r.status });
      return null;
    }
    const data = await r.json();
    const match = (data.data || []).find(prj => (prj.name || '').trim().toLowerCase() === target);
    if (match) return match;
    if (!data.pagination || p >= (data.pagination.totalPages || 0)) break;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Loose carrier name match — strips noise and compares.
// "State Farm" matches "State Farm Insurance Company / Proximity"
// ─────────────────────────────────────────────────────────────────────────
function carrierMatches(rebuttalCarrier, albiCarrier) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const r = norm(rebuttalCarrier);
  const a = norm(albiCarrier);
  if (!r || !a) return true; // can't compare, don't block
  return a.includes(r) || r.includes(a);
}

// ─────────────────────────────────────────────────────────────────────────
// Classify an Albi project into our outcome schema.
// ─────────────────────────────────────────────────────────────────────────
function classifyAlbiProject(project, rebuttal) {
  const paid = Number(project.paidAmount || 0);
  const billed = Number(project.actualRevenue || 0);
  const billedPct = Number(project.projectBilledPercent || 0);

  // Parse rebuttal's JG total for comparison
  const jgTotalNum = Number(String(rebuttal.jg_total || '').replace(/[^0-9.]/g, '')) || 0;

  // Closed-date proxy: Albi doesn't expose a literal close date in this API,
  // but updatedAt is the last modification. For closed projects, that's
  // typically when the close action was taken.
  const closedDate = project.updatedAt ? new Date(project.updatedAt) : new Date();
  const rebuttalDate = new Date(rebuttal.created_at);
  const daysToPayment = Math.max(0, Math.round((closedDate - rebuttalDate) / (1000 * 60 * 60 * 24)));

  // Outcome classification
  // We compare paidAmount against actualRevenue (the final billed amount,
  // which may be lower than jg_total if scope was adjusted).
  let outcome;
  if (paid <= 0.01) {
    outcome = 'denied';
  } else if (billed > 0 && paid >= billed * 0.98) {
    outcome = 'paid_full';
  } else if (paid > 0 && paid < billed) {
    outcome = 'paid_partial';
  } else if (paid > 0 && billed === 0) {
    // Edge case: payment exists but no actualRevenue recorded
    outcome = 'paid_partial';
  } else {
    outcome = 'paid_partial';
  }

  // Notes — captures the diagnostic details for buyer-pitch storytelling
  const notes = [
    `Albi project ID ${project.id}`,
    `billed $${billed.toFixed(2)}`,
    `paid $${paid.toFixed(2)}`,
    `JG estimate was $${jgTotalNum.toFixed(2)}`,
    `billed % ${billedPct.toFixed(1)}`,
    project.insuranceCompany ? `carrier: ${project.insuranceCompany}` : null,
    project.insuranceClaimNumber ? `claim: ${project.insuranceClaimNumber}` : null
  ].filter(Boolean).join('; ');

  return {
    payment_received_amount: `$${paid.toFixed(2)}`,
    payment_received_date: closedDate.toISOString().slice(0, 10),
    days_to_payment: daysToPayment,
    final_outcome: outcome,
    notes
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Write run log to audit table
// ─────────────────────────────────────────────────────────────────────────
async function writeLog(SB, log, status) {
  try {
    await fetch(`${SB.url}/rest/v1/enrichment_runs`, {
      method: 'POST',
      headers: { ...SB.headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        status,
        steps: log.steps,
        errors: log.errors,
        started_at: log.started_at,
        finished_at: new Date().toISOString()
      })
    });
  } catch (e) {
    console.error('writeLog failed:', e);
  }
}
