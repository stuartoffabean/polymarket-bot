/**
 * POSITION LEDGER — Single source of truth for all open positions
 *
 * Consolidates the three fragmented position sources:
 *   1. Executor trade cache (getCachedPositions → CLOB API)
 *   2. ws-feed subscribedAssets (in-memory Map)
 *   3. manual-positions.json (persisted file)
 *
 * This module maintains a single JSON file (position-ledger.json) that
 * captures every position change as a numbered transaction. Both executor
 * and ws-feed read from this ledger to get a consistent view.
 *
 * Usage:
 *   const ledger = require("./position-ledger");
 *   ledger.recordEntry({ assetId, market, outcome, size, avgPrice, strategy, source });
 *   ledger.recordExit({ assetId, size, reason, source });
 *   ledger.recordSync(executorPositions);  // reconcile from CLOB API
 *   const positions = ledger.getPositions();
 */

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./safe-write");

const LEDGER_FILE = path.join(__dirname, "..", "position-ledger.json");

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
  } catch {
    return { positions: {}, txLog: [], txSeq: 0 };
  }
}

function saveLedger(data) {
  // Trim txLog to last 500 entries to prevent unbounded growth
  if (data.txLog.length > 500) {
    data.txLog = data.txLog.slice(-500);
  }
  writeFileAtomic(LEDGER_FILE, data);
}

/**
 * Record a new position entry (buy).
 */
function recordEntry(params) {
  const ledger = loadLedger();
  const { assetId, market, outcome, size, avgPrice, strategy, source, totalCost } = params;

  const existing = ledger.positions[assetId];
  if (existing) {
    // Accumulate: weighted average price
    const oldCost = existing.size * existing.avgPrice;
    const newCost = size * avgPrice;
    existing.size += size;
    existing.avgPrice = existing.size > 0 ? (oldCost + newCost) / existing.size : avgPrice;
    existing.totalCost = (existing.totalCost || oldCost) + newCost;
    existing.updatedAt = new Date().toISOString();
  } else {
    ledger.positions[assetId] = {
      assetId,
      market: market || "Unknown",
      outcome: outcome || "Unknown",
      size,
      avgPrice,
      totalCost: totalCost || size * avgPrice,
      strategy: strategy || "unknown",
      source: source || "executor",
      enteredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  ledger.txSeq++;
  ledger.txLog.push({
    seq: ledger.txSeq,
    type: "entry",
    assetId,
    size,
    avgPrice,
    strategy,
    source,
    timestamp: new Date().toISOString(),
  });

  saveLedger(ledger);
  return ledger.positions[assetId];
}

/**
 * Record a position exit (sell, resolution, stop-loss, etc.).
 */
function recordExit(params) {
  const ledger = loadLedger();
  const { assetId, size, reason, source } = params;

  const pos = ledger.positions[assetId];
  if (!pos) return null;

  pos.size -= size;
  if (pos.size <= 0.001) {
    // Fully closed
    delete ledger.positions[assetId];
  } else {
    // Reduce totalCost proportionally by avg cost
    pos.totalCost = pos.size * pos.avgPrice;
    pos.updatedAt = new Date().toISOString();
  }

  ledger.txSeq++;
  ledger.txLog.push({
    seq: ledger.txSeq,
    type: "exit",
    assetId,
    size,
    reason: reason || "unknown",
    source: source || "executor",
    timestamp: new Date().toISOString(),
  });

  saveLedger(ledger);
  return pos;
}

/**
 * Sync ledger with executor's CLOB-derived positions.
 * Adds missing positions, updates sizes, removes stale entries.
 * @param {Array} executorPositions - From getCachedPositions().openPositions
 * @param {Object} manualPositions - From manual-positions.json
 * @returns {Object} { added, updated, removed }
 */
function recordSync(executorPositions, manualPositions = {}) {
  const ledger = loadLedger();
  const changes = { added: 0, updated: 0, removed: 0 };

  // Build set of all known positions from executor + manual
  const knownIds = new Set();

  // Merge executor positions
  for (const ep of executorPositions) {
    knownIds.add(ep.asset_id);
    const existing = ledger.positions[ep.asset_id];
    if (!existing) {
      ledger.positions[ep.asset_id] = {
        assetId: ep.asset_id,
        market: ep.market || "Unknown",
        outcome: ep.outcome || "Unknown",
        size: ep.size,
        avgPrice: parseFloat(ep.avgPrice),
        totalCost: ep.totalCost || ep.size * parseFloat(ep.avgPrice),
        strategy: ep.strategy || "unknown",
        source: "executor-sync",
        enteredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      changes.added++;
    } else if (Math.abs(existing.size - ep.size) > 0.01) {
      existing.size = ep.size;
      existing.avgPrice = parseFloat(ep.avgPrice);
      existing.totalCost = ep.totalCost || ep.size * parseFloat(ep.avgPrice);
      existing.updatedAt = new Date().toISOString();
      changes.updated++;
    }
  }

  // Merge manual positions
  for (const [assetId, mp] of Object.entries(manualPositions)) {
    if (!mp.size || mp.size <= 0) continue;
    knownIds.add(assetId);
    if (!ledger.positions[assetId]) {
      ledger.positions[assetId] = {
        assetId,
        market: mp.market || "Manual",
        outcome: mp.outcome || "Unknown",
        size: mp.size,
        avgPrice: mp.avgPrice || 0,
        totalCost: mp.totalCost || mp.size * (mp.avgPrice || 0),
        strategy: mp.strategy || "manual",
        source: "manual",
        enteredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      changes.added++;
    }
  }

  // Remove positions not in executor or manual (sold/resolved elsewhere)
  for (const assetId of Object.keys(ledger.positions)) {
    if (!knownIds.has(assetId)) {
      delete ledger.positions[assetId];
      changes.removed++;
    }
  }

  if (changes.added || changes.updated || changes.removed) {
    ledger.txSeq++;
    ledger.txLog.push({
      seq: ledger.txSeq,
      type: "sync",
      changes,
      timestamp: new Date().toISOString(),
    });
    saveLedger(ledger);
  }

  return changes;
}

/**
 * Get all open positions from the ledger.
 * @returns {Array} Array of position objects
 */
function getPositions() {
  const ledger = loadLedger();
  return Object.values(ledger.positions);
}

/**
 * Get a single position by assetId.
 */
function getPosition(assetId) {
  const ledger = loadLedger();
  return ledger.positions[assetId] || null;
}

/**
 * Get the transaction log (for debugging/audit).
 */
function getTxLog(limit = 50) {
  const ledger = loadLedger();
  return ledger.txLog.slice(-limit);
}

module.exports = { recordEntry, recordExit, recordSync, getPositions, getPosition, getTxLog };
