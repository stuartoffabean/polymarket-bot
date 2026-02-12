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
  
  // Check for positions resolving soon
  // (would need resolution dates — for now, static priorities)
  priorities.push("• Monitor Bangladesh BNP resolution (voting today)");
  priorities.push("• Deploy idle capital if >30% uninvested");
  priorities.push("• Scan for new opportunities (NegRisk arb, event-driven)");
  
  if (risk.circuitBreakerTripped) {
    priorities.unshift("• 🔴 CIRCUIT BREAKER TRIPPED — review positions, wait for resume");
  }
  if (risk.survivalMode) {
    priorities.unshift("• ⚠️ SURVIVAL MODE — max 5% per position, proven strategies only");
  }

  return priorities.join("\n");
}

main().catch((err) => {
  console.error("Brief generation failed:", err.message);
  process.exit(1);
});
