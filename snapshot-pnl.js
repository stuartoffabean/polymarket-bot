#!/usr/bin/env node
// Records a P&L snapshot to pnl-history.json
// Run periodically via cron to build chart data

const fs = require('fs');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, 'pnl-history.json');
const STATE_PATH = path.join(__dirname, 'TRADING-STATE.json');
const STARTING = 496;
const MAX_POINTS = 2880; // 10 days at 5-min intervals

async function main() {
  // Read current state
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch(e) {}
  
  // Get wallet balance
  let liquid = state.liquidBalance || 0;
  try {
    const addr = 'e693Ef449979E387C8B4B5071Af9e27a7742E18D';
    const data = `0x70a08231000000000000000000000000${addr}`;
    const res = await fetch('https://polygon-rpc.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', data }, 'latest'], id: 1 })
    });
    const json = await res.json();
    liquid = parseInt(json.result, 16) / 1e6;
  } catch(e) {}

  // Get position values
  let positionValue = 0;
  try {
    const posRes = await fetch('http://localhost:3002/positions');
    const posData = await posRes.json();
    for (const p of posData.positions || []) {
      // Use cost basis as conservative value (mark-to-market would need current prices)
      positionValue += p.totalCost || 0;
    }
  } catch(e) {}

  const total = liquid + positionValue;
  const pnl = total - STARTING;

  // Read existing history
  let history = { points: [], startingCapital: STARTING };
  try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch(e) {}

  // Add new point
  history.points.push({
    ts: Date.now(),
    time: new Date().toISOString(),
    liquid: +liquid.toFixed(2),
    positions: +positionValue.toFixed(2),
    total: +total.toFixed(2),
    pnl: +pnl.toFixed(2),
    value: +total.toFixed(2) // for chart
  });

  // Trim
  if (history.points.length > MAX_POINTS) {
    history.points = history.points.slice(-MAX_POINTS);
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.log(`Snapshot: liquid=$${liquid.toFixed(2)} positions=$${positionValue.toFixed(2)} total=$${total.toFixed(2)} pnl=$${pnl.toFixed(2)}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
