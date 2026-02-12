#!/usr/bin/env node
/**
 * Daily Brief Generator (v2 §cadence)
 * Generates and outputs a structured daily brief for Telegram
 * Run via cron or on-demand
 */

const http = require("http");

const FEED_URL = "http://localhost:3003";
const EXECUTOR_URL = "http://localhost:3002";
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
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timeStr = now.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit" });

  let feedStatus, prices, orders;
  
  try {
    feedStatus = await httpGet(`${FEED_URL}/status`);
    prices = await httpGet(`${FEED_URL}/prices`);
    orders = await httpGet(`${EXECUTOR_URL}/orders`);
  } catch (e) {
    console.log(`⚠️ Daily Brief ${dateStr}: Infrastructure partially down — ${e.message}`);
    process.exit(1);
  }

  const positions = Object.entries(prices.prices || {});
  let totalCost = 0;
  let totalValue = 0;
  let positionLines = [];

  for (const [id, p] of positions) {
    const cost = parseFloat(p.costBasis) || 0;
    const value = parseFloat(p.currentValue) || 0;
    totalCost += cost;
    totalValue += value;
    
    const pnlEmoji = parseFloat(p.pnl) >= 0 ? "🟢" : "🔴";
    positionLines.push(`${pnlEmoji} ${p.outcome} | ${p.size}sh @ ${p.avgPrice} → ${p.bid || "?"} | P&L: $${p.pnl || "?"} (${p.pnlPct || "?"})`);
  }

  const totalPnL = totalValue - totalCost;
  const openOrders = orders?.orders?.length || 0;

  // Risk status
  const risk = feedStatus.risk || {};
  let riskStatus = "🟢 NORMAL";
  if (risk.emergencyMode) riskStatus = "🚨 EMERGENCY — ALL TRADING HALTED";
  else if (risk.survivalMode) riskStatus = "⚠️ SURVIVAL MODE";
  else if (risk.circuitBreakerTripped) riskStatus = "🔴 CIRCUIT BREAKER — PAUSED";

  // Infrastructure
  const infra = feedStatus.infrastructure || {};
  const wsStatus = infra.wsConnected ? "✅" : "❌";

  const brief = `📋 DAILY BRIEF — ${dateStr} (${timeStr} PST)

💰 PORTFOLIO
Starting Capital: $${STARTING_CAPITAL}
Position Value: $${totalValue.toFixed(2)}
Open Orders: ${openOrders}
Total P&L: $${totalPnL.toFixed(2)} (${((totalPnL / STARTING_CAPITAL) * 100).toFixed(1)}%)

📊 POSITIONS (${positions.length})
${positionLines.join("\n")}

⚡ RISK STATUS: ${riskStatus}
Auto-Execute: ${risk.autoExecuteEnabled ? "ON" : "OFF"}
Daily Drawdown Limit: ${(risk.maxDailyDrawdown * 100)}%
Stop-Loss: ${(risk.defaultStopLoss * 100)}% | TP: ${(risk.defaultTakeProfit * 100)}%

🔧 INFRASTRUCTURE
Executor: ✅ | WS Feed: ${wsStatus} | Uptime: ${(infra.uptime / 3600).toFixed(1)}h
Tracked Assets: ${feedStatus.portfolio?.trackedPositions || 0}
Rate Limited: ${risk.rateLimitBackoff ? "⚠️ YES" : "No"}

📌 TODAY'S PRIORITIES
${generatePriorities(positions, risk)}`;

  console.log(brief);
}

function generatePriorities(positions, risk) {
  const priorities = [];
  const fs = require("fs");
  const path = require("path");
  
  // Risk-based priorities (highest urgency first)
  if (risk.emergencyMode) {
    priorities.push("• 🚨 EMERGENCY MODE — ALL trading halted, notify Micky immediately");
  }
  if (risk.survivalMode) {
    priorities.push("• ⚠️ SURVIVAL MODE — max 5% per position, proven strategies only");
  }
  if (risk.circuitBreakerTripped) {
    priorities.push("• 🔴 CIRCUIT BREAKER — review all positions, wait for auto-resume");
  }
  
  // Check for losing positions
  for (const [id, p] of positions) {
    const pnl = parseFloat(p.pnl);
    if (pnl < -5) priorities.push(`• 🔴 ${p.outcome}: losing $${Math.abs(pnl).toFixed(2)} — review thesis`);
  }

  // Capital deployment
  try {
    const state = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "TRADING-STATE.json"), "utf8"));
    const posArray = Array.isArray(state) ? state : state.positions || [];
    const totalDeployed = posArray.reduce((s, p) => s + (p.cost || 0), 0);
    const idlePct = ((STARTING_CAPITAL - totalDeployed) / STARTING_CAPITAL * 100).toFixed(0);
    if (idlePct > 30) {
      priorities.push(`• 💰 ${idlePct}% capital idle — deploy to reduce below 30%`);
    }
  } catch (e) {}

  // Standard operational
  priorities.push("• Scan for new opportunities (NegRisk arb, event-driven, news)");
  priorities.push("• Review open orders — cancel stale ones");
  priorities.push("• Check approaching resolutions — position ahead of outcome");
  
  if (!risk.autoExecuteEnabled) {
    priorities.push("• ⚠️ Auto-execute is OFF — re-enable or monitor manually");
  }

  return priorities.join("\n");
}

main().catch((err) => {
  console.error("Brief generation failed:", err.message);
  process.exit(1);
});
