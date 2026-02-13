/**
 * Polymarket WebSocket Price Feed + Circuit Breakers + Auto-Execute
 * v3 — Full directive compliance + integrated scanners
 * 
 * Features:
 * - Real-time price updates via Polymarket WSS
 * - AUTO-EXECUTE stop-loss and take-profit (sells at market)
 * - Daily drawdown circuit breaker (15% max) → pauses all trading
 * - WS disconnect → cancels all open maker orders
 * - SURVIVAL MODE (balance < 25% of starting) → Telegram alert
 * - EMERGENCY MODE (balance < 10% of starting) → halt all trading
 * - Rate limit detection (429 backoff)
 * - Manual position injection for untracked trades
 * - Auto-reconnect with exponential backoff
 * - Integrated arb scanner (every 15 min) → arb-results.json
 * - Resolving markets scanner (every 30 min) → resolving-markets.json
 * 
 * Port 3003 HTTP API:
 *   GET  /health
 *   GET  /prices          — live prices + P&L for all positions
 *   GET  /alerts          — recent alert history
 *   GET  /status          — full system status
 *   GET  /arb-results     — latest arb scanner results
 *   GET  /resolving       — markets resolving in 6-12h
 *   POST /set-trigger     — { assetId, stopLoss, takeProfit }
 *   POST /add-position    — { assetId, market, outcome, avgPrice, size } (persisted to manual-positions.json)
 *   POST /remove-position — { assetId } (removes manual position permanently)
 *   POST /reset-circuit-breaker
 */

const WebSocket = require("ws");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// === FEE ACCOUNTING (Feb 2026) ===
// Most Polymarket markets: ZERO fees. Only 15-min crypto, NCAAB, Serie A have taker fees.
// Source: https://docs.polymarket.com/polymarket-learn/trading/fees
// Fee formula: feePerShare = p * (1-p) * RATE
// Weather, politics, events: RATE = 0 (no fees)
// 15-min crypto: RATE = 3.125 (max 1.56% effective at p=0.50)
// NCAAB/Serie A: RATE = 0.875 (max 0.44%, from Feb 18)
// Maker orders (postOnly): always zero fees + earn rebates
const FEE_RATES = { NONE: 0, CRYPTO_15MIN: 3.125, SPORTS: 0.875 };
function takerFeePerShare(price, marketType = 'NONE') {
  return price * (1 - price) * (FEE_RATES[marketType] || 0);
}
// Detect market type from question/slug
function detectMarketType(question = '', slug = '') {
  const q = (question + ' ' + slug).toLowerCase();
  if (q.includes('15m') || q.includes('up or down') || q.includes('updown')) return 'CRYPTO_15MIN';
  if (q.includes('ncaab') || q.includes('serie a')) return 'SPORTS';
  return 'NONE';
}

// === CONFIG ===
const WSS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const EXECUTOR_URL = "http://localhost:3002";
const STATE_FILE = path.join(__dirname, "..", "TRADING-STATE.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");
const MANUAL_POSITIONS_FILE = path.join(__dirname, "manual-positions.json");
const FEED_PORT = parseInt(process.env.FEED_PORT || "3003");
const PING_INTERVAL = 10000;
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 60000;
const POSITION_SYNC_INTERVAL = 5 * 60 * 1000;
const FEE_CHECK_INTERVAL = 60 * 60 * 1000; // check fees hourly

// Telegram alerts
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_ALERT_TYPES = new Set([
  "STOP_LOSS", "TAKE_PROFIT", "SELL_EXECUTED", "SELL_FAILED",
  "CIRCUIT_BREAKER", "CIRCUIT_BREAKER_RESUMED",
  "SURVIVAL_MODE", "EMERGENCY_MODE",
  "WS_DISCONNECT", "SINGLE_TRADE_LOSS",
]);

// PnL history
const PNL_HISTORY_FILE = path.join(__dirname, "..", "pnl-history.json");
const PNL_RECORD_INTERVAL = 5 * 60 * 1000; // 5 min

// Scanner config
const GAMMA_API = "https://gamma-api.polymarket.com";
const PROXY_API = "https://proxy-rosy-sigma-25.vercel.app";
const ARB_THRESHOLD = 0.025; // 2.5% deviation
const ARB_RESULTS_FILE = path.join(__dirname, "..", "arb-results.json");
const RESOLVING_FILE = path.join(__dirname, "..", "resolving-markets.json");
const ARB_SCAN_INTERVAL = 15 * 60 * 1000;       // 15 min
const RESOLVING_SCAN_INTERVAL = 30 * 60 * 1000;  // 30 min

// Thresholds (Directive v2 §risk, v3 §7)
// P&L is chain-truth only — no hardcoded starting capital. Survival/emergency
// thresholds use absolute dollar floors instead of % of arbitrary number.
const MAX_DAILY_DRAWDOWN = 0.15;      // 15% → pause 2hrs (relative to daily start)
const DEFAULT_STOP_LOSS = 0.30;       // 30% loss per position
const DEFAULT_TAKE_PROFIT = 0.50;     // 50% gain per position
const SURVIVAL_FLOOR = 100;           // $100 total value → survival mode
const EMERGENCY_FLOOR = 50;           // $50 total value → emergency mode
const SINGLE_TRADE_LOSS_LIMIT_USD = 20; // $20 single trade loss → halt strategy
const DRAWDOWN_PAUSE_MS = 2 * 60 * 60 * 1000; // 2 hour pause

// === STRATEGY TAGS ===
// Every position gets a strategy tag: 'weather', 'resolution', 'arb', 'manual'
// Persisted to survive restarts. SL/TP sells inherit the original buy's strategy.
const STRATEGY_TAGS_FILE = path.join(__dirname, "..", "strategy-tags.json");
let strategyTags = {}; // assetId -> { strategy, entryTime, ... }
try { strategyTags = JSON.parse(fs.readFileSync(STRATEGY_TAGS_FILE, "utf8")); } catch {}
function saveStrategyTags() {
  try { fs.writeFileSync(STRATEGY_TAGS_FILE, JSON.stringify(strategyTags, null, 2)); } catch {}
}
function tagStrategy(assetId, strategy, meta = {}) {
  strategyTags[assetId] = { strategy, taggedAt: new Date().toISOString(), ...meta };
  saveStrategyTags();
  // Also set on the tracked asset
  const asset = subscribedAssets.get(assetId);
  if (asset) asset.strategy = strategy;
}
function getStrategy(assetId) {
  return strategyTags[assetId]?.strategy || subscribedAssets.get(assetId)?.strategy || 'unknown';
}

// === GLOBAL AUTO-EXECUTION CAP ===
// Combined ceiling for all auto strategies (weather + resolution + arb).
// Remaining 75% reserved for manual/cognitive trades via executor sessions.
const AUTO_STRATEGIES = new Set(["weather", "resolution", "arb"]);
const AUTO_GLOBAL_CAP_PCT = 0.25; // 25% of bankroll
const AUTO_GLOBAL_CAP_FLOOR = 125; // minimum $125 (based on ~$500 bankroll)

function getAutoDeployedCapital() {
  let total = 0;
  const breakdown = { weather: 0, resolution: 0, arb: 0 };
  for (const [id, asset] of subscribedAssets) {
    const strat = getStrategy(id);
    if (AUTO_STRATEGIES.has(strat)) {
      const value = (asset.currentBid || asset.avgPrice || 0) * (asset.size || 0);
      total += value;
      if (breakdown[strat] !== undefined) breakdown[strat] += value;
    }
  }
  return { total: parseFloat(total.toFixed(2)), breakdown };
}

function getAutoGlobalCap() {
  // Use portfolio value if available, otherwise floor
  const bankroll = currentPortfolioValue || AUTO_GLOBAL_CAP_FLOOR / AUTO_GLOBAL_CAP_PCT;
  return Math.max(bankroll * AUTO_GLOBAL_CAP_PCT, AUTO_GLOBAL_CAP_FLOOR);
}

// Returns { allowed, deployed, remaining, cap } — call before any auto-trade
function checkAutoCapBudget(strategy, spendAmount) {
  const { total, breakdown } = getAutoDeployedCapital();
  const cap = getAutoGlobalCap();
  const remaining = cap - total;
  const allowed = spendAmount <= remaining;
  if (!allowed) {
    const msg = `🚫 AUTO-CAP BLOCKED: ${strategy} wanted $${spendAmount.toFixed(2)} but global auto-deployed=$${total.toFixed(2)}/${cap.toFixed(2)} (remaining=$${remaining.toFixed(2)}). Breakdown: wx=$${breakdown.weather.toFixed(2)} rh=$${breakdown.resolution.toFixed(2)} arb=$${breakdown.arb.toFixed(2)}`;
    log("CAP", msg);
    addAlert("AUTO_CAP_BLOCKED", msg);
    sendTelegramAlert(msg);
  }
  return { allowed, deployed: total, remaining, cap, breakdown };
}

// === STATE ===
let ws = null;
let reconnectAttempts = 0;
let pingTimer = null;
let wsLastMessageAt = 0;          // timestamp of last WS message (any)
let wsSilentCheckTimer = null;    // 15s silent detection timer
const WS_SILENT_THRESHOLD = 15000; // force reconnect if no messages for 15s
let subscribedAssets = new Map(); // asset_id -> position data
let dailyStartValue = null;
let currentPortfolioValue = null;
let liquidBalance = null; // USDCe not in positions
let circuitBreakerTripped = false;
let circuitBreakerResumeAt = null;
let survivalMode = false;
let emergencyMode = false;
let alertLog = [];
let autoExecuteEnabled = true;
let rateLimitBackoff = false;
let rateLimitResumeAt = null;

// === HELPERS ===
function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function loadAlerts() {
  try { return JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8")); }
  catch (e) { return { positions: {}, pending: [], circuitBreakerTripped: false }; }
}

function saveAlerts(data) {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(data, null, 2));
}

function loadManualPositions() {
  try { return JSON.parse(fs.readFileSync(MANUAL_POSITIONS_FILE, "utf8")); }
  catch (e) { return {}; }
}

function saveManualPositions(data) {
  fs.writeFileSync(MANUAL_POSITIONS_FILE, JSON.stringify(data, null, 2));
}

function loadTradingState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch (e) { return null; }
}

