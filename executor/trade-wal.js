/**
 * TRADE WRITE-AHEAD LOG (WAL) — Crash Recovery for Order Execution
 *
 * Before any CLOB order is submitted, an intent record is appended to the WAL.
 * After the order completes (success or failure), the record is marked resolved.
 * On restart, unresolved entries are surfaced for manual review.
 *
 * This closes the crash window where an order fills on-chain but the bot dies
 * before updating local state (exit ledger, budget, snapshot).
 */

const fs = require("fs");
const path = require("path");

const WAL_FILE = path.join(__dirname, "..", "trade-wal.json");

// States: "pending" -> "filled" | "failed" | "unresolved"
function loadWal() {
  try {
    return JSON.parse(fs.readFileSync(WAL_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveWal(entries) {
  // Atomic write: write to temp file, then rename
  const tmpFile = WAL_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(entries, null, 2));
  fs.renameSync(tmpFile, WAL_FILE);
}

/**
 * Log intent BEFORE submitting an order. Returns a WAL entry ID.
 * @param {Object} params
 * @param {string} params.type - "buy" | "sell" | "market-sell" | "arb" | "batch"
 * @param {string} params.tokenID - Asset token ID
 * @param {number} params.price - Order price
 * @param {number} params.size - Order size (shares)
 * @param {string} params.side - "BUY" | "SELL"
 * @param {string} params.strategy - Strategy tag
 * @param {string} [params.source] - "executor" | "ws-feed-auto" | "resolution-hunter" | "weather"
 * @param {Object} [params.meta] - Additional context (market name, reason, etc.)
 * @returns {string} WAL entry ID
 */
function logIntent(params) {
  const entries = loadWal();
  const id = `wal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  entries.push({
    id,
    status: "pending",
    createdAt: new Date().toISOString(),
    type: params.type,
    tokenID: params.tokenID,
    price: params.price,
    size: params.size,
    side: params.side,
    strategy: params.strategy || "unknown",
    source: params.source || "executor",
    meta: params.meta || {},
  });
  // Keep WAL bounded — remove resolved entries older than 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const trimmed = entries.filter(e =>
    e.status === "pending" || new Date(e.createdAt).getTime() > cutoff
  );
  saveWal(trimmed);
  return id;
}

/**
 * Mark a WAL entry as resolved (filled or failed).
 * @param {string} walId - WAL entry ID from logIntent()
 * @param {"filled"|"failed"} status
 * @param {Object} [result] - Order result or error info
 */
function resolveIntent(walId, status, result = {}) {
  const entries = loadWal();
  const entry = entries.find(e => e.id === walId);
  if (entry) {
    entry.status = status;
    entry.resolvedAt = new Date().toISOString();
    entry.result = {
      orderID: result.orderID || result.id || null,
      error: result.error || null,
      executedPrice: result.executedPrice || null,
    };
    saveWal(entries);
  }
}

/**
 * On startup, find any pending entries from a previous session.
 * These represent orders that may have been submitted but never confirmed.
 * @returns {Array} Unresolved WAL entries
 */
function getUnresolved() {
  const entries = loadWal();
  return entries.filter(e => e.status === "pending");
}

/**
 * Mark all stale pending entries as "unresolved" (for ops review).
 * Called on startup after surfacing them via Telegram.
 */
function markStaleAsUnresolved() {
  const entries = loadWal();
  let count = 0;
  for (const e of entries) {
    if (e.status === "pending") {
      e.status = "unresolved";
      e.resolvedAt = new Date().toISOString();
      e.result = { note: "Process restarted before order was confirmed" };
      count++;
    }
  }
  if (count > 0) saveWal(entries);
  return count;
}

module.exports = { logIntent, resolveIntent, getUnresolved, markStaleAsUnresolved };
