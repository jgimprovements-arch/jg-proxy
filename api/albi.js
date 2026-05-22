module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Albi API key ────────────────────────────────────────────────────────
  // Reads from env var first, falls back to old hardcoded value so the
  // existing tools keep working while you're migrating. Once the env var
  // is set in Vercel, remove the fallback (delete the || '...' clause).
  const ALBI_KEY = process.env.ALBI_API_KEY || '135e4c0e-9d1b-46be-8f47-94951e93ffab';

  // Handle invite action via POST (unchanged)
  if (req.method === 'POST') {
    const { action, email, name, role, market, hourly_rate } = req.body || {};
    if (action === 'invite') {
      if (!email || !name) return res.status(400).json({ error: 'email and name required' });
      const SB_URL = 'https://nuykvchgecpiuikoerze.supabase.co';
      const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SERVICE_KEY) return res.status(500).json({ error: 'Service key not configured' });
      try {
        const inviteRes = await fetch(SB_URL + '/auth/v1/invite', {
          method: 'POST',
          headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, data: { name: name, role: role, market: market } })
        });
        const inviteData = await inviteRes.json();
        if (!inviteRes.ok) return res.status(400).json({ error: inviteData.message || 'Invite failed' });
        await fetch(SB_URL + '/rest/v1/employees', {
          method: 'POST',
          headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({ name: name, email: email.toLowerCase(), role: role || 'Technician', market: market || 'Appleton', hourly_rate: parseFloat(hourly_rate) || 0, active: true })
        });
        return res.status(200).json({ success: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    return res.status(400).json({ error: 'Unknown action' });
  }

  // ── GET ────────────────────────────────────────────────────────────────
  // Two modes:
  //   ?name=Albrecht-2811-WTR    → returns the single matching project
  //   (no name) → original paginated list (backward compatible)
  const projectName = (req.query.name || '').trim();

  if (projectName) {
    // Single-project lookup by exact name match.
    // Albi's API doesn't expose a name-filter directly, so we walk pages
    // until we find a match or exhaust. Most rebuttals are recent
    // projects, so we sort by recent first and bail early.
    try {
      const maxPages = 30; // 30 pages × 50 = 1500 projects scanned worst case
      for (let p = 1; p <= maxPages; p++) {
        const url = `https://app.albiware.com/api/v5/Integrations/Projects?pageSize=50&page=${p}`;
        const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + ALBI_KEY, 'Accept': 'application/json' } });
        if (!r.ok) {
          return res.status(r.status).json({ error: 'Albi API error', status: r.status });
        }
        const data = await r.json();
        const match = (data.data || []).find(prj => (prj.name || '').toLowerCase() === projectName.toLowerCase());
        if (match) {
          res.setHeader('Cache-Control', 's-maxage=60');
          return res.status(200).json({ data: match, found_on_page: p });
        }
        // No more pages?
        if (!data.pagination || p >= (data.pagination.totalPages || 0)) break;
      }
      return res.status(404).json({ error: 'project not found', name: projectName });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Original paginated list (unchanged behavior)
  const page = req.query.page || '1';
  const pageSize = req.query.pageSize || '50';
  const location = req.query.location || '';
  let url = 'https://app.albiware.com/api/v5/Integrations/Projects?pageSize=' + pageSize + '&page=' + page;
  if (location) url += '&location=' + encodeURIComponent(location);
  try {
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + ALBI_KEY, 'Accept': 'application/json' } });
    const text = await r.text();
    res.setHeader('Cache-Control', 's-maxage=120');
    return res.status(r.status).send(text);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