// === HTTP CALLS TO EXECUTOR ===
function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${EXECUTOR_URL}${urlPath}`, (res) => {
      if (res.statusCode === 429) {
        handleRateLimit();
        reject(new Error("Rate limited"));
        return;
      }
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function httpPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`${EXECUTOR_URL}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      if (res.statusCode === 429) {
        handleRateLimit();
        reject(new Error("Rate limited"));
        return;
      }
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function httpDelete(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${EXECUTOR_URL}${urlPath}`, { method: "DELETE" }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// === RATE LIMIT HANDLING (v3 §7) ===
let rateLimitHits = [];
function handleRateLimit() {
  const now = Date.now();
  rateLimitHits.push(now);
  // Clean old hits
  rateLimitHits = rateLimitHits.filter(t => now - t < 5 * 60 * 1000);
  
  if (rateLimitHits.length >= 3) {
    log("RATE", "🚨 3x 429 in 5 minutes — backing off 50% for 10 minutes");
    rateLimitBackoff = true;
    rateLimitResumeAt = now + 10 * 60 * 1000;
    setTimeout(() => {
      rateLimitBackoff = false;
      rateLimitResumeAt = null;
      log("RATE", "Rate limit backoff ended");
    }, 10 * 60 * 1000);
  }
}

// === ORDER CONFIRMATION & FILL TRACKING ===
// After submitting an order, verify actual fill status via CLOB
const FILL_STATS_FILE = path.join(__dirname, "..", "fill-stats.json");
let fillStats = { weather: { submitted: 0, filled: 0, partial: 0, unfilled: 0 }, resolution: { submitted: 0, filled: 0, partial: 0, unfilled: 0 }, arb: { submitted: 0, filled: 0, partial: 0, unfilled: 0 } };
try { fillStats = JSON.parse(fs.readFileSync(FILL_STATS_FILE, "utf8")); } catch {}
function saveFillStats() { try { fs.writeFileSync(FILL_STATS_FILE, JSON.stringify(fillStats, null, 2)); } catch {} }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Confirm an order's fill status. Returns:
 * { status: 'filled'|'partial'|'unfilled'|'error', sizeMatched, originalSize, fillPrice, slippage, orderID }
 * 
 * @param {string} orderID - CLOB order ID  
 * @param {string} strategy - 'weather'|'resolution'|'arb'
 * @param {number} expectedPrice - price model assumed for slippage calc
 * @param {number} cancelAfterMs - cancel unfilled remainder after this many ms (0 = immediate)
 * @param {string} label - human label for logging (e.g. "NYC 34-35°F")
 */
async function confirmOrder(orderID, strategy, expectedPrice, cancelAfterMs, label) {
  if (!orderID) return { status: "error", reason: "no orderID returned" };
  
  const strat = fillStats[strategy] || (fillStats[strategy] = { submitted: 0, filled: 0, partial: 0, unfilled: 0 });
  strat.submitted++;
  
  // Wait 5s for initial fill
  await sleep(5000);
  
  let order;
  try {
    order = await httpGet(`/get-order?id=${orderID}`);
  } catch (e) {
    log("CONFIRM", `Failed to fetch order ${orderID}: ${e.message}`);
    return { status: "error", reason: e.message };
  }
  
  const originalSize = parseFloat(order.original_size || 0);
  const sizeMatched = parseFloat(order.size_matched || 0);
  const fillPrice = parseFloat(order.price || expectedPrice);
  const slippage = fillPrice - expectedPrice;
  
  // Fully filled
  if (order.status === "MATCHED" || (originalSize > 0 && sizeMatched >= originalSize * 0.99)) {
    strat.filled++;
    saveFillStats();
    const slipBps = ((slippage / expectedPrice) * 10000).toFixed(0);
    log("CONFIRM", `✅ FILLED: ${label} — ${sizeMatched}/${originalSize} @ ${fillPrice} (expected ${expectedPrice}, slippage ${slipBps}bps)`);
    return { status: "filled", sizeMatched, originalSize, fillPrice, slippage, orderID };
  }
  
  // Partially filled or unfilled — wait for cancelAfterMs then re-check
  if (cancelAfterMs > 0) {
    const remainingWait = Math.max(cancelAfterMs - 5000, 0);
    if (remainingWait > 0) await sleep(remainingWait);
    
    // Re-check
    try {
      order = await httpGet(`/get-order?id=${orderID}`);
    } catch (e) {
      log("CONFIRM", `Failed to re-fetch order ${orderID}: ${e.message}`);
    }
  }
  
  const finalMatched = parseFloat(order.size_matched || 0);
  const finalOriginal = parseFloat(order.original_size || 0);
  
  if (order.status === "MATCHED" || (finalOriginal > 0 && finalMatched >= finalOriginal * 0.99)) {
    strat.filled++;
    saveFillStats();
    const slipBps = ((slippage / expectedPrice) * 10000).toFixed(0);
    log("CONFIRM", `✅ FILLED (late): ${label} — ${finalMatched}/${finalOriginal} @ ${fillPrice} (slippage ${slipBps}bps)`);
    return { status: "filled", sizeMatched: finalMatched, originalSize: finalOriginal, fillPrice, slippage, orderID };
  }
  
  // Cancel the unfilled/partial remainder
  const shouldCancel = order.status !== "MATCHED" && order.status !== "CANCELLED";
  if (shouldCancel) {
    try {
      await httpPost("/cancel-order", { orderID });
      log("CONFIRM", `🗑️ Cancelled unfilled order ${orderID}`);
    } catch (e) {
      log("CONFIRM", `Failed to cancel ${orderID}: ${e.message}`);
    }
  }
  
  if (finalMatched > 0 && finalMatched < finalOriginal * 0.99) {
    strat.partial++;
    saveFillStats();
    log("CONFIRM", `⚠️ PARTIAL: ${label} — ${finalMatched}/${finalOriginal} filled, remainder cancelled`);
    return { status: "partial", sizeMatched: finalMatched, originalSize: finalOriginal, fillPrice, slippage, orderID };
  }
  
  // Completely unfilled
  strat.unfilled++;
  saveFillStats();
  log("CONFIRM", `❌ UNFILLED: ${label} — 0/${finalOriginal}, order cancelled`);
  return { status: "unfilled", sizeMatched: 0, originalSize: finalOriginal, fillPrice, slippage, orderID };
}

// === ORDER BOOK DEPTH CHECK ===
// Walk ask side to determine realistic fill. Returns { sizeWithinTol, avgFillPrice, bestAsk }.
// CLOB asks are sorted DESCENDING — best (lowest) ask is LAST.
const DEPTH_SLIPPAGE_TOL = 0.02;  // 2% max slippage from best ask
const DEPTH_MIN_SHARES = 5;

function checkBookDepth(book, intendedSize, label) {
  if (!book?.asks?.length) {
    log("DEPTH", `${label}: no asks in book — skipping`);
    return { skip: true, reason: "no asks" };
  }

  // Sort asks ascending (cheapest first) for walk
  const asks = book.asks
    .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .sort((a, b) => a.price - b.price);

  const bestAsk = asks[0].price;
  const maxPrice = bestAsk * (1 + DEPTH_SLIPPAGE_TOL);

  let filled = 0;
  let totalCost = 0;

  for (const level of asks) {
    if (level.price > maxPrice) break;
    const canTake = Math.min(level.size, intendedSize - filled);
    filled += canTake;
    totalCost += canTake * level.price;
    if (filled >= intendedSize) break;
  }

  const avgFillPrice = filled > 0 ? totalCost / filled : bestAsk;
  const slippagePct = ((avgFillPrice - bestAsk) / bestAsk * 100).toFixed(2);

  if (filled >= intendedSize) {
    log("DEPTH", `${label}: ${intendedSize}sh fillable within ${DEPTH_SLIPPAGE_TOL * 100}% of best ask ${bestAsk} (avg fill ${avgFillPrice.toFixed(4)}, slippage ${slippagePct}%)`);
    return { skip: false, size: intendedSize, bestAsk, avgFillPrice, slippage: parseFloat(slippagePct) };
  }

  // Not enough depth — size down
  const availableSize = Math.floor(filled);
  if (availableSize < DEPTH_MIN_SHARES) {
    log("DEPTH", `${label}: only ${availableSize}sh available within ${DEPTH_SLIPPAGE_TOL * 100}% tolerance — skipping`);
    return { skip: true, reason: `only ${availableSize}sh within tolerance`, bestAsk, availableSize };
  }

  log("DEPTH", `${label}: wanted ${intendedSize}sh, book has ${availableSize}sh within ${DEPTH_SLIPPAGE_TOL * 100}% of best ask ${bestAsk}, sizing down`);
  return { skip: false, size: availableSize, bestAsk, avgFillPrice, slippage: parseFloat(slippagePct), reduced: true };
}

// === TELEGRAM ALERTS ===
function sendTelegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const payload = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_notification: false,
  });
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
  }, (res) => {
    let data = "";
    res.on("data", (c) => data += c);
    res.on("end", () => {
      if (res.statusCode !== 200) {
        log("TG", `Alert send failed (${res.statusCode}): ${data.slice(0, 200)}`);
      }
    });
  });
  req.on("error", (e) => log("TG", `Alert error: ${e.message}`));
  req.write(payload);
  req.end();
}

// === WEBSOCKET ===
function connect() {
  log("WS", `Connecting to ${WSS_URL}...`);
  ws = new WebSocket(WSS_URL);

  ws.on("open", () => {
    log("WS", "Connected!");
    reconnectAttempts = 0;

    const assetIds = Array.from(subscribedAssets.keys());
    if (assetIds.length > 0) {
      ws.send(JSON.stringify({ assets_ids: assetIds, type: "market" }));
      log("WS", `Subscribed to ${assetIds.length} assets`);
    }

    wsLastMessageAt = Date.now();

    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, PING_INTERVAL);

    // Silent WS detection: if no messages for 15s, force reconnect
    if (wsSilentCheckTimer) clearInterval(wsSilentCheckTimer);
    wsSilentCheckTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && wsLastMessageAt > 0) {
        const silentMs = Date.now() - wsLastMessageAt;
        if (silentMs > WS_SILENT_THRESHOLD) {
          log("WS", `🚨 SILENT WebSocket: no messages for ${(silentMs / 1000).toFixed(1)}s — force reconnect`);
          pushAlert("WS_SILENT", null, null, null, null, `Silent WS for ${(silentMs / 1000).toFixed(0)}s — forced reconnect`);
          try { ws.terminate(); } catch {}
          // close/error handler will trigger scheduleReconnect
        }
      }
    }, 5000); // check every 5s
  });

  ws.on("message", (raw) => {
    wsLastMessageAt = Date.now();
    const msg = raw.toString();
    if (msg === "PONG") return;
    try { handleMessage(JSON.parse(msg)); } catch (e) { /* ignore non-JSON */ }
  });

  ws.on("close", (code, reason) => {
    log("WS", `Closed: ${code} ${reason}`);
    handleDisconnect();
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    log("WS", `Error: ${err.message}`);
  });
}

// v3 §7: WebSocket disconnects → cancel all open maker orders
async function handleDisconnect() {
  if (pingTimer) clearInterval(pingTimer);
  if (wsSilentCheckTimer) clearInterval(wsSilentCheckTimer);
  log("WS", "🚨 Disconnected — cancelling all open orders (v3 §7)");
  try {
    const result = await httpDelete("/orders");
    log("WS", `Cancel all orders result: ${JSON.stringify(result)}`);
    pushAlert("WS_DISCONNECT", null, null, null, null, "Cancelled all open orders on disconnect");
  } catch (e) {
    log("WS", `Failed to cancel orders: ${e.message}`);
  }
}

function scheduleReconnect() {
  const delay = Math.min(RECONNECT_BASE * Math.pow(2, reconnectAttempts), RECONNECT_MAX);
  reconnectAttempts++;
  log("WS", `Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
  setTimeout(connect, delay);
}

