export default async function handler(req, res) {
  // Handle preflight CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const ALBI_KEY = '135e4c0e-9d1b-46be-8f47-94951e93ffab';

  // Try multiple Albi endpoint patterns
  const endpoints = [
    'https://api.albiware.com/v5/Integrations/Projects',
    'https://api.albiware.com/v5/Projects',
  ];

  const params = new URLSearchParams(req.query).toString();

  for (const base of endpoints) {
    try {
      const url = params ? `${base}?${params}` : base;
      const albiRes = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${ALBI_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      if (albiRes.ok) {
        const data = await albiRes.json();
        res.setHeader('Cache-Control', 's-maxage=120');
        return res.status(200).json(data);
      }
    } catch (err) {
      continue;
    }
  }

  // If all endpoints failed, return empty so board doesn't break
  return res.status(200).json([]);
}
