const https = require('https');

module.exports = async (req, res) => {
  // Route: /data-api/activity?user=... → https://data-api.polymarket.com/activity?user=...
  // The rewrite sends us here; req.url still has the original query params
  const path = req.url.replace(/^\/api\/data\??/, '').replace(/^\/data-api/, '') || '/';
  const target = `https://data-api.polymarket.com${path}`;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = new URL(target);
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'GET',
    headers: {
      'user-agent': 'Mozilla/5.0',
      'accept': 'application/json',
      host: url.hostname,
    },
  };

  try {
    const proxyRes = await new Promise((resolve, reject) => {
      const r = https.request(options, resolve);
      r.on('error', reject);
      r.end();
    });

    let data = '';
    await new Promise((resolve) => {
      proxyRes.on('data', c => data += c);
      proxyRes.on('end', resolve);
    });

    res.setHeader('Content-Type', 'application/json');
    res.status(proxyRes.statusCode).send(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