function subscribe(assetIds) {
  for (const id of assetIds) {
    if (!subscribedAssets.has(id)) subscribedAssets.set(id, { currentBid: null, currentAsk: null });
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ assets_ids: assetIds, operation: "subscribe" }));
    log("WS", `Subscribed to ${assetIds.length} new assets`);
  }
}

// === MESSAGE HANDLING ===
function handleMessage(data) {
  if (data.event_type === "book") handleBook(data);
  else if (data.event_type === "price_change") handlePriceChange(data);
  else if (data.event_type === "tick_size_change") {
    log("WS", `Tick size change: ${data.asset_id?.slice(0,20)} ${data.old_tick_size} -> ${data.new_tick_size}`);
    pushAlert("TICK_SIZE_CHANGE", data.asset_id, null, null, null, `${data.old_tick_size} -> ${data.new_tick_size}`);
  }
}

function handleBook(data) {
  const asset = subscribedAssets.get(data.asset_id);
  if (!asset) return;
  // CLOB book: bids ascending (best=last), asks descending (best=last)
  asset.currentBid = data.bids?.length > 0 ? parseFloat(data.bids[data.bids.length - 1].price) : null;
  asset.currentAsk = data.asks?.length > 0 ? parseFloat(data.asks[data.asks.length - 1].price) : null;
  asset.lastUpdate = Date.now();
  checkTriggers(data.asset_id, asset);
}

function handlePriceChange(data) {
  if (!data.price_changes) return;
  for (const pc of data.price_changes) {
    const asset = subscribedAssets.get(pc.asset_id);
    if (!asset) continue;
    if (pc.best_bid) asset.currentBid = parseFloat(pc.best_bid);
    if (pc.best_ask) asset.currentAsk = parseFloat(pc.best_ask);
    asset.lastUpdate = Date.now();
    checkTriggers(pc.asset_id, asset);
  }
}

// === TRIGGER ENGINE ===
function checkTriggers(assetId, asset) {
  if (!asset.avgPrice || !asset.size) return;

  const currentPrice = asset.currentBid;
  if (!currentPrice) return;

  // Always update portfolio (even in emergency — needed for mode recovery)
  updatePortfolioValue();

  if (emergencyMode) return; // no trading in emergency

  const costBasis = asset.avgPrice * asset.size;
  const currentValue = currentPrice * asset.size;
  const pnlPct = (currentValue - costBasis) / costBasis;
  const pnlAbs = currentValue - costBasis;

  const stopLoss = asset.stopLoss || DEFAULT_STOP_LOSS;
  const takeProfit = asset.takeProfit || DEFAULT_TAKE_PROFIT;

  // Single trade loss > $20 (v3 §7)
  if (pnlAbs < 0 && Math.abs(pnlAbs) > SINGLE_TRADE_LOSS_LIMIT_USD) {
    if (!asset._singleLossAlerted) {
      pushAlert("SINGLE_TRADE_LOSS", assetId, asset, currentPrice, pnlPct, 
        `Loss $${Math.abs(pnlAbs).toFixed(2)} exceeds 5% of bankroll`);
      asset._singleLossAlerted = true;
    }
  }

  // Stop loss → AUTO SELL
  if (pnlPct <= -stopLoss && !asset._stopLossTriggered) {
    asset._stopLossTriggered = true;
    const strat = getStrategy(assetId);
    pushAlert("STOP_LOSS", assetId, asset, currentPrice, pnlPct, `AUTO-SELLING [${strat}]`);
    if (autoExecuteEnabled && !circuitBreakerTripped) {
      executeSell(assetId, asset, "STOP_LOSS");
    }
  }

  // Take profit → AUTO SELL
  if (pnlPct >= takeProfit && !asset._takeProfitTriggered) {
    asset._takeProfitTriggered = true;
    const strat = getStrategy(assetId);
    pushAlert("TAKE_PROFIT", assetId, asset, currentPrice, pnlPct, `AUTO-SELLING [${strat}]`);
    if (autoExecuteEnabled && !circuitBreakerTripped) {
      executeSell(assetId, asset, "TAKE_PROFIT");
    }
  }

}

async function executeSell(assetId, asset, reason) {
  log("EXEC", `🚨 AUTO-SELL: ${asset.outcome} ${asset.size} shares (${reason})`);
  try {
    const result = await httpPost("/market-sell", {
      tokenID: assetId,
      size: asset.size,
    });
    log("EXEC", `Sell result: ${JSON.stringify(result)}`);
    pushAlert("SELL_EXECUTED", assetId, asset, result.executedPrice, null, 
      `${reason}: Sold ${asset.size} @ ${result.executedPrice}`);
    
    // If this was a manual position, remove from persisted file
    if (asset._manual) {
      const manualPositions = loadManualPositions();
      delete manualPositions[assetId];
      saveManualPositions(manualPositions);
      subscribedAssets.delete(assetId);
      log("MANUAL", `Sold manual position — removed from persistence: ${assetId.slice(0,20)}`);
    }
    
    // STRUCTURAL FIX: Sync positions from executor after sell
    log("SYNC", "Post-sell position sync...");
    await syncPositions();
  } catch (e) {
    log("EXEC", `❌ Auto-sell FAILED: ${e.message}`);
    pushAlert("SELL_FAILED", assetId, asset, null, null, `${reason} sell failed: ${e.message}`);
  }
}

function updatePortfolioValue() {
  let positionValue = 0;
  for (const [id, asset] of subscribedAssets) {
    if (asset.size && asset.currentBid) {
      positionValue += asset.currentBid * asset.size;
    }
  }

  // Load liquid balance from trading state
  const state = loadTradingState();
  const liquid = state?.liquidBalance || 0;
  const totalValue = positionValue + liquid;

  if (positionValue > 0) {
    currentPortfolioValue = positionValue;

    if (!dailyStartValue) dailyStartValue = positionValue;

    // Daily drawdown check (v3 §7)
    const drawdown = (dailyStartValue - positionValue) / dailyStartValue;
    if (drawdown >= MAX_DAILY_DRAWDOWN && !circuitBreakerTripped) {
      circuitBreakerTripped = true;
      circuitBreakerResumeAt = Date.now() + DRAWDOWN_PAUSE_MS;
      pushAlert("CIRCUIT_BREAKER", null, null, null, -drawdown, 
        `Daily drawdown ${(drawdown * 100).toFixed(1)}% exceeds 15% — PAUSED for 2 hours`);
      log("CB", `🔴 CIRCUIT BREAKER TRIPPED — resume at ${new Date(circuitBreakerResumeAt).toISOString()}`);
      
      // Auto-resume after 2 hours
      setTimeout(() => {
        circuitBreakerTripped = false;
        circuitBreakerResumeAt = null;
        log("CB", "🟢 Circuit breaker auto-resumed after 2 hour pause");
        pushAlert("CIRCUIT_BREAKER_RESUMED", null, null, null, null, "2 hour pause complete");
      }, DRAWDOWN_PAUSE_MS);
    }

    // SURVIVAL MODE: position value < $100
    if (totalValue > 0 && totalValue < SURVIVAL_FLOOR && !survivalMode) {
      survivalMode = true;
      pushAlert("SURVIVAL_MODE", null, null, null, null, 
        `⚠️ Position value $${totalValue.toFixed(2)} below $${SURVIVAL_FLOOR} — SURVIVAL MODE`);
      log("RISK", `⚠️ SURVIVAL MODE ACTIVATED — position value: $${totalValue.toFixed(2)}`);
    } else if (survivalMode && totalValue >= SURVIVAL_FLOOR) {
      survivalMode = false;
      log("RISK", `✅ SURVIVAL MODE CLEARED — position value: $${totalValue.toFixed(2)}`);
    }

    // EMERGENCY MODE: position value < $50
    if (totalValue > 0 && totalValue < EMERGENCY_FLOOR && !emergencyMode) {
      emergencyMode = true;
      autoExecuteEnabled = false;
      pushAlert("EMERGENCY_MODE", null, null, null, null, 
        `🚨 EMERGENCY: Position value $${totalValue.toFixed(2)} below $${EMERGENCY_FLOOR} — ALL TRADING HALTED`);
      log("RISK", `🚨 EMERGENCY MODE — ALL TRADING HALTED`);
    } else if (emergencyMode && totalValue >= EMERGENCY_FLOOR) {
      emergencyMode = false;
      autoExecuteEnabled = true;
      log("RISK", `✅ EMERGENCY MODE CLEARED — position value: $${totalValue.toFixed(2)}, auto-execute re-enabled`);
    }
  }
}

// === ALERT SYSTEM ===
function pushAlert(type, assetId, asset, price, pnlPct, message) {
  const alert = {
    type,
    assetId: assetId?.slice(0, 20),
    outcome: asset?.outcome,
    market: asset?.market,
    price,
    pnlPct: pnlPct != null ? (pnlPct * 100).toFixed(1) + "%" : null,
    size: asset?.size,
    avgPrice: asset?.avgPrice,
    message,
    timestamp: new Date().toISOString(),
  };

  log("ALERT", `${type}: ${message || asset?.outcome || "SYSTEM"}`);
  alertLog.push(alert);
  if (alertLog.length > 200) alertLog = alertLog.slice(-100);

  // Send Telegram alert for critical types
  if (TELEGRAM_ALERT_TYPES.has(type)) {
    const emoji = type.includes("EMERGENCY") ? "🚨" : type.includes("SURVIVAL") ? "⚠️" : type.includes("STOP") ? "🔴" : type.includes("TAKE_PROFIT") || type.includes("SELL_EXECUTED") ? "💰" : type.includes("CIRCUIT") ? "⚡" : "📡";
    const tgText = `${emoji} <b>Stuart Bot — ${type}</b>\n${asset?.market ? `Market: ${asset.market}\n` : ""}${asset?.outcome ? `Outcome: ${asset.outcome}\n` : ""}${price ? `Price: ${price}\n` : ""}${pnlPct != null ? `P&L: ${(pnlPct * 100).toFixed(1)}%\n` : ""}${message || ""}`;
    sendTelegramAlert(tgText);
  }

  // Persist
  const alerts = loadAlerts();
  if (!alerts.pending) alerts.pending = [];
  alerts.pending.push(alert);
  alerts.circuitBreakerTripped = circuitBreakerTripped;
  alerts.survivalMode = survivalMode;
  alerts.emergencyMode = emergencyMode;
  saveAlerts(alerts);
}

