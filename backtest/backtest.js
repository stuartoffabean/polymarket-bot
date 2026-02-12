#!/usr/bin/env node
/**
 * Polymarket Backtesting Framework (v2 §quant)
 * 
 * Simulates trading strategies against historical price data.
 * Uses Gamma API timeseries for historical prices.
 * 
 * Usage:
 *   node backtest.js --strategy mean-reversion --market <condition_id> --days 30
 *   node backtest.js --strategy arb-spread --days 7
 *   node backtest.js --audit  (reviews all past trades for lessons)
 * 
 * Strategies:
 *   - mean-reversion: Buy when price drops X% below MA, sell on recovery
 *   - momentum: Buy breakouts above resistance, sell on breakdown
 *   - arb-spread: Track NegRisk spread history, flag when spread > threshold
 *   - safe-yield: Buy high-probability outcomes (>90%) approaching resolution
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const GAMMA_API = "https://gamma-api.polymarket.com";
const PROXY = process.env.CLOB_PROXY_URL || "https://proxy-rosy-sigma-25.vercel.app";
const STARTING_CAPITAL = 433;
const RESULTS_DIR = path.join(__dirname, "results");

// === FETCH HELPERS ===
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : require("http");
    mod.get(url, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Parse error: ${data.slice(0, 100)}`)); }
      });
    }).on("error", reject);
  });
}

// === STRATEGIES ===
const strategies = {
  "mean-reversion": {
    name: "Mean Reversion",
    description: "Buy when price drops below moving average, sell on recovery",
    params: { maPeriod: 20, entryDeviation: -0.05, exitDeviation: 0.02, stopLoss: 0.15 },
    
    run(prices, params) {
      const { maPeriod, entryDeviation, exitDeviation, stopLoss } = params;
      const trades = [];
      let position = null;
      let capital = STARTING_CAPITAL;

      for (let i = maPeriod; i < prices.length; i++) {
        const window = prices.slice(i - maPeriod, i);
        const ma = window.reduce((s, p) => s + p.price, 0) / maPeriod;
        const deviation = (prices[i].price - ma) / ma;

        if (!position && deviation <= entryDeviation) {
          // Buy
          const size = Math.floor((capital * 0.15) / prices[i].price); // 15% max position
          if (size > 0) {
            position = { entry: prices[i].price, size, entryIdx: i, entryTime: prices[i].time };
            capital -= size * prices[i].price;
          }
        } else if (position) {
          const pnlPct = (prices[i].price - position.entry) / position.entry;
          
          // Take profit or stop loss
          if (pnlPct >= exitDeviation || pnlPct <= -stopLoss) {
            capital += position.size * prices[i].price;
            trades.push({
              entry: position.entry,
              exit: prices[i].price,
              size: position.size,
              pnl: (prices[i].price - position.entry) * position.size,
              pnlPct,
              entryTime: position.entryTime,
              exitTime: prices[i].time,
              reason: pnlPct >= exitDeviation ? "TAKE_PROFIT" : "STOP_LOSS",
            });
            position = null;
          }
        }
      }

      // Close open position at last price
      if (position) {
        const lastPrice = prices[prices.length - 1].price;
        capital += position.size * lastPrice;
        trades.push({
          entry: position.entry,
          exit: lastPrice,
          size: position.size,
          pnl: (lastPrice - position.entry) * position.size,
          pnlPct: (lastPrice - position.entry) / position.entry,
          entryTime: position.entryTime,
          exitTime: prices[prices.length - 1].time,
          reason: "END_OF_DATA",
        });
      }

      return { trades, finalCapital: capital };
    }
  },

  "safe-yield": {
    name: "Safe Yield (High Probability)",
    description: "Buy outcomes >90% probability, hold to resolution",
    params: { minProb: 0.90, maxPrice: 0.95, positionSize: 0.10 },

    run(prices, params) {
      const { minProb, maxPrice, positionSize } = params;
      const trades = [];
      let capital = STARTING_CAPITAL;
      let position = null;

      for (let i = 0; i < prices.length; i++) {
        if (!position && prices[i].price >= minProb && prices[i].price <= maxPrice) {
          const size = Math.floor((capital * positionSize) / prices[i].price);
          if (size > 0) {
            position = { entry: prices[i].price, size, entryIdx: i, entryTime: prices[i].time };
            capital -= size * prices[i].price;
          }
        }
      }

      // Simulate resolution at $1.00 (YES wins)
      if (position) {
        capital += position.size * 1.0;
        trades.push({
          entry: position.entry,
          exit: 1.0,
          size: position.size,
          pnl: (1.0 - position.entry) * position.size,
          pnlPct: (1.0 - position.entry) / position.entry,
          entryTime: position.entryTime,
          exitTime: "RESOLUTION",
          reason: "RESOLVED_YES",
        });
      }

      return { trades, finalCapital: capital };
    }
  },
};

// === TRADE AUDIT ===
async function auditTrades() {
  console.log("📋 TRADE AUDIT — Reviewing all past trades\n");
  
  const stateFile = path.join(__dirname, "..", "TRADING-STATE.json");
  let positions;
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    positions = Array.isArray(data) ? data : data.positions || [];
  } catch (e) {
    console.log("No TRADING-STATE.json found");
    return;
  }

  let totalCost = 0;
  let totalCurrentValue = 0;

  console.log("Position | Entry | Current | Size | Cost | P&L | P&L%");
  console.log("-".repeat(80));

  for (const p of positions) {
    try {
      const priceData = await fetchJSON(`${PROXY}/price?token_id=${p.tokenId}&side=buy`);
      const currentPrice = parseFloat(priceData?.price || p.entry);
      const cost = p.shares * p.entry;
      const value = p.shares * currentPrice;
      const pnl = value - cost;
      const pnlPct = ((currentPrice - p.entry) / p.entry * 100).toFixed(1);

      totalCost += cost;
      totalCurrentValue += value;

      console.log(
        `${p.market.padEnd(30)} | $${p.entry.toFixed(2)} | $${currentPrice.toFixed(2)} | ${p.shares} | $${cost.toFixed(2)} | $${pnl.toFixed(2)} | ${pnlPct}%`
      );
    } catch (e) {
      console.log(`${p.market.padEnd(30)} | ERROR: ${e.message}`);
    }
  }

  console.log("-".repeat(80));
  console.log(`Total Cost: $${totalCost.toFixed(2)} | Total Value: $${totalCurrentValue.toFixed(2)} | Total P&L: $${(totalCurrentValue - totalCost).toFixed(2)}`);
  console.log(`ROI: ${(((totalCurrentValue - totalCost) / totalCost) * 100).toFixed(2)}%`);
}

// === REPORT GENERATOR ===
function generateReport(strategyName, strategy, result, prices) {
  const { trades, finalCapital } = result;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const maxDrawdown = calculateMaxDrawdown(trades);

  const report = {
    strategy: strategyName,
    description: strategy.description,
    params: strategy.params,
    results: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) + "%" : "N/A",
      totalPnL: totalPnL.toFixed(2),
      avgWin: wins.length > 0 ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(2) : 0,
      avgLoss: losses.length > 0 ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(2) : 0,
      maxDrawdown: (maxDrawdown * 100).toFixed(1) + "%",
      finalCapital: finalCapital.toFixed(2),
      roi: (((finalCapital - STARTING_CAPITAL) / STARTING_CAPITAL) * 100).toFixed(2) + "%",
      sharpe: calculateSharpe(trades),
    },
    trades,
    generatedAt: new Date().toISOString(),
  };

  return report;
}

function calculateMaxDrawdown(trades) {
  let peak = STARTING_CAPITAL;
  let maxDD = 0;
  let equity = STARTING_CAPITAL;

  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function calculateSharpe(trades) {
  if (trades.length < 2) return "N/A";
  const returns = trades.map(t => t.pnlPct);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return "N/A";
  return (mean / std * Math.sqrt(252)).toFixed(2); // annualized
}

// === MAIN ===
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes("--audit")) {
    await auditTrades();
    return;
  }

  const strategyName = args[args.indexOf("--strategy") + 1] || "safe-yield";
  const strategy = strategies[strategyName];
  if (!strategy) {
    console.log(`Unknown strategy: ${strategyName}`);
    console.log(`Available: ${Object.keys(strategies).join(", ")}`);
    process.exit(1);
  }

  console.log(`📊 Backtesting: ${strategy.name}`);
  console.log(`Description: ${strategy.description}`);
  console.log(`Params: ${JSON.stringify(strategy.params)}`);
  console.log();

  // For now, generate synthetic price data (TODO: fetch from Gamma timeseries)
  // This demonstrates the framework structure
  const syntheticPrices = generateSyntheticPrices(100, 0.80, 0.05);
  const result = strategy.run(syntheticPrices, strategy.params);
  const report = generateReport(strategyName, strategy, result, syntheticPrices);

  console.log("=== RESULTS ===");
  console.log(JSON.stringify(report.results, null, 2));
  console.log();
  console.log(`Trades: ${report.trades.length}`);
  report.trades.forEach((t, i) => {
    console.log(`  #${i + 1}: ${t.reason} | Entry: $${t.entry.toFixed(3)} → Exit: $${t.exit.toFixed(3)} | P&L: $${t.pnl.toFixed(2)} (${(t.pnlPct * 100).toFixed(1)}%)`);
  });

  // Save report
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const reportFile = path.join(RESULTS_DIR, `${strategyName}-${Date.now()}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportFile}`);
}

function generateSyntheticPrices(n, startPrice, volatility) {
  const prices = [];
  let price = startPrice;
  const now = Date.now();
  
  for (let i = 0; i < n; i++) {
    price += (Math.random() - 0.48) * volatility; // slight upward bias
    price = Math.max(0.01, Math.min(0.99, price));
    prices.push({ price, time: new Date(now - (n - i) * 3600000).toISOString() });
  }
  return prices;
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
