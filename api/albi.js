export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const ALBI_KEY = '135e4c0e-9d1b-46be-8f47-94951e93ffab';
  const page = req.query.page || '1';
  const pageSize = req.query.pageSize || '50';
  const location = req.query.location || '';

  let url = 'https://api.albiware.com/v5/Integrations/Projects?pageSize=' + pageSize + '&page=' + page;
  if (location) url += '&location=' + encodeURIComponent(location);

  try {
    const r = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + ALBI_KEY,
        'Accept': 'application/json'
      }
    });
    const text = await r.text();
    res.setHeader('Cache-Control', 's-maxage=120');
    res.status(r.status).send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
const ALBI_KEY = '135e4c0e-9d1b-46be-8f47-94951e93ffab';

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const page = req.query.page || '1';
  const pageSize = req.query.pageSize || '50';
  const location = req.query.location || '';

  let url = 'https://api.albiware.com/v5/Integrations/Projects?pageSize=' + pageSize + '&page=' + page;
  if (location) {
    url += '&location=' + encodeURIComponent(location);
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + ALBI_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    const text = await response.text();
    res.setHeader('Cache-Control', 's-maxage=120');
    res.status(response.status).send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const ALBI_KEY = '135e4c0e-9d1b-46be-8f47-94951e93ffab';
  const { location, pageSize = '50', page = '1' } = req.query;

  // location param is "Appleton" or "Stevens Point"
  const endpoints = [
    'https://api.albiware.com/v5/Integrations/Projects',
    'https://api.albiware.com/v5/Projects',
  ];

  for (const base of endpoints) {
    try {
      const params = new URLSearchParams({ pageSize, page });
      if (location) params.set('location', location);
      const url = `${base}?${params}`;

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

  return res.status(200).json([]);
}
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