// === POSITION SYNC ===
async function syncPositions() {
  if (rateLimitBackoff) {
    log("SYNC", "Skipping — rate limit backoff active");
    return;
  }

  try {
    const { positions } = await httpGet("/positions");
    const alerts = loadAlerts();

    // STRUCTURAL FIX: Remove sold executor positions (not in executor anymore)
    // Manual positions are managed separately via manual-positions.json
    const executorAssetIds = new Set(positions.map(p => p.asset_id));
    const manualPositions = loadManualPositions();
    for (const [assetId, asset] of subscribedAssets) {
      if (!executorAssetIds.has(assetId) && !manualPositions[assetId]) {
        subscribedAssets.delete(assetId);
        log("SYNC", `Removed sold position: ${assetId.slice(0,20)}`);
      }
    }

    // Merge manual positions from file (survives restarts)
    for (const [assetId, mp] of Object.entries(manualPositions)) {
      if (!subscribedAssets.has(assetId)) {
        subscribedAssets.set(assetId, {
          ...mp,
          _manual: true,
        });
        subscribe([assetId]);
        log("SYNC", `Loaded manual position from file: ${mp.outcome} ${mp.size} @ ${mp.avgPrice}`);
      }
    }

    const newAssetIds = [];
    for (const pos of positions) {
      // Skip positions with zero size
      if (pos.size === 0) {
        subscribedAssets.delete(pos.asset_id);
        log("SYNC", `Skipped zero-size position: ${pos.asset_id.slice(0,20)}`);
        continue;
      }
      
      const existing = subscribedAssets.get(pos.asset_id) || {};
      subscribedAssets.set(pos.asset_id, {
        ...existing,
        market: pos.market,
        outcome: pos.outcome,
        avgPrice: parseFloat(pos.avgPrice),
        size: pos.size,
        totalCost: pos.totalCost,
        stopLoss: alerts.positions?.[pos.asset_id]?.stopLoss || existing.stopLoss || DEFAULT_STOP_LOSS,
        takeProfit: alerts.positions?.[pos.asset_id]?.takeProfit || existing.takeProfit || DEFAULT_TAKE_PROFIT,
        _stopLossTriggered: existing._stopLossTriggered || false,
        _takeProfitTriggered: existing._takeProfitTriggered || false,
        _singleLossAlerted: existing._singleLossAlerted || false,
      });
      newAssetIds.push(pos.asset_id);
    }

    if (newAssetIds.length > 0) subscribe(newAssetIds);
    log("SYNC", `Tracking ${subscribedAssets.size} positions (${positions.length} from executor)`);
  } catch (e) {
    log("SYNC", `Failed: ${e.message}`);
  }
}

// === HTTP API (port 3003) ===
async function apiHandler(req, res) {
  const url = req.url.split("?")[0];
  const method = req.method;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") return send(res, 200, {});

  try {
    if (url === "/health") {
      const wsSilentSec = wsLastMessageAt > 0 ? ((Date.now() - wsLastMessageAt) / 1000).toFixed(1) : null;
      return send(res, 200, {
        ok: true,
        wsConnected: ws?.readyState === WebSocket.OPEN,
        wsLastMessageAgo: wsSilentSec ? `${wsSilentSec}s` : "never",
        trackedAssets: subscribedAssets.size,
        circuitBreakerTripped,
        survivalMode,
        emergencyMode,
        autoExecuteEnabled,
        rateLimitBackoff,
        uptime: process.uptime(),
      });
    }

    if (url === "/prices") {
      const prices = {};
      for (const [id, asset] of subscribedAssets) {
        const currentValue = asset.currentBid && asset.size ? asset.currentBid * asset.size : null;
        const costBasis = asset.avgPrice && asset.size ? asset.avgPrice * asset.size : null;
        prices[id.slice(0, 20)] = {
          fullAssetId: id,
          outcome: asset.outcome,
          bid: asset.currentBid,
          ask: asset.currentAsk,
          avgPrice: asset.avgPrice,
          size: asset.size,
          costBasis: costBasis?.toFixed(2),
          currentValue: currentValue?.toFixed(2),
          pnl: costBasis && currentValue ? (currentValue - costBasis).toFixed(2) : null,
          pnlPct: costBasis && currentValue ? (((currentValue - costBasis) / costBasis) * 100).toFixed(1) + "%" : null,
          strategy: getStrategy(id),
          stopLoss: asset.stopLoss || DEFAULT_STOP_LOSS,
          takeProfit: asset.takeProfit || DEFAULT_TAKE_PROFIT,
          lastUpdate: asset.lastUpdate,
        };
      }
      const _autoCap = getAutoDeployedCapital();
      return send(res, 200, {
        prices,
        portfolioValue: currentPortfolioValue,
        dailyStartValue,
        circuitBreakerTripped,
        circuitBreakerResumeAt,
        survivalMode,
        emergencyMode,
        autoExecuteEnabled,
        autoCapital: { ..._autoCap, cap: getAutoGlobalCap(), remaining: parseFloat((getAutoGlobalCap() - _autoCap.total).toFixed(2)) },
      });
    }

    if (url === "/alerts") {
      return send(res, 200, { alerts: alertLog.slice(-50) });
    }

    if (url === "/arb-results") {
      try {
        const data = JSON.parse(fs.readFileSync(ARB_RESULTS_FILE, "utf8"));
        return send(res, 200, data);
      } catch (e) {
        return send(res, 200, { error: "No arb results yet", timestamp: null });
      }
    }

    if (url === "/resolving") {
      try {
        const data = JSON.parse(fs.readFileSync(RESOLVING_FILE, "utf8"));
        return send(res, 200, data);
      } catch (e) {
        return send(res, 200, { error: "No resolving markets data yet", timestamp: null });
      }
    }

    if (url === "/resolution-hunter") {
      try {
        const data = JSON.parse(fs.readFileSync(RESOLUTION_HUNTER_FILE, "utf8"));
        return send(res, 200, data);
      } catch (e) {
        return send(res, 200, { error: "No resolution hunter data yet", timestamp: null });
      }
    }

    if (url === "/fill-stats") {
      const total = { submitted: 0, filled: 0, partial: 0, unfilled: 0 };
      for (const s of Object.values(fillStats)) {
        total.submitted += s.submitted; total.filled += s.filled;
        total.partial += s.partial; total.unfilled += s.unfilled;
      }
      return send(res, 200, {
        byStrategy: fillStats,
        total,
        fillRate: total.submitted > 0 ? ((total.filled / total.submitted) * 100).toFixed(1) + "%" : "N/A",
      });
    }

    if (url === "/weather-trades") {
      try {
        const data = JSON.parse(fs.readFileSync(WEATHER_TRADES_FILE, "utf8"));
        return send(res, 200, data);
      } catch (e) {
        return send(res, 200, { error: "No weather trades yet", timestamp: null });
      }
    }

    if (url === "/status") {
      const state = loadTradingState();
      return send(res, 200, {
        infrastructure: {
          executor: "localhost:3002",
          wsFeed: `localhost:${FEED_PORT}`,
          wsConnected: ws?.readyState === WebSocket.OPEN,
          uptime: process.uptime(),
        },
        portfolio: {
          trackedPositions: subscribedAssets.size,
          portfolioValue: currentPortfolioValue,
          dailyStartValue,
          // No startingCapital — P&L is chain-truth only
        },
        risk: {
          circuitBreakerTripped,
          circuitBreakerResumeAt,
          survivalMode,
          emergencyMode,
          autoExecuteEnabled,
          rateLimitBackoff,
          rateLimitResumeAt,
          maxDailyDrawdown: MAX_DAILY_DRAWDOWN,
          defaultStopLoss: DEFAULT_STOP_LOSS,
          defaultTakeProfit: DEFAULT_TAKE_PROFIT,
        },
        autoCapital: {
          ...getAutoDeployedCapital(),
          cap: getAutoGlobalCap(),
          remaining: parseFloat((getAutoGlobalCap() - getAutoDeployedCapital().total).toFixed(2)),
          capPct: AUTO_GLOBAL_CAP_PCT,
        },
        recentAlerts: alertLog.slice(-10),
      });
    }

    // POST endpoints
    if (method === "POST") {
      const body = await parseBody(req);

      if (url === "/set-trigger") {
        const asset = subscribedAssets.get(body.assetId);
        if (!asset) return send(res, 404, { error: "Asset not tracked" });
        if (body.stopLoss !== undefined) asset.stopLoss = parseFloat(body.stopLoss);
        if (body.takeProfit !== undefined) asset.takeProfit = parseFloat(body.takeProfit);
        // Reset trigger flags if thresholds changed
        asset._stopLossTriggered = false;
        asset._takeProfitTriggered = false;
        
        const alerts = loadAlerts();
        if (!alerts.positions) alerts.positions = {};
        alerts.positions[body.assetId] = { stopLoss: asset.stopLoss, takeProfit: asset.takeProfit };
        saveAlerts(alerts);
        return send(res, 200, { ok: true, stopLoss: asset.stopLoss, takeProfit: asset.takeProfit });
      }

      if (url === "/add-position") {
        // Manual position injection for trades executor can't track
        // Persisted to manual-positions.json — survives restarts
        const { assetId, market, outcome, avgPrice, size, stopLoss, takeProfit, strategy } = body;
        if (!assetId || !avgPrice || !size) return send(res, 400, { error: "Need assetId, avgPrice, size" });

        // Tag strategy (default 'manual' for manually added positions)
        tagStrategy(assetId, strategy || 'manual', { market: market?.slice(0, 60) });

        const posData = {
          market: market || "manual",
          strategy: strategy || 'manual',
          outcome: outcome || "Unknown",
          avgPrice: parseFloat(avgPrice),
          size: parseFloat(size),
          totalCost: parseFloat(avgPrice) * parseFloat(size),
          stopLoss: stopLoss ? parseFloat(stopLoss) : DEFAULT_STOP_LOSS,
          takeProfit: takeProfit ? parseFloat(takeProfit) : DEFAULT_TAKE_PROFIT,
          _manual: true,
          addedAt: new Date().toISOString(),
        };

        subscribedAssets.set(assetId, {
          ...subscribedAssets.get(assetId),
          ...posData,
        });

        // Persist to file
        const manualPositions = loadManualPositions();
        manualPositions[assetId] = posData;
        saveManualPositions(manualPositions);

        subscribe([assetId]);
        log("MANUAL", `Added + persisted position: ${outcome} ${size} @ ${avgPrice}`);
        return send(res, 200, { ok: true, tracked: subscribedAssets.size });
      }

      if (url === "/remove-position") {
        // Remove a manual position permanently
        const { assetId } = body;
        if (!assetId) return send(res, 400, { error: "Need assetId" });

        subscribedAssets.delete(assetId);

        // Remove from persisted file
        const manualPositions = loadManualPositions();
        delete manualPositions[assetId];
        saveManualPositions(manualPositions);

        log("MANUAL", `Removed position: ${assetId.slice(0,20)}`);
        return send(res, 200, { ok: true, tracked: subscribedAssets.size });
      }

      if (url === "/reset-circuit-breaker") {
        circuitBreakerTripped = false;
        circuitBreakerResumeAt = null;
        dailyStartValue = currentPortfolioValue;
        log("CB", "Circuit breaker manually reset");
        return send(res, 200, { ok: true });
      }

      if (url === "/toggle-auto-execute") {
        autoExecuteEnabled = !autoExecuteEnabled;
        log("CONFIG", `Auto-execute: ${autoExecuteEnabled}`);
        return send(res, 200, { ok: true, autoExecuteEnabled });
      }
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
}

function send(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => data += c);
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
  });
}

