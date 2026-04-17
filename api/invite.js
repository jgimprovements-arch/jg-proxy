// api/invite.js — Add to jg-proxy-v2 Vercel project
// Requires SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://jgimprovements-arch.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, name, role, market, hourly_rate } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: 'email and name required' });

  const SB_URL = 'https://nuykvchgecpiuikoerze.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Service key not configured' });

  try {
    // 1. Send Supabase Auth invite
    const inviteRes = await fetch(`${SB_URL}/auth/v1/invite`, {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        data: { name, role, market }
      })
    });

    const inviteData = await inviteRes.json();
    if (!inviteRes.ok) {
      return res.status(400).json({ error: inviteData.message || inviteData.msg || 'Invite failed' });
    }

    // 2. Upsert employee record in employees table
    await fetch(`${SB_URL}/rest/v1/employees`, {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        name,
        email: email.toLowerCase(),
        role: role || 'Technician',
        market: market || 'Appleton',
        hourly_rate: parseFloat(hourly_rate) || 0,
        active: true
      })
    });

    return res.status(200).json({ success: true, message: `Invite sent to ${email}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
