/**
 * Stuart's Trading Dashboard
 * Simple auth-protected dashboard that queries Polymarket APIs
 * Runs on port 3003
 */

const http = require("http");
const crypto = require("crypto");

const PORT = 3003;
const USERNAME = "micky";
const PASSWORD = "stuart2026";

function checkAuth(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) return false;
  const decoded = Buffer.from(auth.slice(6), "base64").toString();
  const [user, pass] = decoded.split(":");
  return user === USERNAME && pass === PASSWORD;
}

const WALLET = "0xe693Ef449979E387C8B4B5071Af9e27a7742E18D";
const PROXY = "https://proxy-rosy-sigma-25.vercel.app";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stuart Trading Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0f; color: #e0e0e0; font-family: 'SF Mono', 'Fira Code', monospace; padding: 20px; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; border-bottom: 1px solid #1a1a2e; padding-bottom: 15px; }
  .header h1 { color: #00ff88; font-size: 1.4em; }
  .header .status { color: #00ff88; font-size: 0.9em; }
  .header .status.offline { color: #ff4444; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
  .card { background: #12121f; border: 1px solid #1a1a2e; border-radius: 8px; padding: 15px; }
  .card .label { color: #888; font-size: 0.75em; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; }
  .card .value { font-size: 1.6em; font-weight: bold; }
  .card .value.green { color: #00ff88; }
  .card .value.red { color: #ff4444; }
  .card .value.blue { color: #4488ff; }
  .card .value.yellow { color: #ffaa00; }
  .section { margin-bottom: 30px; }
  .section h2 { color: #4488ff; font-size: 1em; margin-bottom: 10px; border-bottom: 1px solid #1a1a2e; padding-bottom: 5px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #666; font-size: 0.75em; text-transform: uppercase; letter-spacing: 1px; padding: 8px; border-bottom: 1px solid #1a1a2e; }
  td { padding: 8px; border-bottom: 1px solid #0f0f1a; font-size: 0.85em; }
  tr:hover { background: #15152a; }
  .buy { color: #00ff88; }
  .sell { color: #ff4444; }
  .refresh-btn { background: #1a1a2e; color: #4488ff; border: 1px solid #4488ff; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 0.8em; }
  .refresh-btn:hover { background: #4488ff; color: #0a0a0f; }
  .timestamp { color: #444; font-size: 0.7em; }
  .empty { color: #444; font-style: italic; padding: 20px; text-align: center; }
  .bot-status { display: flex; gap: 15px; flex-wrap: wrap; }
  .pill { background: #1a1a2e; border-radius: 20px; padding: 4px 12px; font-size: 0.75em; }
  .pill.active { border: 1px solid #00ff88; color: #00ff88; }
  .pill.inactive { border: 1px solid #666; color: #666; }
</style>
</head>
<body>
  <div class="header">
    <h1>🎰 Stuart Trading Dashboard</h1>
    <div>
      <span id="bot-status" class="status">Checking...</span>
      <button class="refresh-btn" onclick="refresh()">↻ Refresh</button>
    </div>
  </div>

  <div class="grid">
    <div class="card"><div class="label">USDCe Balance</div><div id="balance" class="value green">—</div></div>
    <div class="card"><div class="label">POL (Gas)</div><div id="pol" class="value blue">—</div></div>
    <div class="card"><div class="label">Open Orders</div><div id="open-orders" class="value yellow">—</div></div>
    <div class="card"><div class="label">Positions</div><div id="positions-count" class="value blue">—</div></div>
  </div>

  <div class="section">
    <h2>📋 Open Orders</h2>
    <table>
      <thead><tr><th>Market</th><th>Side</th><th>Price</th><th>Size</th><th>Filled</th><th>Status</th></tr></thead>
      <tbody id="orders-table"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody>
    </table>
  </div>

  <div class="section">
    <h2>📊 Positions</h2>
    <table>
      <thead><tr><th>Market</th><th>Outcome</th><th>Size</th><th>Avg Price</th><th>Current</th><th>P&L</th></tr></thead>
      <tbody id="positions-table"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody>
    </table>
  </div>

  <div class="section">
    <h2>📜 Recent Activity</h2>
    <table>
      <thead><tr><th>Time</th><th>Market</th><th>Side</th><th>Price</th><th>Size</th></tr></thead>
      <tbody id="activity-table"><tr><td colspan="5" class="empty">Loading...</td></tr></tbody>
    </table>
  </div>

  <div class="timestamp">Last updated: <span id="last-update">—</span></div>

<script>
const WALLET = "${WALLET}";
const API = "/api";

async function fetchJSON(url) {
  try {
    const r = await fetch(url);
    return await r.json();
  } catch(e) { return null; }
}

async function refresh() {
  document.getElementById("last-update").textContent = new Date().toLocaleString();

  // Balances
  const bals = await fetchJSON(API + "/balances");
  if (bals) {
    document.getElementById("balance").textContent = "$" + bals.usdce.toFixed(2);
    document.getElementById("pol").textContent = bals.pol.toFixed(2);
  }

  // Bot status
  const status = await fetchJSON(API + "/bot-status");
  const el = document.getElementById("bot-status");
  if (status && status.trading_active) {
    el.textContent = "● Bot Online";
    el.className = "status";
  } else {
    el.textContent = "○ Bot Offline";
    el.className = "status offline";
  }

  // Open orders
  const orders = await fetchJSON(API + "/orders");
  const ordersTable = document.getElementById("orders-table");
  if (orders && orders.length > 0) {
    document.getElementById("open-orders").textContent = orders.length;
    ordersTable.innerHTML = orders.map(o => 
      '<tr><td>' + (o.market_slug || o.asset_id?.slice(0,12) + '...') + '</td>' +
      '<td class="' + o.side.toLowerCase() + '">' + o.side + '</td>' +
      '<td>' + o.price + '</td>' +
      '<td>' + o.original_size + '</td>' +
      '<td>' + o.size_matched + '</td>' +
      '<td>' + o.status + '</td></tr>'
    ).join('');
  } else {
    document.getElementById("open-orders").textContent = "0";
    ordersTable.innerHTML = '<tr><td colspan="6" class="empty">No open orders</td></tr>';
  }

  // Positions
  const positions = await fetchJSON(API + "/positions");
  const posTable = document.getElementById("positions-table");
  if (positions && positions.length > 0) {
    document.getElementById("positions-count").textContent = positions.length;
    posTable.innerHTML = positions.map(p => {
      const pnl = ((p.cur_price - p.avg_price) * p.size).toFixed(2);
      const pnlClass = pnl >= 0 ? 'buy' : 'sell';
      return '<tr><td>' + (p.title || p.market) + '</td>' +
        '<td>' + p.outcome + '</td>' +
        '<td>' + p.size + '</td>' +
        '<td>' + p.avg_price + '</td>' +
        '<td>' + (p.cur_price || '—') + '</td>' +
        '<td class="' + pnlClass + '">$' + pnl + '</td></tr>';
    }).join('');
  } else {
    document.getElementById("positions-count").textContent = "0";
    posTable.innerHTML = '<tr><td colspan="6" class="empty">No positions</td></tr>';
  }

  // Activity
  const activity = await fetchJSON(API + "/activity");
  const actTable = document.getElementById("activity-table");
  if (activity && activity.length > 0) {
    actTable.innerHTML = activity.map(a =>
      '<tr><td>' + new Date(a.timestamp * 1000).toLocaleString() + '</td>' +
      '<td>' + (a.title || a.market?.slice(0,16)) + '</td>' +
      '<td class="' + (a.side||'').toLowerCase() + '">' + (a.side||'') + '</td>' +
      '<td>' + (a.price||'') + '</td>' +
      '<td>' + (a.size||'') + '</td></tr>'
    ).join('');
  } else {
    actTable.innerHTML = '<tr><td colspan="5" class="empty">No activity yet</td></tr>';
  }
}

refresh();
setInterval(refresh, 30000); // Auto-refresh every 30s
</script>
</body>
</html>`;

async function fetchProxy(path) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const url = new URL(path.startsWith("http") ? path : `https://data-api.polymarket.com${path}`);
    https.get(url, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    }).on("error", reject);
  });
}

async function fetchRPC(method, params) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 });
    const req = https.request("https://1rpc.io/matic", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length } }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(null); } });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function handler(req, res) {
  // Auth check
  if (!checkAuth(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Stuart Dashboard"', "Content-Type": "text/plain" });
    return res.end("Unauthorized");
  }

  const path = req.url.split("?")[0];

  if (path === "/" || path === "") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(HTML);
  }

  res.setHeader("Content-Type", "application/json");

  try {
    if (path === "/api/balances") {
      // USDCe balance
      const usdceCall = await fetchRPC("eth_call", [{ to: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", data: "0x70a08231000000000000000000000000" + WALLET.slice(2).toLowerCase() }, "latest"]);
      const usdce = parseInt(usdceCall?.result || "0", 16) / 1e6;
      
      // POL balance
      const polCall = await fetchRPC("eth_getBalance", [WALLET, "latest"]);
      const pol = parseInt(polCall?.result || "0", 16) / 1e18;
      
      return send(res, 200, { usdce, pol });
    }

    if (path === "/api/bot-status") {
      try {
        const resp = await new Promise((resolve, reject) => {
          require("http").get("http://localhost:3001/api/status", r => {
            let d = ""; r.on("data", c => d += c);
            r.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
          }).on("error", () => resolve(null));
        });
        return send(res, 200, resp || { trading_active: false });
      } catch(e) { return send(res, 200, { trading_active: false }); }
    }

    if (path === "/api/orders") {
      const orders = await fetchProxy(`${PROXY}/orders`);
      return send(res, 200, orders || []);
    }

    if (path === "/api/positions") {
      const positions = await fetchProxy(`/positions?user=${WALLET}`);
      return send(res, 200, positions || []);
    }

    if (path === "/api/activity") {
      const activity = await fetchProxy(`/activity?user=${WALLET}&limit=20`);
      return send(res, 200, activity || []);
    }

    send(res, 404, { error: "Not found" });
  } catch(err) {
    send(res, 500, { error: err.message });
  }
}

function send(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

const server = http.createServer(handler);
server.listen(PORT, () => {
  console.log(\`Dashboard running on http://0.0.0.0:\${PORT}\`);
  console.log(\`Auth: \${USERNAME} / \${PASSWORD}\`);
});