// === PNL HISTORY RECORDING ===
function recordPnlSnapshot() {
  if (currentPortfolioValue == null) return;
  
  const state = loadTradingState();
  const liquid = state?.liquidBalance || 0;
  const totalValue = currentPortfolioValue + liquid;
  
  const snapshot = {
    timestamp: new Date().toISOString(),
    positionValue: +currentPortfolioValue.toFixed(2),
    liquidBalance: +liquid.toFixed(2),
    totalValue: +totalValue.toFixed(2),
    trackedPositions: subscribedAssets.size,
    circuitBreakerTripped,
    survivalMode,
    emergencyMode,
  };

  try {
    let history = [];
    try { history = JSON.parse(fs.readFileSync(PNL_HISTORY_FILE, "utf8")); } catch (e) {}
    history.push(snapshot);
    // Keep last 2000 entries (~7 days at 5 min intervals)
    if (history.length > 2000) history = history.slice(-2000);
    fs.writeFileSync(PNL_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    log("PNL", `Failed to record snapshot: ${e.message}`);
  }
}

// === ARB SCANNER (integrated from arb-scanner.js) ===
// sleep() defined near line 294

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function runArbScan() {
  log("ARB", "Starting arb scan...");
  try {
    const events = await fetchJSON(`${GAMMA_API}/events?limit=100&active=true&closed=false&order=volume24hr&ascending=false`);
    const negRisk = events.filter(e => e.negRisk || e.enableNegRisk);
    log("ARB", `Found ${negRisk.length} NegRisk events out of ${events.length} total`);

    const opportunities = [];

    for (const event of negRisk) {
      const markets = (event.markets || []).filter(m => m.active && !m.closed);
      if (markets.length < 2) continue;

      // Sum mid YES prices from Gamma data
      let midSum = 0;
      const outcomes = [];

      for (const m of markets) {
        let yesPrice = 0;
        try {
          const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          yesPrice = parseFloat(prices[0]) || 0;
        } catch (e) {}

        let tokenId = null;
        try {
          const tokens = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
          tokenId = tokens[0];
        } catch (e) {}

        midSum += yesPrice;
        if (yesPrice > 0.001) {
          outcomes.push({ name: (m.question || "").slice(0, 60), yesPrice, tokenId });
        }
      }

      const deviation = Math.abs(midSum - 1.0);
      if (deviation < ARB_THRESHOLD) continue;

      // Skip events with too many outcomes (thin markets)
      if (outcomes.length > 20) {
        log("ARB", `SKIPPED: ${event.title.slice(0, 60)} | ${outcomes.length} outcomes (too many) | MidSum: ${midSum.toFixed(4)}`);
        continue;
      }
      log("ARB", `FLAGGED: ${event.title.slice(0, 60)} | MidSum: ${midSum.toFixed(4)} | Dev: ${(deviation * 100).toFixed(1)}%`);

      let execSum = 0;
      let allOk = true;
      for (const o of outcomes) {
        if (!o.tokenId) { allOk = false; continue; }
        try {
          await sleep(700); // rate limit
          const d = await fetchJSON(`${PROXY_API}/price?token_id=${o.tokenId}&side=buy`);
          o.execPrice = parseFloat(d.price) || 0;
          execSum += o.execPrice;
        } catch (e) {
          o.execPrice = 0;
          allOk = false;
        }
      }

      const type = midSum > 1.0 ? "SHORT" : "LONG";
      const execDev = Math.abs(execSum - 1.0);
      const grossProfit = type === "SHORT" ? (execSum - 1.0) * 100 : (1.0 - execSum) * 100;
      
      // Fee accounting: taker fee on each leg (most NegRisk markets are fee-free)
      const mktType = detectMarketType(event.title, event.slug);
      let totalFeePer100 = 0;
      for (const o of outcomes) {
        if (o.execPrice > 0) {
          totalFeePer100 += takerFeePerShare(o.execPrice, mktType) * 100;
        }
      }
      const profit = grossProfit - totalFeePer100;

      opportunities.push({
        event: event.title,
        slug: event.slug,
        type,
        outcomes: outcomes.length,
        midSum: +midSum.toFixed(4),
        execSum: allOk ? +execSum.toFixed(4) : null,
        deviation: +(deviation * 100).toFixed(2),
        execDeviation: allOk ? +(execDev * 100).toFixed(2) : null,
        grossProfitPer100: +grossProfit.toFixed(2),
        feesPer100: +totalFeePer100.toFixed(2),
        profitPer100: +profit.toFixed(2),
        viable: profit > 0 && allOk,
        details: outcomes.map(o => ({ name: o.name, mid: o.yesPrice, exec: o.execPrice, token: o.tokenId })),
      });
    }

    const output = {
      timestamp: new Date().toISOString(),
      summary: {
        total: events.length,
        negRisk: negRisk.length,
        flagged: opportunities.length,
        viable: opportunities.filter(o => o.viable).length,
      },
      opportunities: opportunities.sort((a, b) => b.profitPer100 - a.profitPer100),
    };

    fs.writeFileSync(ARB_RESULTS_FILE, JSON.stringify(output, null, 2));
    log("ARB", `✅ Scan complete — Flagged: ${opportunities.length} | Viable: ${output.summary.viable} → ${ARB_RESULTS_FILE}`);

    // === ARB AUTO-EXECUTION ===
    if (!circuitBreakerTripped && !emergencyMode && !survivalMode && autoExecuteEnabled) {
      const ARB_MIN_PROFIT = 5;     // min 5% profit per $100
      const ARB_MAX_OUTCOMES = 10;  // max 10 legs
      const ARB_MAX_SPEND = 20;     // max $20 per arb
      const ARB_MIN_PROFIT_FLAT = 0.50; // min $0.50 absolute profit
      // Persist executed arb slugs to survive restarts
      const ARB_EXECUTED_FILE = path.join(__dirname, "..", "arb-executed.json");
      let arbExecutedSlugs;
      try { arbExecutedSlugs = new Set(JSON.parse(fs.readFileSync(ARB_EXECUTED_FILE, "utf8"))); } catch { arbExecutedSlugs = new Set(); }

      for (const opp of opportunities) {
        if (!opp.viable) continue;
        if (opp.type !== "LONG") continue; // only buy-all-YES arbs for now
        if (opp.profitPer100 < ARB_MIN_PROFIT) continue;
        if (opp.outcomes > ARB_MAX_OUTCOMES) continue;
        if (!opp.execSum || opp.execSum >= 1.0) continue;
        if (arbExecutedSlugs.has(opp.slug)) continue; // already executed this arb

        // Calculate size: buy 1 share of each outcome costs execSum
        // Profit per set = 1.00 - execSum
        const profitPerSet = 1.0 - opp.execSum;
        const maxSets = Math.floor(ARB_MAX_SPEND / opp.execSum);
        const sets = Math.min(maxSets, 50); // cap at 50 sets
        const totalSpend = (sets * opp.execSum).toFixed(2);
        const totalProfit = (sets * profitPerSet).toFixed(2);

        if (parseFloat(totalProfit) < ARB_MIN_PROFIT_FLAT) continue;

        // Global auto-capital cap check
        const arbCapCheck = checkAutoCapBudget("arb", parseFloat(totalSpend));
        if (!arbCapCheck.allowed) {
          log("ARB", `Skipping "${opp.event.slice(0,40)}" — global auto-cap exceeded`);
          break; // stop trying more arbs this cycle
        }

        // Depth check across all legs — find minimum fillable sets
        let minDepthSets = sets;
        let depthCheckFailed = false;
        try {
          for (const d of opp.details.filter(dd => dd.token && dd.exec > 0)) {
            const legBook = await httpGet(`/book?token_id=${d.token}`);
            const legDepth = checkBookDepth(legBook, sets, `ARB-leg: ${d.name?.slice(0,30) || d.token.slice(0,12)}`);
            if (legDepth.skip) { depthCheckFailed = true; break; }
            if (legDepth.size < minDepthSets) minDepthSets = legDepth.size;
            await sleep(300); // rate limit between leg checks
          }
        } catch (e) {
          log("ARB", `Depth check failed: ${e.message}`);
          depthCheckFailed = true;
        }
        if (depthCheckFailed || minDepthSets < DEPTH_MIN_SHARES) {
          log("ARB", `Skipping "${opp.event.slice(0,40)}" — insufficient depth across legs`);
          continue;
        }

        const depthAdjustedSets = minDepthSets;
        const adjTotalSpend = (depthAdjustedSets * opp.execSum).toFixed(2);
        const adjTotalProfit = (depthAdjustedSets * profitPerSet).toFixed(2);

        log("ARB", `🎯 AUTO-EXEC: "${opp.event.slice(0,50)}" — ${depthAdjustedSets} sets @ $${opp.execSum.toFixed(3)}/set = $${adjTotalSpend} spend, $${adjTotalProfit} profit${depthAdjustedSets < sets ? ` (depth-reduced from ${sets})` : ""}`);

        try {
          // Build legs for the arb endpoint
          const legs = opp.details
            .filter(d => d.token && d.exec > 0)
            .map(d => ({
              tokenID: d.token,
              price: d.exec,
              size: depthAdjustedSets,
              side: "BUY",
            }));

          if (legs.length !== opp.outcomes) {
            log("ARB", `⚠️ Leg count mismatch (${legs.length} vs ${opp.outcomes}) — skipping`);
            continue;
          }

          const arbResult = await httpPost("/arb", { legs });
          log("ARB", `Arb result: ${JSON.stringify(arbResult).slice(0, 300)}`);

          // Arbs use FOK — fill tracking from executor response
          const arbStrat = fillStats.arb || (fillStats.arb = { submitted: 0, filled: 0, partial: 0, unfilled: 0 });
          arbStrat.submitted++;
          if (arbResult.status === "ALL_FILLED") {
            arbStrat.filled++;
            sendTelegramAlert(`✅ ARB FILLED: "${opp.event.slice(0,50)}"\n${depthAdjustedSets} sets @ $${opp.execSum.toFixed(3)}/set\nSpend: $${adjTotalSpend} | Expected profit: $${adjTotalProfit}\nLegs: ${legs.length}`);
          } else if (arbResult.status === "PARTIAL_FILL_UNWOUND") {
            arbStrat.partial++;
            sendTelegramAlert(`⚠️ ARB PARTIAL (unwound): "${opp.event.slice(0,50)}"\n${arbResult.filled?.length}/${legs.length} legs filled — remainder unwound`);
            saveFillStats();
            continue; // don't tag or persist — position was unwound
          } else {
            arbStrat.unfilled++;
            sendTelegramAlert(`❌ ARB FAILED: "${opp.event.slice(0,50)}" — all legs rejected (FOK)`);
            saveFillStats();
            continue; // don't tag or persist
          }
          saveFillStats();
          
          // Tag all legs with arb strategy
          for (const leg of legs) {
            tagStrategy(leg.tokenID, 'arb', { event: opp.event?.slice(0, 60), slug: opp.slug });
          }

          // Persist to prevent re-executing after restart
          arbExecutedSlugs.add(opp.slug);
          try { fs.writeFileSync(ARB_EXECUTED_FILE, JSON.stringify([...arbExecutedSlugs])); } catch {}
        } catch (e) {
          log("ARB", `❌ Arb execution failed: ${e.message}`);
        }

        break; // only execute 1 arb per cycle
      }
    }
  } catch (e) {
    log("ARB", `❌ Scan failed: ${e.message}`);
  }
}

// === RESOLVING MARKETS SCANNER ===
async function runResolvingScan() {
  log("RESOLVE", "Fetching markets resolving in 6-12h...");
  try {
    const now = new Date();
    const min6h = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const max12h = new Date(now.getTime() + 12 * 60 * 60 * 1000);

    // Gamma API: fetch markets closing soon
    // Use end_date_min/end_date_max to filter resolution window
    const url = `${GAMMA_API}/markets?closed=false&active=true&end_date_min=${min6h.toISOString()}&end_date_max=${max12h.toISOString()}&limit=100&order=volume&ascending=false`;
    const markets = await fetchJSON(url);

    const results = [];
    for (const m of markets) {
      let yesPrice = null, noPrice = null;
      try {
        const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        yesPrice = parseFloat(prices[0]) || null;
        noPrice = parseFloat(prices[1]) || null;
      } catch (e) {}

      results.push({
        slug: m.slug || m.conditionId,
        question: m.question || m.title || "Unknown",
        yesPrice,
        noPrice,
        endDate: m.endDate || m.end_date_iso || null,
        volume: parseFloat(m.volume) || 0,
        volume24hr: parseFloat(m.volume24hr) || 0,
        liquidity: parseFloat(m.liquidity) || 0,
        conditionId: m.conditionId || null,
      });
    }

    // Sort by volume descending
    results.sort((a, b) => b.volume - a.volume);

    const output = {
      timestamp: new Date().toISOString(),
      windowStart: min6h.toISOString(),
      windowEnd: max12h.toISOString(),
      count: results.length,
      markets: results,
    };

    fs.writeFileSync(RESOLVING_FILE, JSON.stringify(output, null, 2));
    log("RESOLVE", `✅ Found ${results.length} markets resolving in 6-12h → ${RESOLVING_FILE}`);
  } catch (e) {
    log("RESOLVE", `❌ Resolving scan failed: ${e.message}`);
  }
}

// === AUTO-NAME REGISTRATION ===
const MARKET_NAMES_FILE = path.join(__dirname, "market-names.json");
function registerMarketName(conditionId, name) {
  if (!conditionId || !name) return;
  try {
    let names = {};
    try { names = JSON.parse(fs.readFileSync(MARKET_NAMES_FILE, "utf8")); } catch {}
    if (names[conditionId]) return; // already named
    names[conditionId] = name;
    fs.writeFileSync(MARKET_NAMES_FILE, JSON.stringify(names, null, 2));
    log("NAMES", `Registered: ${conditionId.slice(0,10)} → ${name}`);
  } catch (e) { log("NAMES", `Failed to register name: ${e.message}`); }
}

// === RESOLUTION HUNTER (auto-buy near-resolved markets) ===
const RESOLUTION_HUNTER_INTERVAL = 15 * 60 * 1000; // every 15 min
const RESOLUTION_HUNTER_FILE = path.join(__dirname, "..", "resolution-hunter.json");
const RH_EXECUTED_FILE = path.join(__dirname, "..", "rh-executed.json");
const RH_MIN_PRICE = 0.95;      // only buy outcomes priced 95¢+
const RH_MAX_PRICE = 0.98;      // backtest shows 95-98¢ is profitable, 98-99.5¢ is toxic
const RH_MAX_SPEND = 10;        // reduced from $15 for live validation period
const RH_MIN_LIQUIDITY = 500;   // min $500 liquidity
const RH_RESOLUTION_WINDOW_H = 6; // markets resolving within 6 hours
const RH_MIN_VOLUME_24H = 1000; // min $1K 24h volume (filters illiquid junk)

// Persist executed conditionIds to survive restarts
let rhExecutedIds = new Set();
try { rhExecutedIds = new Set(JSON.parse(fs.readFileSync(RH_EXECUTED_FILE, "utf8"))); } catch {}
function saveRhExecuted() {
  try { fs.writeFileSync(RH_EXECUTED_FILE, JSON.stringify([...rhExecutedIds])); } catch {}
}

async function runResolutionHunter() {
  if (circuitBreakerTripped || emergencyMode || survivalMode) {
    log("RH", "Skipping — risk mode active");
    return;
  }

  log("RH", "Scanning for resolution harvesting opportunities...");
  try {
    const now = new Date();
    const min = new Date(now.getTime() + 30 * 60 * 1000);  // at least 30min out (avoid already-resolving)
    const max = new Date(now.getTime() + RH_RESOLUTION_WINDOW_H * 60 * 60 * 1000);

    const url = `${GAMMA_API}/markets?closed=false&active=true&end_date_min=${min.toISOString()}&end_date_max=${max.toISOString()}&limit=100&order=volume&ascending=false`;
    const markets = await fetchJSON(url);

    const candidates = [];
    const executed = [];

    for (const m of markets) {
      try {
        const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        const tokenIds = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        const outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
        const vol24h = parseFloat(m.volume24hr) || 0;
        const liquidity = parseFloat(m.liquidityClob || m.liquidity) || 0;

        if (vol24h < RH_MIN_VOLUME_24H) continue;
        if (liquidity < RH_MIN_LIQUIDITY) continue;
        if (!tokenIds || tokenIds.length < 2) continue;

        // Check each outcome
        for (let i = 0; i < prices.length; i++) {
          const price = parseFloat(prices[i]);
          if (price >= RH_MIN_PRICE && price <= RH_MAX_PRICE) {
            const tokenId = tokenIds[i];
            const outcome = outcomes[i] || (i === 0 ? "Yes" : "No");
            const mktType = detectMarketType(m.question, m.slug);
            const feePerShare = takerFeePerShare(price, mktType);
            const sharesPerDollar = 1 / price;
            const grossProfit = (1.0 - price) * RH_MAX_SPEND / price;
            const totalFees = feePerShare * Math.floor(RH_MAX_SPEND / price);
            const netProfit = grossProfit - totalFees;
            // Skip if net profit < 0.5¢ per share (not worth it after fees)
            const netProfitPerShare = (1.0 - price) - feePerShare;
            if (netProfitPerShare < 0.005) continue;
            const expectedProfit = netProfit.toFixed(2);
            
            candidates.push({
              market: (m.question || m.title || "").slice(0, 80),
              outcome,
              price,
              tokenId,
              liquidity,
              vol24h,
              endDate: m.endDate || m.end_date_iso,
              expectedProfit: `$${expectedProfit}`,
              conditionId: m.conditionId,
            });
          }
        }
      } catch (e) { /* skip malformed */ }
    }

    // Sort by best price (highest = most certain = safest)
    candidates.sort((a, b) => b.price - a.price);

    // Auto-execute: buy top candidates (max 3 per cycle to limit exposure)
    let tradesThisCycle = 0;
    const MAX_TRADES_PER_CYCLE = 3;

    for (const c of candidates) {
      if (tradesThisCycle >= MAX_TRADES_PER_CYCLE) break;

      // Check if we already hold this position or previously executed
      if (subscribedAssets.has(c.tokenId)) {
        log("RH", `Already holding ${c.market.slice(0,40)} — skip`);
        continue;
      }
      if (rhExecutedIds.has(c.conditionId)) {
        continue; // silently skip — already traded this market
      }

      // Calculate size: spend up to RH_MAX_SPEND
      const size = Math.floor(RH_MAX_SPEND / c.price);
      if (size < 1) continue;

      // Global auto-capital cap check
      const rhSpend = size * c.price;
      const rhCapCheck = checkAutoCapBudget("resolution", rhSpend);
      if (!rhCapCheck.allowed) {
        log("RH", `Skipping "${c.market.slice(0,40)}" — global auto-cap exceeded`);
        break; // stop trying more RH trades this cycle
      }

      // Get order book and check depth
      try {
        const book = await httpGet(`/book?token_id=${c.tokenId}`);
        const depth = checkBookDepth(book, size, `RH: ${c.market.slice(0,40)}`);
        if (depth.skip) continue;

        const bestAsk = depth.bestAsk;
        size = depth.size; // may be reduced by depth check

        if (bestAsk > RH_MAX_PRICE) {
          log("RH", `${c.market.slice(0,40)}: best ask ${bestAsk} too high — skip`);
          continue;
        }

        // Place limit order at best ask (skipRiskCheck — ws-feed has its own checkAutoCapBudget)
        log("RH", `🎯 BUYING: ${size} ${c.outcome} @ ${bestAsk} on "${c.market.slice(0,50)}"`);
        const orderResult = await httpPost("/order", {
          tokenID: c.tokenId,
          price: bestAsk,
          size,
          side: "BUY",
          orderType: "GTC",
          skipRiskCheck: true,
        });

        log("RH", `Order submitted: ${JSON.stringify(orderResult).slice(0,200)}`);
        const orderID = orderResult.orderID || orderResult.id;
        
        // Confirm fill (cancel unfilled after 60s — stale RH orders are dangerous)
        const confirm = await confirmOrder(orderID, "resolution", bestAsk, 60000, `RH: ${c.market.slice(0,40)}`);
        
        if (confirm.status === "unfilled") {
          log("RH", `Order unfilled and cancelled — NOT counting as deployed`);
          continue; // don't count, don't tag, don't persist
        }

        const actualSize = confirm.status === "partial" ? confirm.sizeMatched : size;
        const actualSpend = (bestAsk * actualSize).toFixed(2);
        
        executed.push({
          ...c,
          executedPrice: bestAsk,
          executedSize: actualSize,
          spend: actualSpend,
          fillStatus: confirm.status,
          slippage: confirm.slippage?.toFixed(4) || "0",
          orderID,
        });

        // Auto-register market name for dashboard
        registerMarketName(c.conditionId, c.market);

        // Tag strategy
        tagStrategy(c.tokenId, 'resolution', { market: c.market?.slice(0, 60), conditionId: c.conditionId });

        // Persist to prevent re-buying after restart
        rhExecutedIds.add(c.conditionId);
        saveRhExecuted();

        tradesThisCycle++;
      } catch (e) {
        log("RH", `❌ Failed to execute ${c.market.slice(0,40)}: ${e.message}`);
      }
    }

    // Save results
    const output = {
      timestamp: new Date().toISOString(),
      candidates: candidates.length,
      executed: executed.length,
      trades: executed,
      topCandidates: candidates.slice(0, 10),
    };
    fs.writeFileSync(RESOLUTION_HUNTER_FILE, JSON.stringify(output, null, 2));

    if (executed.length > 0) {
      log("RH", `✅ Executed ${executed.length} resolution trades`);
      const rhFillSummary = executed.map(e => `  ${e.fillStatus === "partial" ? "⚠️" : "✅"} ${e.outcome} ${e.executedSize}sh @ ${e.executedPrice} → "${e.market.slice(0,40)}"${e.fillStatus === "partial" ? " PARTIAL" : ""}`).join("\n");
      sendTelegramAlert(`🎯 Resolution Hunter: ${executed.length} confirmed fills\n${rhFillSummary}`);
    } else {
      log("RH", `Scan complete: ${candidates.length} candidates, 0 executed`);
    }
  } catch (e) {
    log("RH", `❌ Resolution hunter failed: ${e.message}`);
  }
}

// === WEATHER SIGNAL EXECUTOR ===
// Reads weather-results.json (generated by weather-scanner.js cron)
// Auto-executes high-confidence weather signals with Kelly sizing
const WEATHER_EXECUTOR_INTERVAL = 15 * 60 * 1000; // every 15 min
const WEATHER_RESULTS_FILE = path.join(__dirname, "..", "weather-results.json");
const WEATHER_TRADES_FILE = path.join(__dirname, "..", "weather-trades.json");
const WX_MIN_EDGE = 0.08;           // 8% minimum edge for auto-execution
const WX_MIN_CONFIDENCE = 0.75;     // 75% minimum ensemble confidence
const WX_MIN_LIQUIDITY = 200;       // $200 minimum liquidity
const WX_MIN_VOLUME_24H = 500;      // $500 minimum 24h volume
const WX_MAX_TRADE_SIZE = 10;       // $10 max per individual trade
const WX_MAX_TOTAL_EXPOSURE = 50;   // $50 max total weather exposure per cycle
const WX_MAX_TRADES_PER_CYCLE = 8;  // max 8 weather trades per scan
const WX_MAX_HOURS_TO_RESOLUTION = 18; // only trade markets resolving within 18h
const WX_MAX_STALE_MINUTES = 120;   // skip if weather-results.json is >2h old

// Track executed weather trades to avoid duplicates
let weatherTradesExecuted = new Set();
try {
  const saved = JSON.parse(fs.readFileSync(WEATHER_TRADES_FILE, "utf8"));
  weatherTradesExecuted = new Set(saved.executedConditionIds || []);
} catch { /* first run */ }

function saveWeatherTrades(trades) {
  try {
    const existing = (() => { try { return JSON.parse(fs.readFileSync(WEATHER_TRADES_FILE, "utf8")); } catch { return { trades: [], executedConditionIds: [] }; } })();
    existing.trades.push(...trades);
    existing.executedConditionIds = [...weatherTradesExecuted];
    existing.lastRun = new Date().toISOString();
    fs.writeFileSync(WEATHER_TRADES_FILE, JSON.stringify(existing, null, 2));
  } catch (e) { log("WX", `Failed to save trades: ${e.message}`); }
}

async function runWeatherExecutor() {
  log("WX", "Starting weather signal executor...");
  if (circuitBreakerTripped || emergencyMode || survivalMode) {
    log("WX", "Skipping — risk mode active");
    return;
  }

  // Kill switch: disable weather executor via file flag
  if (fs.existsSync(path.join(__dirname, '..', 'WEATHER_DISABLED'))) {
    log("WX", "Weather executor DISABLED (WEATHER_DISABLED file present). Remove file to re-enable.");
    return;
  }

  // Read weather-results.json
  if (!fs.existsSync(WEATHER_RESULTS_FILE)) {
    log("WX", "No weather-results.json — scanner hasn't run yet");
    return;
  }

  let results;
  try {
    results = JSON.parse(fs.readFileSync(WEATHER_RESULTS_FILE, "utf8"));
  } catch (e) {
    log("WX", `Failed to read weather results: ${e.message}`);
    return;
  }

  // Check staleness
  const resultAge = (Date.now() - new Date(results.timestamp).getTime()) / 60000;
  if (resultAge > WX_MAX_STALE_MINUTES) {
    log("WX", `Weather results are ${resultAge.toFixed(0)}min old (max ${WX_MAX_STALE_MINUTES}) — skipping`);
    return;
  }

  const signals = results.signals || [];
  if (signals.length === 0) {
    log("WX", "No weather signals to execute");
    return;
  }

  log("WX", `Processing ${signals.length} weather signals (results age: ${resultAge.toFixed(0)}min)`);

  const now = new Date();
  const executed = [];
  let totalSpent = 0;
  let tradesThisCycle = 0;

  // Filter and sort signals
  const actionable = signals.filter(s => {
    // Must meet thresholds
    // Deduct round-trip fees from edge (weather markets are fee-free, but future-proof)
    const wxMktType = detectMarketType(s.question || '', s.slug || '');
    const wxFee = takerFeePerShare(s.marketPrice || 0.5, wxMktType);
    const netEdge = Math.abs(s.edge) - wxFee; // round-trip cost (buy fee only, sell at resolution = no fee)
    if (netEdge < WX_MIN_EDGE) return false;
    if ((s.ensembleConfidence || 0) < WX_MIN_CONFIDENCE) return false;
    if ((s.liquidity || 0) < WX_MIN_LIQUIDITY) return false;
    if ((s.volume24h || 0) < WX_MIN_VOLUME_24H) return false;
    if (s.synthetic) return false; // only trade on real ensemble data
    
    // Must resolve within window
    if (s.endDate) {
      const hoursToResolution = (new Date(s.endDate) - now) / 3600000;
      if (hoursToResolution < 0.5 || hoursToResolution > WX_MAX_HOURS_TO_RESOLUTION) return false;
    }
    
    // Skip already-executed
    if (weatherTradesExecuted.has(s.conditionId)) return false;
    
    return true;
  }).sort((a, b) => {
    // Sort by: confidence * |edge| (combined quality score)
    const scoreA = (a.ensembleConfidence || 0.5) * Math.abs(a.edge);
    const scoreB = (b.ensembleConfidence || 0.5) * Math.abs(b.edge);
    return scoreB - scoreA;
  });

  log("WX", `${actionable.length} actionable signals after filtering`);

  for (const signal of actionable) {
    if (tradesThisCycle >= WX_MAX_TRADES_PER_CYCLE) break;
    if (totalSpent >= WX_MAX_TOTAL_EXPOSURE) break;

    try {
      // Use token IDs from weather scanner output (pre-resolved via CLOB API)
      let tokenId;
      if (signal.signal === "BUY_YES") {
        tokenId = signal.yesTokenId;
      } else if (signal.signal === "BUY_NO") {
        tokenId = signal.noTokenId;
      } else {
        continue;
      }

      if (!tokenId) {
        log("WX", `No ${signal.signal === "BUY_YES" ? "YES" : "NO"} tokenId for ${signal.city} ${signal.bucket} — skip`);
        continue;
      }

      // Global auto-capital cap check (before sizing)
      const wxCapCheck = checkAutoCapBudget("weather", Math.min(signal.kellySize || WX_MAX_TRADE_SIZE, WX_MAX_TRADE_SIZE));
      if (!wxCapCheck.allowed) {
        log("WX", `Skipping ${signal.city} ${signal.bucket} — global auto-cap exceeded`);
        break; // stop trying more weather trades this cycle
      }

      // Calculate intended size using Kelly or cap
      const kellyDollars = Math.min(signal.kellySize || WX_MAX_TRADE_SIZE, WX_MAX_TRADE_SIZE);
      const remainingBudget = WX_MAX_TOTAL_EXPOSURE - totalSpent;
      const spendDollars = Math.min(kellyDollars, remainingBudget);

      // Get order book and check depth
      const wxLabel = `WX: ${signal.city} ${signal.bucket}°${signal.unit}`;
      const book = await httpGet(`/book?token_id=${tokenId}`);

      // Preliminary best ask for sizing
      const sortedAsks = (book.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })).sort((a, b) => a.price - b.price);
      const bestAsk = sortedAsks.length > 0 ? sortedAsks[0].price : null;

      if (!bestAsk) {
        log("WX", `No asks for ${signal.city} ${signal.bucket} — skip`);
        continue;
      }

      // Check that price hasn't moved against us since scan
      if (signal.signal === "BUY_YES" && bestAsk > signal.marketPrice * 1.5 + 0.02) {
        log("WX", `${signal.city} ${signal.bucket}: price moved (was ${signal.marketPrice}, now ask ${bestAsk}) — skip`);
        continue;
      }

      let size = Math.floor(spendDollars / bestAsk);
      if (size < 5) {
        log("WX", `${signal.city} ${signal.bucket}: size too small (${size} shares) — skip`);
        continue;
      }

      // Depth check — walk book, size down if thin
      const depth = checkBookDepth(book, size, wxLabel);
      if (depth.skip) continue;
      size = depth.size; // may be reduced

      // Execute!
      log("WX", `🌤️ BUYING: ${size} ${signal.signal === "BUY_YES" ? "YES" : "NO"} @ ${bestAsk} on "${signal.city} ${signal.bucket}°${signal.unit}" (edge: ${(signal.edge*100).toFixed(1)}¢, conf: ${((signal.ensembleConfidence||0)*100).toFixed(0)}%)`);
      
      const orderResult = await httpPost("/order", {
        tokenID: tokenId,
        price: bestAsk,
        size,
        side: "BUY",
        orderType: "GTC",
        skipRiskCheck: true,
      });

      const orderID = orderResult.orderID || orderResult.id;
      log("WX", `Order submitted: ${JSON.stringify(orderResult).slice(0, 200)}`);

      // Confirm fill (cancel unfilled after 60s — stale weather orders are dangerous)
      const confirm = await confirmOrder(orderID, "weather", bestAsk, 60000, wxLabel);

      if (confirm.status === "unfilled") {
        log("WX", `${wxLabel} — order unfilled and cancelled, NOT counting as deployed`);
        continue; // don't count, don't tag, don't persist
      }

      const actualSize = confirm.status === "partial" ? confirm.sizeMatched : size;
      const spend = (bestAsk * actualSize).toFixed(2);
      totalSpent += parseFloat(spend);
      tradesThisCycle++;
      weatherTradesExecuted.add(signal.conditionId);

      const trade = {
        timestamp: new Date().toISOString(),
        city: signal.city,
        date: signal.date,
        bucket: signal.bucket,
        unit: signal.unit,
        signal: signal.signal,
        tokenId,
        size: actualSize,
        price: bestAsk,
        spend,
        edge: signal.edge,
        ensembleConfidence: signal.ensembleConfidence,
        ensembleMean: signal.ensembleMean,
        ensembleStdDev: signal.ensembleStdDev,
        forecastProb: signal.forecastProb,
        orderID,
        fillStatus: confirm.status,
        slippage: confirm.slippage?.toFixed(4) || "0",
        question: signal.question?.slice(0, 100),
      };

      executed.push(trade);

      // Auto-register market name for dashboard
      const wxName = `${signal.city} ${signal.bucket}°${signal.unit} ${signal.date}`.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 40);
      registerMarketName(signal.conditionId, wxName);

      // Tag strategy
      tagStrategy(tokenId, 'weather', { market: wxName, conditionId: signal.conditionId, city: signal.city });

    } catch (e) {
      log("WX", `❌ Failed: ${signal.city} ${signal.bucket}: ${e.message}`);
    }
  }

  // Save executed trades
  if (executed.length > 0) {
    saveWeatherTrades(executed);
    log("WX", `✅ ${executed.length} weather trades executed, $${totalSpent.toFixed(2)} deployed`);
    const fillSummary = executed.map(e => `  ${e.fillStatus === "partial" ? "⚠️" : "✅"} ${e.signal} ${e.size}sh @ ${e.price} → ${e.city} ${e.bucket}°${e.unit} (edge ${(e.edge*100).toFixed(0)}¢${e.fillStatus === "partial" ? " PARTIAL" : ""})`).join("\n");
    sendTelegramAlert(`🌤️ Weather Executor: ${executed.length} trades, $${totalSpent.toFixed(2)} deployed\n${fillSummary}`);
  } else {
    log("WX", `Scan complete: ${actionable.length} actionable, 0 executed`);
  }
}

