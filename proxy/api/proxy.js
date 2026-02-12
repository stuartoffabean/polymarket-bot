const https = require('https');

module.exports = async (req, res) => {
  const path = req.url || '/';
  const target = `https://clob.polymarket.com${path}`;
  
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith('poly') || key === 'content-type') {
      headers[key] = value;
    }
  }
  headers['user-agent'] = '@polymarket/clob-client';
  headers['accept'] = '*/*';

  let body = '';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await new Promise((resolve) => {
      let d = '';
      req.on('data', c => d += c);
      req.on('end', () => resolve(d));
    });
  }

  const url = new URL(target);
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: req.method,
    headers: {
      ...headers,
      host: url.hostname,
    },
  };
  if (body) options.headers['content-length'] = Buffer.byteLength(body);

  const proxyRes = await new Promise((resolve, reject) => {
    const r = https.request(options, resolve);
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });

  let data = '';
  await new Promise((resolve) => {
    proxyRes.on('data', c => data += c);
    proxyRes.on('end', resolve);
  });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/json');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  res.status(proxyRes.statusCode).send(data);
};
