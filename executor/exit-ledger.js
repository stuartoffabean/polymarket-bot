/**
 * EXIT LEDGER — Pattern 2 Fix: Every exit must be logged with reason
 * 
 * Captures: timestamp, assetId, market name, reason, entry price, exit price,
 * size, cost basis, proceeds, realized P&L, trigger source, and notes.
 * 
 * Used by: ws-feed (auto SL/TP), executor (/market-sell), resolution detection
 */

const fs = require("fs");
const path = require("path");

const LEDGER_FILE = path.join(__dirname, "..", "exit-ledger.json");

// Valid exit reasons
const EXIT_REASONS = {
  STOP_LOSS: "stop_loss",
  TAKE_PROFIT: "take_profit",
  MANUAL_SELL: "manual_sell",       // pm_sell or /market-sell
  RESOLUTION_WON: "resolution_won",
  RESOLUTION_LOST: "resolution_lost",
  TIME_STOP: "time_stop",
  THESIS_INVALIDATED: "thesis_invalidated",
  EMERGENCY: "emergency",
  UNKNOWN: "unknown",
};

function loadLedger() {
  try {
    if (fs.existsSync(LEDGER_FILE)) {
      return JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    }
  } catch (e) {
    console.log(`[EXIT-LEDGER] Failed to load: ${e.message}`);
  }
  return [];
}

function saveLedger(entries) {
  try {
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(entries, null, 2));
  } catch (e) {
    console.log(`[EXIT-LEDGER] Failed to save: ${e.message}`);
  }
}

/**
 * Log an exit to the ledger
 * @param {Object} params
 * @param {string} params.assetId - Full token/asset ID
 * @param {string} params.market - Human-readable market name
 * @param {string} params.outcome - YES/NO
 * @param {string} params.reason - One of EXIT_REASONS
 * @param {string} params.triggerSource - 'ws-feed-auto'|'executor-manual'|'resolution-detection'|'mcp-pm_sell'
 * @param {number} params.entryPrice - Average entry price
 * @param {number} params.exitPrice - Price at exit (or payout price for resolution)
 * @param {number} params.size - Number of shares
 * @param {number} params.costBasis - Total cost (entryPrice * size)
 * @param {number} params.proceeds - Total proceeds (exitPrice * size, or payout)
 * @param {number} params.realizedPnl - proceeds - costBasis
 * @param {string} [params.strategy] - Strategy tag if known
 * @param {string} [params.notes] - Additional context
 */
function logExit(params) {
  const entry = {
    timestamp: new Date().toISOString(),
    assetId: params.assetId,
    market: params.market || "Unknown",
    outcome: params.outcome || "Unknown",
    reason: params.reason || EXIT_REASONS.UNKNOWN,
    triggerSource: params.triggerSource || "unknown",
    entryPrice: params.entryPrice || 0,
    exitPrice: params.exitPrice || 0,
    size: params.size || 0,
    costBasis: parseFloat((params.costBasis || 0).toFixed(4)),
    proceeds: parseFloat((params.proceeds || 0).toFixed(4)),
    realizedPnl: parseFloat((params.realizedPnl || 0).toFixed(4)),
    pnlPct: params.costBasis > 0 
      ? parseFloat(((params.realizedPnl / params.costBasis) * 100).toFixed(2))
      : 0,
    strategy: params.strategy || "unknown",
    notes: params.notes || "",
  };

  const ledger = loadLedger();
  ledger.push(entry);
  saveLedger(ledger);

  console.log(`[EXIT-LEDGER] ${entry.reason} | ${entry.market} | ${entry.size} shares | P&L: $${entry.realizedPnl} (${entry.pnlPct}%) | Source: ${entry.triggerSource}`);
  
  return entry;
}

/**
 * Get recent exits, optionally filtered
 */
function getExits(opts = {}) {
  const ledger = loadLedger();
  let filtered = ledger;
  
  if (opts.reason) filtered = filtered.filter(e => e.reason === opts.reason);
  if (opts.strategy) filtered = filtered.filter(e => e.strategy === opts.strategy);
  if (opts.since) {
    const sinceDate = new Date(opts.since);
    filtered = filtered.filter(e => new Date(e.timestamp) >= sinceDate);
  }
  if (opts.limit) filtered = filtered.slice(-opts.limit);
  
  return filtered;
}

/**
 * Get exit summary stats
 */
function getExitSummary(since) {
  const exits = since ? getExits({ since }) : loadLedger();
  
  const byReason = {};
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  
  for (const e of exits) {
    if (!byReason[e.reason]) byReason[e.reason] = { count: 0, pnl: 0 };
    byReason[e.reason].count++;
    byReason[e.reason].pnl += e.realizedPnl;
    totalPnl += e.realizedPnl;
    if (e.realizedPnl >= 0) wins++;
    else losses++;
  }
  
  return {
    total: exits.length,
    wins,
    losses,
    winRate: exits.length > 0 ? parseFloat(((wins / exits.length) * 100).toFixed(1)) : 0,
    totalPnl: parseFloat(totalPnl.toFixed(4)),
    byReason,
  };
}

module.exports = { logExit, getExits, getExitSummary, EXIT_REASONS };