// httpPost is defined at top of file (line ~147) with rate limit handling — do not duplicate

// === REST PRICE POLLING (fallback for NegRisk tokens that don't get WS updates) ===
const REST_POLL_INTERVAL = 30 * 1000; // every 30 seconds (was 60s — tighter for SL positions)
const REST_POLL_STALE_SL = 30 * 1000;  // 30s stale threshold for positions with active stop-loss
const REST_POLL_STALE_DEFAULT = 120 * 1000; // 120s for monitoring-only positions

async function pollStalePrices() {
  const https = require("https");
  const now = Date.now();
  const staleAssets = [];

  for (const [assetId, asset] of subscribedAssets) {
    const hasStopLoss = asset.stopLoss && asset.stopLoss > 0 && asset.stopLoss < 1;
    const staleThreshold = hasStopLoss ? REST_POLL_STALE_SL : REST_POLL_STALE_DEFAULT;
    const age = asset.lastUpdate ? now - asset.lastUpdate : Infinity;

    if (age > staleThreshold) {
      // Log transition from WS-fed to REST-polled (first time only)
      if (!asset._restPolled && asset.lastUpdate) {
        const name = asset.market || getStrategy(assetId) || assetId.slice(0, 16);
        log("REST", `⚠️ ${name}: stale ${(age / 1000).toFixed(0)}s (threshold ${staleThreshold / 1000}s, SL=${hasStopLoss}) — falling back to REST`);
      }
      staleAssets.push(assetId);
    }
  }

  if (staleAssets.length === 0) return;

  for (const assetId of staleAssets) {
    const asset = subscribedAssets.get(assetId);
    if (!asset) continue;

    try {
      // Fetch buy price (= bid)
      const buyPrice = await new Promise((resolve, reject) => {
        https.get(`https://clob.polymarket.com/price?token_id=${assetId}&side=buy`, (res) => {
          let d = ""; res.on("data", c => d += c);
          res.on("end", () => { try { resolve(JSON.parse(d).price); } catch(e) { reject(e); } });
        }).on("error", reject);
      });

      // Fetch sell price (= ask)
      const askPrice = await new Promise((resolve, reject) => {
        https.get(`https://clob.polymarket.com/price?token_id=${assetId}&side=sell`, (res) => {
          let d = ""; res.on("data", c => d += c);
          res.on("end", () => { try { resolve(JSON.parse(d).price); } catch(e) { reject(e); } });
        }).on("error", reject);
      });

      const oldBid = asset.currentBid;
      asset.currentBid = parseFloat(buyPrice);
      asset.currentAsk = parseFloat(askPrice);
      asset.lastUpdate = now;
      asset._restPolled = true;

      // Check triggers with new price
      checkTriggers(assetId, asset);

      if (oldBid === undefined || oldBid === null) {
        log("REST", `First price for ${asset.market || assetId.slice(0,16)}...: bid=${asset.currentBid} ask=${asset.currentAsk}`);
      }
    } catch (e) {
      // Silently skip — will retry next interval
    }
  }
}

