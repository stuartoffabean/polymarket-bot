#!/usr/bin/env node
/**
 * Trade Performance Reporter v1.0
 * 
 * Generates comprehensive performance reports from all data sources:
 * - /trade-ledger (executor) — full on-chain trade history
 * - /prices (ws-feed) — current positions + unrealized P&L
 * - resolved-positions.json — resolution P&L
 * - strategy-tags.json — strategy attribution
 * - fill-stats.json — fill rates per strategy
 * - pnl-history.json — portfolio snapshots over time
 * 
 * Outputs:
 * - STRATEGY-TRACKER.json (workspace root + polymarket-bot/)
 * - TRADES.md (workspace root)
 * - Telegram daily report
 * - daily-reports/<date>.json snapshot
 * 
 * Usage:
 *   node trade-reporter.js              # Full report + Telegram
 *   node trade-reporter.js --no-telegram # Report only, no Telegram
 *   node trade-reporter.js --json       # JSON output only
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const EXECUTOR_URL = "http://localhost:3002";
const FEED_URL = "http://localhost:3003";
const BOT_DIR = path.join(__dirname, "..");
const WORKSPACE_DIR = path.join(__dirname, "..", "..");

// Telegram config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Files
const STRATEGY_TAGS_FILE = path.join(BOT_DIR, "strategy-tags.json");
const RESOLVED_FILE = path.join(BOT_DIR, "resolved-positions.json");
const FILL_STATS_FILE = path.join(BOT_DIR, "fill-stats.json");
const PNL_HISTORY_FILE = path.join(BOT_DIR, "pnl-history.json");
const MARKET_NAMES_FILE = path.join(__dirname, "market-names.json");
const REPORTS_DIR = path.join(BOT_DIR, "daily-reports");

// Ensure reports dir exists
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// === HTTP HELPERS ===
function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error from ${url}: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function loadJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, "utf8")); }
  catch { return null; }
}

// === DATA COLLECTION ===
async function collectData() {
  const data = {};

  // 1. Trade ledger from executor
  try {
    data.tradeLedger = await httpGet(`${EXECUTOR_URL}/trade-ledger`);
  } catch (e) {
    console.error(`[REPORTER] Failed to fetch trade ledger: ${e.message}`);
    data.tradeLedger = null;
  }

  // 2. Live prices from ws-feed
  try {
    data.prices = await httpGet(`${FEED_URL}/prices`);
  } catch (e) {
    console.error(`[REPORTER] Failed to fetch prices: ${e.message}`);
    data.prices = null;
  }

  // 3. Full status from ws-feed
  try {
    data.status = await httpGet(`${FEED_URL}/status`);
  } catch (e) {
    console.error(`[REPORTER] Failed to fetch status: ${e.message}`);
    data.status = null;
  }

  // 4. Local files
  data.strategyTags = loadJSON(STRATEGY_TAGS_FILE) || {};
  data.resolved = loadJSON(RESOLVED_FILE) || {};
  data.fillStats = loadJSON(FILL_STATS_FILE) || {};
  data.pnlHistory = loadJSON(PNL_HISTORY_FILE) || { points: [] };
  data.marketNames = loadJSON(MARKET_NAMES_FILE) || {};

  return data;
}

// === ANALYSIS ===
function analyzePerformance(data) {
  const result = {
    timestamp: new Date().toISOString(),
    portfolio: {},
    strategies: {},
    openPositions: [],
    closedPositions: [],
    dailyPnl: {},
    summary: {},
  };

  // --- Portfolio overview ---
  if (data.prices) {
    result.portfolio = {
      totalValue: data.prices.portfolioValue || 0,
      positionValue: data.prices.positionValue || 0,
      cashBalance: data.prices.cashBalance || 0,
      trackedPositions: Object.keys(data.prices.prices || {}).length,
      idlePct: data.prices.cashBalance && data.prices.portfolioValue
        ? ((data.prices.cashBalance / data.prices.portfolioValue) * 100).toFixed(1)
        : "?",
    };
  }

  // --- Strategy scorecards ---
  const stratScores = {};
  function getOrCreateStrategy(name) {
    if (!stratScores[name]) {
      stratScores[name] = {
        name,
        totalTrades: 0,
        openPositions: 0,
        closedPositions: 0,
        wins: 0,
        losses: 0,
        breakeven: 0,
        totalDeployed: 0,
        currentDeployed: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalPnl: 0,
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        avgHoldHours: 0,
        bestTrade: null,
        worstTrade: null,
        trades: [],
      };
    }
    return stratScores[name];
  }

  // --- Process trade ledger (closed positions from on-chain data) ---
  if (data.tradeLedger) {
    const closed = data.tradeLedger.closedPositions || [];
    for (const pos of closed) {
      const stratTag = data.strategyTags[pos.asset_id];
      const stratName = stratTag?.strategy || "unknown";
      const strat = getOrCreateStrategy(stratName);

      const pnl = parseFloat(pos.realizedPnl) || 0;
      const cost = parseFloat(pos.totalCost) || 0;

      strat.closedPositions++;
      strat.totalTrades++;
      strat.realizedPnl += pnl;
      strat.totalDeployed += cost;

      if (pnl > 0.01) strat.wins++;
      else if (pnl < -0.01) strat.losses++;
      else strat.breakeven++;

      // Hold time
      if (pos.firstBuy && pos.lastTrade) {
        const holdMs = new Date(pos.lastTrade) - new Date(pos.firstBuy);
        const holdHours = holdMs / (1000 * 60 * 60);
        strat.trades.push({ market: pos.market, pnl, cost, holdHours, status: pos.status });
      } else {
        strat.trades.push({ market: pos.market, pnl, cost, holdHours: null, status: pos.status });
      }

      if (!strat.bestTrade || pnl > strat.bestTrade.pnl) {
        strat.bestTrade = { market: pos.market, pnl, pnlPct: pos.realizedPnlPct };
      }
      if (!strat.worstTrade || pnl < strat.worstTrade.pnl) {
        strat.worstTrade = { market: pos.market, pnl, pnlPct: pos.realizedPnlPct };
      }

      result.closedPositions.push({
        market: pos.market,
        outcome: pos.outcome,
        strategy: stratName,
        size: pos.totalBought,
        avgBuyPrice: pos.avgBuyPrice,
        avgSellPrice: pos.avgSellPrice,
        costBasis: pos.totalCost,
        proceeds: pos.totalProceeds,
        realizedPnl: pos.realizedPnl,
        realizedPnlPct: pos.realizedPnlPct,
        status: pos.status,
        firstBuy: pos.firstBuy,
        lastTrade: pos.lastTrade,
      });
    }

    // Also process open positions from trade ledger
    const open = data.tradeLedger.openPositions || [];
    for (const pos of open) {
      const stratTag = data.strategyTags[pos.asset_id];
      const stratName = stratTag?.strategy || "unknown";
      const strat = getOrCreateStrategy(stratName);

      strat.openPositions++;
      strat.totalTrades++;
      strat.currentDeployed += parseFloat(pos.costBasis) || 0;
    }
  }

  // --- Process live prices for unrealized P&L ---
  if (data.prices?.prices) {
    for (const [id, pos] of Object.entries(data.prices.prices)) {
      const stratTag = data.strategyTags[id] || data.strategyTags[pos.fullAssetId];
      const stratName = pos.strategy !== "unknown" ? pos.strategy : (stratTag?.strategy || "unknown");
      const strat = getOrCreateStrategy(stratName);

      const unrealized = parseFloat(pos.pnl) || 0;
      strat.unrealizedPnl += unrealized;

      // Resolve market name
      const marketName = stratTag?.market
        || data.marketNames[id]
        || data.marketNames[pos.fullAssetId]
        || `${pos.outcome} @ ${pos.avgPrice}`;

      result.openPositions.push({
        market: marketName,
        outcome: pos.outcome,
        strategy: stratName,
        size: pos.size,
        avgPrice: pos.avgPrice,
        currentBid: pos.bid,
        costBasis: pos.costBasis,
        currentValue: pos.currentValue,
        pnl: pos.pnl,
        pnlPct: pos.pnlPct,
      });
    }
  }

  // --- Resolved positions (markets that resolved, not sold on CLOB) ---
  for (const [assetId, res] of Object.entries(data.resolved)) {
    const stratTag = data.strategyTags[assetId];
    const stratName = stratTag?.strategy || "unknown";
    const strat = getOrCreateStrategy(stratName);

    // Only count if not already counted in trade ledger
    const alreadyCounted = result.closedPositions.some(
      cp => cp.market === res.market && cp.status?.includes("RESOLVED")
    );
    if (!alreadyCounted) {
      strat.closedPositions++;
      strat.totalTrades++;
      strat.realizedPnl += res.realizedPnl;
      strat.totalDeployed += res.costBasis;

      if (res.realizedPnl > 0.01) strat.wins++;
      else if (res.realizedPnl < -0.01) strat.losses++;
      else strat.breakeven++;

      result.closedPositions.push({
        market: res.market,
        outcome: res.outcome,
        strategy: stratName,
        size: res.size,
        avgBuyPrice: res.avgPrice?.toFixed(4),
        avgSellPrice: res.won ? "1.0000" : "0.0000",
        costBasis: res.costBasis?.toFixed(2),
        proceeds: res.payout?.toFixed(2),
        realizedPnl: res.realizedPnl?.toFixed(2),
        realizedPnlPct: res.costBasis > 0 ? ((res.realizedPnl / res.costBasis) * 100).toFixed(1) : "0",
        status: res.won ? "RESOLVED_WON" : "RESOLVED_LOST",
        firstBuy: null,
        lastTrade: res.resolvedAt,
      });
    }
  }

  // --- Finalize strategy scorecards ---
  for (const strat of Object.values(stratScores)) {
    strat.totalPnl = parseFloat((strat.realizedPnl + strat.unrealizedPnl).toFixed(2));
    strat.realizedPnl = parseFloat(strat.realizedPnl.toFixed(2));
    strat.unrealizedPnl = parseFloat(strat.unrealizedPnl.toFixed(2));

    const totalClosed = strat.wins + strat.losses + strat.breakeven;
    strat.winRate = totalClosed > 0 ? parseFloat(((strat.wins / totalClosed) * 100).toFixed(1)) : 0;

    // Average win/loss from trades
    const winTrades = strat.trades.filter(t => t.pnl > 0.01);
    const lossTrades = strat.trades.filter(t => t.pnl < -0.01);
    strat.avgWin = winTrades.length > 0 ? parseFloat((winTrades.reduce((s, t) => s + t.pnl, 0) / winTrades.length).toFixed(2)) : 0;
    strat.avgLoss = lossTrades.length > 0 ? parseFloat((lossTrades.reduce((s, t) => s + t.pnl, 0) / lossTrades.length).toFixed(2)) : 0;

    // Average hold time
    const holdTimes = strat.trades.filter(t => t.holdHours != null).map(t => t.holdHours);
    strat.avgHoldHours = holdTimes.length > 0 ? parseFloat((holdTimes.reduce((s, h) => s + h, 0) / holdTimes.length).toFixed(1)) : 0;

    // Expectancy (expected value per trade)
    if (totalClosed > 0) {
      strat.expectancy = parseFloat((strat.realizedPnl / totalClosed).toFixed(2));
    } else {
      strat.expectancy = 0;
    }

    // Profit factor
    const grossWins = winTrades.reduce((s, t) => s + t.pnl, 0);
    const grossLosses = Math.abs(lossTrades.reduce((s, t) => s + t.pnl, 0));
    strat.profitFactor = grossLosses > 0 ? parseFloat((grossWins / grossLosses).toFixed(2)) : grossWins > 0 ? Infinity : 0;

    // Don't include internal trades array in output
    delete strat.trades;
  }
  result.strategies = stratScores;

  // --- Daily P&L from history ---
  if (data.pnlHistory?.points?.length > 0) {
    const points = data.pnlHistory.points;
    const byDate = {};
    for (const p of points) {
      const date = p.timestamp.split("T")[0];
      if (!byDate[date]) byDate[date] = { first: p, last: p };
      byDate[date].last = p;
    }

    for (const [date, { first, last }] of Object.entries(byDate)) {
      const startVal = first.positionValue + (first.liquidBalance || 0);
      const endVal = last.positionValue + (last.liquidBalance || 0);
      result.dailyPnl[date] = {
        date,
        startPositionValue: first.positionValue,
        endPositionValue: last.positionValue,
        change: parseFloat((endVal - startVal).toFixed(2)),
        changePct: startVal > 0 ? parseFloat(((endVal - startVal) / startVal * 100).toFixed(2)) : 0,
        snapshots: Object.keys(byDate[date]).length,
      };
    }
  }

  // --- Summary ---
  const allStrats = Object.values(stratScores);
  result.summary = {
    totalRealizedPnl: parseFloat(allStrats.reduce((s, st) => s + st.realizedPnl, 0).toFixed(2)),
    totalUnrealizedPnl: parseFloat(allStrats.reduce((s, st) => s + st.unrealizedPnl, 0).toFixed(2)),
    totalPnl: parseFloat(allStrats.reduce((s, st) => s + st.totalPnl, 0).toFixed(2)),
    totalTrades: allStrats.reduce((s, st) => s + st.totalTrades, 0),
    totalWins: allStrats.reduce((s, st) => s + st.wins, 0),
    totalLosses: allStrats.reduce((s, st) => s + st.losses, 0),
    overallWinRate: (() => {
      const total = allStrats.reduce((s, st) => s + st.wins + st.losses + st.breakeven, 0);
      const wins = allStrats.reduce((s, st) => s + st.wins, 0);
      return total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0;
    })(),
    portfolioValue: result.portfolio.totalValue,
    cashBalance: result.portfolio.cashBalance,
    idlePct: result.portfolio.idlePct,
    activeStrategies: allStrats.filter(s => s.openPositions > 0 || s.closedPositions > 0).length,
    fillStats: data.fillStats,
  };

  return result;
}

// === OUTPUT GENERATORS ===

function generateStrategyTracker(analysis) {
  const tracker = {
    lastUpdated: analysis.timestamp,
    generatedBy: "trade-reporter.js v1.0",
    portfolio: analysis.portfolio,
    summary: analysis.summary,
    strategies: {},
  };

  for (const [name, strat] of Object.entries(analysis.strategies)) {
    tracker.strategies[name] = {
      status: strat.openPositions > 0 ? "ACTIVE" : strat.closedPositions > 0 ? "COMPLETED" : "INACTIVE",
      totalTrades: strat.totalTrades,
      openPositions: strat.openPositions,
      closedPositions: strat.closedPositions,
      wins: strat.wins,
      losses: strat.losses,
      winRate: strat.winRate + "%",
      realizedPnl: "$" + strat.realizedPnl.toFixed(2),
      unrealizedPnl: "$" + strat.unrealizedPnl.toFixed(2),
      totalPnl: "$" + strat.totalPnl.toFixed(2),
      totalDeployed: "$" + strat.totalDeployed.toFixed(2),
      currentDeployed: "$" + strat.currentDeployed.toFixed(2),
      expectancy: "$" + strat.expectancy.toFixed(2),
      profitFactor: strat.profitFactor === Infinity ? "∞" : strat.profitFactor.toFixed(2),
      avgWin: "$" + strat.avgWin.toFixed(2),
      avgLoss: "$" + strat.avgLoss.toFixed(2),
      avgHoldHours: strat.avgHoldHours,
      bestTrade: strat.bestTrade,
      worstTrade: strat.worstTrade,
    };
  }

  return tracker;
}

function generateTradesMd(analysis) {
  const lines = [];
  lines.push("# TRADES.md — Stuart Trade Ledger");
  lines.push("");
  lines.push(`Last updated: ${new Date().toISOString()}`);
  lines.push(`Generated by: trade-reporter.js v1.0`);
  lines.push("");

  // Summary
  lines.push("## Portfolio Summary");
  lines.push(`- **Total Value:** $${analysis.portfolio.totalValue?.toFixed(2) || "?"}`);
  lines.push(`- **Cash:** $${analysis.portfolio.cashBalance?.toFixed(2) || "?"} (${analysis.portfolio.idlePct}% idle)`);
  lines.push(`- **Positions:** $${analysis.portfolio.positionValue?.toFixed(2) || "?"} (${analysis.portfolio.trackedPositions} tracked)`);
  lines.push(`- **Realized P&L:** $${analysis.summary.totalRealizedPnl?.toFixed(2)}`);
  lines.push(`- **Unrealized P&L:** $${analysis.summary.totalUnrealizedPnl?.toFixed(2)}`);
  lines.push(`- **Total P&L:** $${analysis.summary.totalPnl?.toFixed(2)}`);
  lines.push(`- **Win Rate:** ${analysis.summary.overallWinRate}% (${analysis.summary.totalWins}W / ${analysis.summary.totalLosses}L)`);
  lines.push("");

  // Strategy breakdown
  lines.push("## Strategy Breakdown");
  lines.push("");
  lines.push("| Strategy | Trades | W/L | Win% | Realized | Unrealized | Total P&L | Expectancy |");
  lines.push("|----------|--------|-----|------|----------|------------|-----------|------------|");

  const sortedStrats = Object.entries(analysis.strategies)
    .sort(([, a], [, b]) => b.totalPnl - a.totalPnl);

  for (const [name, strat] of sortedStrats) {
    const wl = `${strat.wins}/${strat.losses}`;
    lines.push(`| ${name} | ${strat.totalTrades} | ${wl} | ${strat.winRate}% | $${strat.realizedPnl.toFixed(2)} | $${strat.unrealizedPnl.toFixed(2)} | $${strat.totalPnl.toFixed(2)} | $${strat.expectancy.toFixed(2)} |`);
  }
  lines.push("");

  // Open positions
  if (analysis.openPositions.length > 0) {
    lines.push("## Open Positions");
    lines.push("");
    lines.push("| Market | Strategy | Side | Size | Entry | Current | P&L | P&L% |");
    lines.push("|--------|----------|------|------|-------|---------|-----|------|");

    const sorted = [...analysis.openPositions].sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
    for (const pos of sorted) {
      const marketShort = (pos.market || "?").slice(0, 45);
      const emoji = parseFloat(pos.pnl) >= 0 ? "🟢" : "🔴";
      lines.push(`| ${marketShort} | ${pos.strategy} | ${pos.outcome} | ${pos.size} | ${pos.avgPrice} | ${pos.currentBid} | ${emoji} $${pos.pnl} | ${pos.pnlPct} |`);
    }
    lines.push("");
  }

  // Closed positions
  if (analysis.closedPositions.length > 0) {
    lines.push("## Closed Positions");
    lines.push("");
    lines.push("| Market | Strategy | Status | Cost | Proceeds | P&L | P&L% |");
    lines.push("|--------|----------|--------|------|----------|-----|------|");

    const sorted = [...analysis.closedPositions].sort((a, b) => {
      const dateA = a.lastTrade ? new Date(a.lastTrade) : new Date(0);
      const dateB = b.lastTrade ? new Date(b.lastTrade) : new Date(0);
      return dateB - dateA;
    });
    for (const pos of sorted) {
      const marketShort = (pos.market || "?").slice(0, 45);
      const emoji = parseFloat(pos.realizedPnl) >= 0 ? "✅" : "❌";
      lines.push(`| ${marketShort} | ${pos.strategy} | ${emoji} ${pos.status} | $${pos.costBasis} | $${pos.proceeds} | $${pos.realizedPnl} | ${pos.realizedPnlPct}% |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function generateTelegramReport(analysis) {
  const s = analysis.summary;
  const p = analysis.portfolio;

  let msg = `📊 <b>STUART DAILY PERFORMANCE REPORT</b>\n`;
  msg += `${new Date().toISOString().split("T")[0]}\n\n`;

  // Portfolio
  msg += `💰 <b>Portfolio:</b> $${p.totalValue?.toFixed(2) || "?"}\n`;
  msg += `Cash: $${p.cashBalance?.toFixed(2)} (${p.idlePct}% idle)\n`;
  msg += `Positions: $${p.positionValue?.toFixed(2)} (${p.trackedPositions} active)\n\n`;

  // P&L
  const totalEmoji = s.totalPnl >= 0 ? "🟢" : "🔴";
  msg += `${totalEmoji} <b>Total P&L:</b> $${s.totalPnl?.toFixed(2)}\n`;
  msg += `Realized: $${s.totalRealizedPnl?.toFixed(2)} | Unrealized: $${s.totalUnrealizedPnl?.toFixed(2)}\n`;
  msg += `Win Rate: ${s.overallWinRate}% (${s.totalWins}W / ${s.totalLosses}L)\n\n`;

  // Strategy breakdown
  msg += `📈 <b>By Strategy:</b>\n`;
  const sortedStrats = Object.entries(analysis.strategies)
    .sort(([, a], [, b]) => b.totalPnl - a.totalPnl);

  for (const [name, strat] of sortedStrats) {
    const emoji = strat.totalPnl >= 0 ? "🟢" : "🔴";
    msg += `${emoji} ${name}: $${strat.totalPnl.toFixed(2)} (${strat.totalTrades} trades, ${strat.winRate}% WR)\n`;
  }

  // Top winners/losers
  const allOpen = analysis.openPositions;
  if (allOpen.length > 0) {
    msg += `\n🏆 <b>Top Positions:</b>\n`;
    const sorted = [...allOpen].sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
    const top3 = sorted.slice(0, 3);
    for (const pos of top3) {
      const emoji = parseFloat(pos.pnl) >= 0 ? "📈" : "📉";
      const name = (pos.market || "?").slice(0, 35);
      msg += `${emoji} ${name}: $${pos.pnl} (${pos.pnlPct})\n`;
    }
  }

  // Fill stats
  if (s.fillStats && Object.keys(s.fillStats).length > 0) {
    msg += `\n🔧 <b>Fill Rates:</b>\n`;
    for (const [strat, stats] of Object.entries(s.fillStats)) {
      if (stats.submitted > 0) {
        const rate = ((stats.filled / stats.submitted) * 100).toFixed(0);
        msg += `${strat}: ${stats.filled}/${stats.submitted} (${rate}%)\n`;
      }
    }
  }

  return msg;
}

// === TELEGRAM ===
function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[REPORTER] Telegram not configured — skipping send");
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log("[REPORTER] Telegram report sent ✅");
          resolve();
        } else {
          console.error(`[REPORTER] Telegram send failed: ${res.statusCode} ${data}`);
          reject(new Error(`Telegram ${res.statusCode}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// === MAIN ===
async function main() {
  const args = process.argv.slice(2);
  const noTelegram = args.includes("--no-telegram");
  const jsonOnly = args.includes("--json");

  console.log("[REPORTER] Collecting data from all sources...");
  const data = await collectData();

  console.log("[REPORTER] Analyzing performance...");
  const analysis = analyzePerformance(data);

  if (jsonOnly) {
    console.log(JSON.stringify(analysis, null, 2));
    return analysis;
  }

  // Generate STRATEGY-TRACKER.json
  const tracker = generateStrategyTracker(analysis);
  const trackerJson = JSON.stringify(tracker, null, 2);

  // Write to both locations
  fs.writeFileSync(path.join(BOT_DIR, "STRATEGY-TRACKER.json"), trackerJson);
  fs.writeFileSync(path.join(WORKSPACE_DIR, "STRATEGY-TRACKER.json"), trackerJson);
  console.log("[REPORTER] ✅ STRATEGY-TRACKER.json written");

  // Generate TRADES.md
  const tradesMd = generateTradesMd(analysis);
  fs.writeFileSync(path.join(WORKSPACE_DIR, "TRADES.md"), tradesMd);
  console.log("[REPORTER] ✅ TRADES.md written");

  // Save daily snapshot
  const dateStr = new Date().toISOString().split("T")[0];
  const snapshotPath = path.join(REPORTS_DIR, `${dateStr}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(analysis, null, 2));
  console.log(`[REPORTER] ✅ Daily snapshot saved to ${snapshotPath}`);

  // Telegram report
  if (!noTelegram) {
    const telegramMsg = generateTelegramReport(analysis);
    try {
      await sendTelegram(telegramMsg);
    } catch (e) {
      console.error(`[REPORTER] Telegram send failed: ${e.message}`);
    }
  }

  // Console summary
  console.log("\n=== PERFORMANCE SUMMARY ===");
  console.log(`Portfolio: $${analysis.portfolio.totalValue?.toFixed(2)} (${analysis.portfolio.idlePct}% idle)`);
  console.log(`Total P&L: $${analysis.summary.totalPnl?.toFixed(2)} (Realized: $${analysis.summary.totalRealizedPnl?.toFixed(2)}, Unrealized: $${analysis.summary.totalUnrealizedPnl?.toFixed(2)})`);
  console.log(`Win Rate: ${analysis.summary.overallWinRate}% (${analysis.summary.totalWins}W / ${analysis.summary.totalLosses}L / ${analysis.summary.totalTrades} total)`);
  console.log(`Active Strategies: ${analysis.summary.activeStrategies}`);
  console.log("");
  for (const [name, strat] of Object.entries(analysis.strategies)) {
    console.log(`  ${name}: P&L=$${strat.totalPnl.toFixed(2)}, WR=${strat.winRate}%, ${strat.totalTrades} trades`);
  }

  return analysis;
}

// Export for use as module
module.exports = { collectData, analyzePerformance, generateStrategyTracker, generateTradesMd, generateTelegramReport, main };

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error("[REPORTER] Fatal error:", err);
    process.exit(1);
  });
}
