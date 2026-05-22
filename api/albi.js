module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Handle invite action via POST
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
  // GET — fetch Albi projects
  const ALBI_KEY = '87549e5d-12b4-4ae6-9c49-aed434f00735';
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
