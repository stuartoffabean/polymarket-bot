#!/usr/bin/env node
/**
 * PnL Snapshot Recorder
 * Fetches live prices from CLOB for all positions and records to pnl-history.json
 * Run via cron every 15 min
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const PNL_FILE = path.join(__dirname, "..", "pnl-history.json");
const SNAPSHOT_FILE = path.join(__dirname, "..", "live-snapshot.json");
const PROXY = "https://proxy-rosy-sigma-25.vercel.app";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function getLivePrice(tokenId) {
  try {
    const r = await httpsGet(`${PROXY}/price?token_id=${tokenId}&side=buy`);
    return parseFloat(r.price) || 0;
  } catch { return 0; }
}

async function main() {
  // Read snapshot for position data (trades have all 5 positions with tokenIds)
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  } catch (e) {
    console.error("No snapshot file, skipping");
    process.exit(0);
  }

  const trades = snap.trades || [];
  if (trades.length === 0) {
    console.log("No trades in snapshot, skipping");
    process.exit(0);
  }

  // Fetch live prices for all positions
  let totalValue = 0;
  let totalCost = 0;
  const details = [];

  for (const t of trades) {
    if (!t.tokenId) continue;
    const bid = await getLivePrice(t.tokenId);
    const shares = parseInt(t.shares) || 0;
    const cost = parseFloat(t.size) || 0;
    const value = shares * bid;
    totalValue += value;
    totalCost += cost;
    details.push({ market: t.market, bid, shares, value: +value.toFixed(2), cost });
  }

  const snapshot = {
    timestamp: new Date().toISOString(),
    positionValue: +totalValue.toFixed(2),
    totalCost: +totalCost.toFixed(2),
    pnl: +(totalValue - totalCost).toFixed(2),
    pnlPct: totalCost > 0 ? +((totalValue - totalCost) / totalCost * 100).toFixed(2) : 0,
    positions: details.length,
  };

  // Load existing history
  let history;
  try {
    history = JSON.parse(fs.readFileSync(PNL_FILE, "utf8"));
  } catch {
    history = { startingCapital: 433, points: [] };
  }

  history.points.push(snapshot);

  // Keep last 2880 points (~30 days at 15min intervals)
  if (history.points.length > 2880) {
    history.points = history.points.slice(-2880);
  }

  fs.writeFileSync(PNL_FILE, JSON.stringify(history, null, 2));
  console.log(`PnL: ${snapshot.pnl >= 0 ? '+' : ''}$${snapshot.pnl} (${snapshot.pnlPct}%) | ${snapshot.positions} positions | Value: $${snapshot.positionValue}`);
}

main().catch(err => {
  console.error("PnL recording failed:", err.message);
  process.exit(1);
});