// === DAILY RESET ===
function scheduleDailyReset() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  const ms = tomorrow - now;

  setTimeout(() => {
    log("DAILY", "Resetting daily tracking");
    dailyStartValue = currentPortfolioValue;
    circuitBreakerTripped = false;
    circuitBreakerResumeAt = null;
    // Reset single-trade alerts
    for (const [, asset] of subscribedAssets) {
      asset._singleLossAlerted = false;
    }
    alertLog = alertLog.filter(a => Date.now() - new Date(a.timestamp).getTime() < 86400000);
    scheduleDailyReset();
  }, ms);

  log("DAILY", `Next reset in ${(ms / 3600000).toFixed(1)}h`);
}

// === MAIN ===
async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Polymarket WS Feed + Circuit Breakers   ║");
  console.log("║  v3 — Integrated Scanners                ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log();
  log("INIT", `Executor: ${EXECUTOR_URL}`);
  log("INIT", `Feed API: port ${FEED_PORT}`);
  log("INIT", `P&L: chain-truth only (no hardcoded starting capital)`);
  log("INIT", `Stop-loss: ${DEFAULT_STOP_LOSS * 100}% | Take-profit: ${DEFAULT_TAKE_PROFIT * 100}%`);
  log("INIT", `Daily drawdown limit: ${MAX_DAILY_DRAWDOWN * 100}%`);
  log("INIT", `Survival: <$${SURVIVAL_FLOOR} | Emergency: <$${EMERGENCY_FLOOR}`);
  log("INIT", `Auto-execute: ${autoExecuteEnabled}`);
  log("INIT", `Arb scanner: every ${ARB_SCAN_INTERVAL / 60000}min | Resolving: every ${RESOLVING_SCAN_INTERVAL / 60000}min | Resolution hunter: every ${RESOLUTION_HUNTER_INTERVAL / 60000}min | Weather executor: every ${WEATHER_EXECUTOR_INTERVAL / 60000}min`);
  log("INIT", `Telegram alerts: ${TELEGRAM_BOT_TOKEN ? "ENABLED" : "DISABLED (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)"}`);
  log("INIT", `PnL history: every ${PNL_RECORD_INTERVAL / 60000}min → ${PNL_HISTORY_FILE}`);
  console.log();

  // Load persisted state
  const alerts = loadAlerts();
  circuitBreakerTripped = alerts.circuitBreakerTripped || false;
  survivalMode = alerts.survivalMode || false;
  emergencyMode = alerts.emergencyMode || false;

  // Sync positions (retry up to 5x if executor not ready)
  for (let attempt = 1; attempt <= 5; attempt++) {
    await syncPositions();
    if (subscribedAssets.size > 0) break;
    log("INIT", `No positions loaded (attempt ${attempt}/5), retrying in 3s...`);
    await new Promise(r => setTimeout(r, 3000));
  }

  // Connect WebSocket
  connect();

  // Periodic sync
  setInterval(syncPositions, POSITION_SYNC_INTERVAL);

  // REST price polling for NegRisk/stale tokens (every 60s)
  setTimeout(() => {
    pollStalePrices();
    setInterval(pollStalePrices, REST_POLL_INTERVAL);
  }, 15 * 1000); // first poll after 15s startup

  // Fee change detection (v3 §7)
  let lastKnownFees = null;
  async function checkFees() {
    try {
      const https = require("https");
      const feeData = await new Promise((resolve, reject) => {
        https.get("https://docs.polymarket.com/polymarket-learn/trading/maker-rebates-program", (res) => {
          let data = "";
          res.on("data", (c) => data += c);
          res.on("end", () => resolve(data));
        }).on("error", reject);
      });
      const feeHash = require("crypto").createHash("md5").update(feeData).digest("hex");
      if (lastKnownFees && feeHash !== lastKnownFees) {
        pushAlert("FEE_CHANGE_DETECTED", null, null, null, null, 
          "⚠️ Fee structure page changed — review immediately. Halting fee-sensitive strategies.");
        log("FEES", "🚨 Fee structure change detected!");
      }
      lastKnownFees = feeHash;
    } catch (e) {
      log("FEES", `Fee check failed: ${e.message}`);
    }
  }
  checkFees();
  setInterval(checkFees, FEE_CHECK_INTERVAL);

  // PnL history recording — every 5 min
  setInterval(recordPnlSnapshot, PNL_RECORD_INTERVAL);

  // Arb scanner — runs every 15 min, first run after 30s startup delay
  setTimeout(() => {
    runArbScan();
    setInterval(runArbScan, ARB_SCAN_INTERVAL);
  }, 30 * 1000);

  // Resolving markets scanner — runs every 30 min, first run after 60s
  setTimeout(() => {
    runResolvingScan();
    setInterval(runResolvingScan, RESOLVING_SCAN_INTERVAL);
  }, 60 * 1000);

  // Resolution hunter — runs every 15 min, first run after 90s
  setTimeout(() => {
    runResolutionHunter();
    setInterval(runResolutionHunter, RESOLUTION_HUNTER_INTERVAL);
  }, 90 * 1000);

  // Weather signal executor — PERMANENTLY DISABLED (2026-02-13)
  // Backtest showed NEGATIVE EDGE: 52.7% hit rate, -$234.74 simulated P&L on 129 signals.
  // Ensemble forecasts catastrophically miscalibrated at bucket granularity.
  // Code retained in repo for future reference if better data source found.
  // See weather-backtest.json for full results.
  // setTimeout(() => {
  //   runWeatherExecutor().catch(e => log("WX", `❌ Uncaught error: ${e.message}`));
  //   setInterval(() => runWeatherExecutor().catch(e => log("WX", `❌ Uncaught error: ${e.message}`)), WEATHER_EXECUTOR_INTERVAL);
  // }, 120 * 1000);

  // Daily reset
  scheduleDailyReset();

  // Start HTTP API
  const server = http.createServer(apiHandler);
  server.listen(FEED_PORT, () => {
    log("INIT", `Feed API running on port ${FEED_PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
