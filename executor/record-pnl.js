#!/usr/bin/env node
/**
 * PnL Snapshot Recorder
 * Appends current portfolio value to pnl-history.json for charting
 * Run via cron every hour
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PNL_FILE = path.join(__dirname, "..", "pnl-history.json");
const STARTING_CAPITAL = 433;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function main() {
  const prices = await httpGet("http://localhost:3003/prices");
  
  let totalValue = 0;
  let totalCost = 0;
  const posDetails = [];

  for (const [id, p] of Object.entries(prices.prices || {})) {
    const value = parseFloat(p.currentValue) || 0;
    const cost = parseFloat(p.costBasis) || 0;
    totalValue += value;
    totalCost += cost;
    posDetails.push({ outcome: p.outcome, bid: p.bid, size: p.size, value, cost });
  }

  const snapshot = {
    timestamp: new Date().toISOString(),
    positionValue: totalValue,
    totalCost,
    pnl: totalValue - totalCost,
    pnlPct: totalCost > 0 ? ((totalValue - totalCost) / totalCost * 100) : 0,
    positions: posDetails.length,
    circuitBreakerTripped: prices.circuitBreakerTripped || false,
  };

  // Load existing history
  let history;
  try {
    history = JSON.parse(fs.readFileSync(PNL_FILE, "utf8"));
  } catch (e) {
    history = { startingCapital: STARTING_CAPITAL, points: [] };
  }

  history.points.push(snapshot);
  
  // Keep last 720 points (30 days at hourly)
  if (history.points.length > 720) {
    history.points = history.points.slice(-720);
  }

  fs.writeFileSync(PNL_FILE, JSON.stringify(history, null, 2));
  console.log(`PnL recorded: $${snapshot.pnl.toFixed(2)} (${snapshot.pnlPct.toFixed(1)}%) | ${snapshot.positions} positions | Value: $${totalValue.toFixed(2)}`);
}

main().catch(err => {
  console.error("PnL recording failed:", err.message);
  process.exit(1);
});
