export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const ALBI_KEY = '135e4c0e-9d1b-46be-8f47-94951e93ffab';
  const page = req.query.page || '1';
  const pageSize = req.query.pageSize || '50';
  const location = req.query.location || '';
  let url = 'https://api.albiware.com/v5/Integrations/Projects?pageSize=' + pageSize + '&page=' + page;
  if (location) url += '&location=' + encodeURIComponent(location);
  try {
    const r = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + ALBI_KEY, 'Accept': 'application/json' }
    });
    const text = await r.text();
    res.setHeader('Cache-Control', 's-maxage=120');
    res.status(r.status).send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
