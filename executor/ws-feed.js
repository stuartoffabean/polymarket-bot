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
 *   GET  /arb-results     — latest arb scanner results (NegRisk multi-outcome)
 *   GET  /binary-arb-results — latest binary arb scanner results (YES+NO pairs)
 *   GET  /resolving       — markets resolving in 6-12h
 *   POST /set-trigger     — { assetId, stopLoss, takeProfit }
 *   POST /add-position    — { assetId, market, outcome, avgPrice, size } (persisted to manual-positions.json)
 *   POST /remove-position — { assetId } (removes manual position permanently)
 *   POST /reset-circuit-breaker
 *   GET  /exit-failed      — list positions where sell permanently failed (stuck)
 *   POST /clear-exit-failed — { assetId } or {} to clear all exit-failed blocks
 */

const WebSocket = require("ws");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { logExit, getExits, getExitSummary, EXIT_REASONS } = require("./exit-ledger");
const { writeFileAtomic } = require("./safe-write");
const positionLedger = require("./position-ledger");
const { runBinaryArbScan, BINARY_ARB_RESULTS_FILE } = require("./binary-arb-scanner");

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
  "SINGLE_TRADE_LOSS",
  "PHANTOM_SELL",
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
const BINARY_ARB_SCAN_INTERVAL = 5 * 60 * 1000;  // 5 min (binary arbs are fleeting)

// Thresholds (Directive v2 §risk, v3 §7)
// P&L is chain-truth only — no hardcoded starting capital. Survival/emergency
// thresholds use absolute dollar floors instead of % of arbitrary number.
const MAX_DAILY_DRAWDOWN = 0.15;      // RE-ENABLED 2026-02-14: warmup system (checkSystemReady) now prevents false-triggers on restart
const DEFAULT_STOP_LOSS = 0.30;       // 30% loss per position
const DEFAULT_TAKE_PROFIT = 0.50;     // 50% gain per position
const SURVIVAL_FLOOR = 100;           // $100 total value → survival mode
const EMERGENCY_FLOOR = 50;           // $50 total value → emergency mode
const SINGLE_TRADE_LOSS_LIMIT_USD = 20; // $20 single trade loss → halt strategy
const DRAWDOWN_PAUSE_MS = 2 * 60 * 60 * 1000; // 2 hour pause

// === IGNORED ASSETS ===
// Ghost arb positions with corrupted avgPrice — permanently excluded from tracking.
// These are dust positions (<0.01 shares) from failed arb fills. Sunk cost, written off.
const IGNORED_ASSETS = new Set([
  // Double-sold assets (Feb 15 duplicate sell bug — settlement took >30min TTL)
  "14588689847155710140084925630833413220311051563779237763910268505586365020396",
  "73102171968254150175441789734331062683107726947580722925006610769377018279866",
  "8010270730382868588546130570365383621891724310853848910851331100920214793828",
  // Corrupted avgPrice ghosts
  "86069854998126295712887500512103672980330890383172698747999211918441355492422",
  "92692355295105043188084535345172617132941070537427143745066857388094591739498",
  "87034544787508362600520628155582601877854843596079024073643613177448200402413",
  "89850023208665827912791204459354162829290040613445798160551059612704754189351",
  "28321426810817884323028002735778558086441279106030661015331363203764252597900",
  // Dead weather positions (markets expired/resolved, no order book)
  "61128604990087042122548586390800420839327799964679640129754629783994076452623",
  "90887752002215992900699115811327800127783468839853027031678381049010443770292",
  "47317420149081151716106164007318362486945962935245728787198862430914220210967",
  "88900583850800385933127773924992016438736381408821028966855845616737191855587",
  "59738352393322328580126685992902759403890341646473609818739437825403384038067",
  "102514516731092370083970442715055648567453320955758144087542228274725507632632",
  "4744868690721394129843149460017966124816685702723027589495518997737549864171",
  "109968398822491712984169099041759237653611990413064557777859294999080708230264",
  "53112913970374706046013290270953246355085018482245770482075634513851705409571",
  "4828582791571661218921335365101498469447062828800129751506318696977295810037",
  "81886414565830455363898400247598914618904584960778707119417799714051247635429",
  // Dead arb dust positions (< $2 cost basis, no order book)
  "106893482875330829332347425550558141013488263650384566003078374608472351519383",
  "49662274238485451283220527378586398370959042852997899886824914466317758572224",
  "115034918305454824214295954991450505325341522461190524009674971926101814878692",
  "79141348498154610869711763517359858283096073835629175956943035939212249740025",
  "54334899525658175201298870146327190676678802829019336950532850893136954707611",
  "25099567166111281846302244039860015689241816252363247441459396207876081288557",
  "13056891492049623062155969471801682689874473544031899896391783479847146002407",
  "30836670145539355582839471359688902101341973319407683130497170933609025408928",
  "25138700007518255169733220174010858299639620152049125875379405583652485696742",
  // Ghost positions from stop-loss cascade (sold but still on-chain)
  "7648925155044397287047798308912067661131447591491670430094875295487039626662",
  "28328225026237327629360643111285186726736313186938816497061098367884646110898",
  "28797566188952595754532249233237210079260595405997354963532548251029768750444",
  "16680383807036024154663222348300164487828801908390056508639441371141589139909",
]);

// === STRATEGY TAGS ===
// Every position gets a strategy tag: 'weather', 'resolution', 'arb', 'manual'
// Persisted to survive restarts. SL/TP sells inherit the original buy's strategy.
const STRATEGY_TAGS_FILE = path.join(__dirname, "..", "strategy-tags.json");
let strategyTags = {}; // assetId -> { strategy, entryTime, ... }
try { strategyTags = JSON.parse(fs.readFileSync(STRATEGY_TAGS_FILE, "utf8")); } catch {}
function saveStrategyTags() {
  try { writeFileAtomic(STRATEGY_TAGS_FILE, strategyTags); } catch {}
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
let cachedCashBalance = 0;
let lastCashFetch = 0;
const CASH_FETCH_INTERVAL = 60000; // Refresh cash balance every 60s

async function fetchCashBalance() {
  try {
    const data = await httpGet("/balance");
    const newBal = data.balance || 0;
    // NEVER zero out a known-good cash balance — stale is better than missing
    if (newBal > 0 || cachedCashBalance === 0) {
      cachedCashBalance = newBal;
    } else if (newBal === 0 && cachedCashBalance > 10) {
      log("CASH", `⚠️ /balance returned $0 but cached=$${cachedCashBalance.toFixed(2)} — keeping cached (likely fetch bug)`);
      // Don't update — keep the stale but valid value
      return;
    }
    lastCashFetch = Date.now();
  } catch (e) {
    // Keep last known value on failure — NEVER zero it out
    log("CASH", `⚠️ fetchCashBalance failed: ${e.message} — keeping cached $${cachedCashBalance.toFixed(2)}`);
  }
}

let liquidBalance = null; // USDCe not in positions
let circuitBreakerTripped = false;
let circuitBreakerResumeAt = null;
let survivalMode = false;
let emergencyMode = false;
let alertLog = [];
let autoExecuteEnabled = true;
let rateLimitBackoff = false;
let rateLimitResumeAt = null;

// === STARTUP WARMUP SYSTEM ===
// Prevents false emergency/survival triggers on restart.
// systemReady stays false until: (1) syncPositions completed at least once AND
// (2) ≥80% of tracked positions have received a price update (WS or REST).
let systemReady = false;
let systemReadyAt = 0;  // timestamp when system became ready
const STARTUP_GRACE_PERIOD = 60 * 1000; // 60s grace period — no auto-executes after restart
let syncCompletedOnce = false;

// === HELPERS ===
function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function loadAlerts() {
  try { return JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8")); }
  catch (e) { return { positions: {}, pending: [], circuitBreakerTripped: false }; }
}

function saveAlerts(data) {
  writeFileAtomic(ALERTS_FILE, data);
}

function loadManualPositions() {
  try { return JSON.parse(fs.readFileSync(MANUAL_POSITIONS_FILE, "utf8")); }
  catch (e) { return {}; }
}

function saveManualPositions(data) {
  writeFileAtomic(MANUAL_POSITIONS_FILE, data);
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
function saveFillStats() { try { writeFileAtomic(FILL_STATS_FILE, fillStats); } catch {} }

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
let lastDisconnectAlertMs = 0;
const DISCONNECT_ALERT_COOLDOWN = 300000; // 5 minutes between disconnect alerts
async function handleDisconnect() {
  if (pingTimer) clearInterval(pingTimer);
  if (wsSilentCheckTimer) clearInterval(wsSilentCheckTimer);
  log("WS", "🚨 Disconnected — cancelling all open orders (v3 §7)");
  try {
    const result = await httpDelete("/orders");
    log("WS", `Cancel all orders result: ${JSON.stringify(result)}`);
    const now = Date.now();
    if (now - lastDisconnectAlertMs > DISCONNECT_ALERT_COOLDOWN) {
      pushAlert("WS_DISCONNECT", null, null, null, null, "Cancelled all open orders on disconnect");
      lastDisconnectAlertMs = now;
    } else {
      log("WS", "(disconnect alert suppressed — cooldown active)");
    }
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

  if (!systemReady) return; // skip triggers during warmup
  if (emergencyMode) return; // no trading in emergency

  // EARLY EXIT: If this asset already has a sell in progress or was recently sold,
  // skip ALL trigger evaluation. This prevents the duplicate execution bug where
  // multiple triggers (stop-loss + trailing stop + take-profit) fire from the same
  // checkTriggers() call, or re-fire on restart before on-chain state catches up.
  if (sellLocks.has(assetId)) return;
  if (recentlySold.has(assetId)) return;
  // Exit-failed assets: sell exhausted all retries, waiting for manual intervention or resolution
  if (exitFailed.has(assetId)) return;
  // Cooldown after unfilled sell — wait before re-triggering
  if (asset._sellCooldownUntil && Date.now() < asset._sellCooldownUntil) return;

  const costBasis = asset.avgPrice * asset.size;
  const currentValue = currentPrice * asset.size;
  const pnlPct = (currentValue - costBasis) / costBasis;
  const pnlAbs = currentValue - costBasis;

  // ── TRAILING STOP ──
  // When position reaches +20% unrealized, ratchet stop-loss to breakeven.
  // Stop trails 20 points below the high water mark and never goes back down.
  const TRAILING_ACTIVATION = 0.20;  // activate at +20%
  const TRAILING_DISTANCE  = 0.20;   // trail 20 points below HWM
  
  if (!asset._highWaterPnlPct) asset._highWaterPnlPct = 0;
  
  if (pnlPct > asset._highWaterPnlPct) {
    asset._highWaterPnlPct = pnlPct;
  }
  
  if (asset._highWaterPnlPct >= TRAILING_ACTIVATION) {
    // Calculate trailing stop as a loss percentage from entry
    // HWM=0.20 → trailStop=0 (breakeven), HWM=0.40 → trailStop=0.20 (lock +20%)
    const trailStopPnl = asset._highWaterPnlPct - TRAILING_DISTANCE;
    // Convert P&L threshold to a stop-loss value (stopLoss is a positive loss %)
    // If trailStopPnl=0 → stopLoss=0 (sell if ANY loss), trailStopPnl=0.20 → stopLoss=-0.20 (sell if drops below +20%)
    // We express this as a price floor instead
    const trailFloorPrice = asset.avgPrice * (1 + trailStopPnl);
    
    // Only ratchet UP, never down
    if (!asset._trailingFloor || trailFloorPrice > asset._trailingFloor) {
      const oldFloor = asset._trailingFloor;
      asset._trailingFloor = trailFloorPrice;
      
      if (!oldFloor) {
        log("TRAIL", `🔒 TRAILING STOP ACTIVATED: ${asset.market || assetId.slice(0,20)} — floor=${trailFloorPrice.toFixed(4)} (breakeven) at +${(pnlPct*100).toFixed(1)}%`);
        pushAlert("TRAILING_STOP_ACTIVATED", assetId, asset, currentPrice, pnlPct,
          `Trailing stop engaged. Floor: $${trailFloorPrice.toFixed(4)} (breakeven). HWM: +${(asset._highWaterPnlPct*100).toFixed(1)}%`);
      } else if (trailFloorPrice > oldFloor * 1.02) { // only log if floor moved >2% to avoid spam
        log("TRAIL", `📈 TRAILING STOP RATCHETED: ${asset.market || assetId.slice(0,20)} — floor=${trailFloorPrice.toFixed(4)} (was ${oldFloor.toFixed(4)}) at +${(pnlPct*100).toFixed(1)}%`);
      }
    }
    
    // Check if price has fallen through the trailing floor
    if (asset._trailingFloor && currentPrice <= asset._trailingFloor && !asset._trailingStopTriggered) {
      asset._trailingStopTriggered = true;
      const lockedPnl = ((asset._trailingFloor - asset.avgPrice) / asset.avgPrice * 100).toFixed(1);
      const strat = getStrategy(assetId);
      pushAlert("TRAILING_STOP", assetId, asset, currentPrice, pnlPct,
        `AUTO-SELLING [${strat}] — Floor $${asset._trailingFloor.toFixed(4)} breached. Locked +${lockedPnl}% from HWM +${(asset._highWaterPnlPct*100).toFixed(1)}%`);
      if (autoExecuteEnabled && !circuitBreakerTripped) {
        executeSell(assetId, asset, "TRAILING_STOP");
        return; // don't check other triggers after trailing stop fires
      }
    }
  }
  
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
    return; // don't check take-profit after stop-loss fires
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

// Per-assetId sell lock — prevents duplicate sell executions
const sellLocks = new Set();
// Recently sold assets — prevents syncPositions from re-adding them
// Persisted to disk so they survive restarts
const recentlySold = new Map(); // assetId -> timestamp
const RECENTLY_SOLD_TTL = 2 * 60 * 60 * 1000; // 2 hours — on-chain settlement can take 30-60min, 30min TTL caused duplicate sells
const RECENTLY_SOLD_FILE = path.join(__dirname, 'recently-sold.json');

// Exit-failed assets — sells exhausted all retries, position stuck
// Persisted to disk so they survive restarts (unlike _exitFailed which was in-memory only)
// Cleared only via POST /clear-exit-failed or manual file edit
const exitFailed = new Map(); // assetId -> { timestamp, retries, reason, market, size, avgPrice }
const EXIT_FAILED_FILE = path.join(__dirname, 'exit-failed.json');

// Load persisted sold assets on startup
try {
  if (fs.existsSync(RECENTLY_SOLD_FILE)) {
    const saved = JSON.parse(fs.readFileSync(RECENTLY_SOLD_FILE, 'utf8'));
    const now = Date.now();
    for (const [id, ts] of Object.entries(saved)) {
      if (now - ts < RECENTLY_SOLD_TTL) recentlySold.set(id, ts);
    }
    log("INIT", `Loaded ${recentlySold.size} recently sold assets from disk (${Object.keys(saved).length - recentlySold.size} expired)`);
  }
} catch (e) { log("INIT", `Failed to load recently-sold.json: ${e.message}`); }

// Load persisted exit-failed assets on startup
try {
  if (fs.existsSync(EXIT_FAILED_FILE)) {
    const saved = JSON.parse(fs.readFileSync(EXIT_FAILED_FILE, 'utf8'));
    for (const [id, info] of Object.entries(saved)) {
      exitFailed.set(id, info);
    }
    log("INIT", `Loaded ${exitFailed.size} exit-failed assets from disk — these will NOT auto-sell until cleared`);
  }
} catch (e) { log("INIT", `Failed to load exit-failed.json: ${e.message}`); }

function persistRecentlySold() {
  try {
    const obj = Object.fromEntries(recentlySold);
    fs.writeFileSync(RECENTLY_SOLD_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { log("EXEC", `Failed to persist recently-sold.json: ${e.message}`); }
}

function persistExitFailed() {
  try {
    const obj = Object.fromEntries(exitFailed);
    fs.writeFileSync(EXIT_FAILED_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { log("EXEC", `Failed to persist exit-failed.json: ${e.message}`); }
}

// v5: Escalating slippage table for auto-sell retries
// Each retry accepts worse fill prices to increase fill probability
// Retry 0: 3% slippage (realistic starting point for thin markets)
// Retry 1: 10% slippage, 15s cooldown
// Retry 2: 25% slippage (aggressive exit), 15s cooldown
// Retry 3: 40% slippage (nuclear — last resort before permanent fail), 15s cooldown
// v5: Start at 3% (0% always fails in thin/moving markets, wastes 30s).
// 4 levels: 3% → 10% → 25% → 40% (nuclear). 15s cooldown (was 30s).
// Total retry cycle: 45s (was 90s). Gets to aggressive slippage faster.
const SELL_RETRY_SLIPPAGE = [0.03, 0.10, 0.25, 0.40];
const SELL_RETRY_COOLDOWN_MS = 15 * 1000; // 15s between retries (was 30s — too slow when capital at risk)
const MAX_SELL_RETRIES = SELL_RETRY_SLIPPAGE.length;

async function executeSell(assetId, asset, reason) {
  // STARTUP GRACE PERIOD — don't auto-execute for 60s after system becomes ready
  // This prevents false triggers from stale positions that get re-synced on restart
  if (systemReadyAt > 0 && (Date.now() - systemReadyAt) < STARTUP_GRACE_PERIOD) {
    log("EXEC", `⏸️ GRACE PERIOD: Skipping ${reason} for ${assetId.slice(0,20)} — ${((STARTUP_GRACE_PERIOD - (Date.now() - systemReadyAt)) / 1000).toFixed(0)}s remaining`);
    return;
  }
  // Check sell lock — only one sell per asset at a time
  if (sellLocks.has(assetId)) {
    log("EXEC", `🔒 SELL LOCKED: ${assetId.slice(0,20)} — sell already in progress, skipping duplicate ${reason}`);
    return;
  }
  sellLocks.add(assetId);

  // Determine current retry attempt and slippage
  if (!asset._sellRetries) asset._sellRetries = 0;
  const attempt = asset._sellRetries;
  const slippagePct = SELL_RETRY_SLIPPAGE[Math.min(attempt, SELL_RETRY_SLIPPAGE.length - 1)];
  
  log("EXEC", `🚨 AUTO-SELL: ${asset.outcome} ${asset.size} shares (${reason}) — attempt ${attempt + 1}/${MAX_SELL_RETRIES}, slippage ${(slippagePct * 100).toFixed(0)}%, FOK`);
  try {
    const result = await httpPost("/market-sell", {
      tokenID: assetId,
      size: asset.size,
      orderType: "FOK",
      slippagePct: slippagePct,
      reason: reason,
      source: "ws-feed-auto",
      strategy: getStrategy(assetId),
    });
    log("EXEC", `Sell result: ${JSON.stringify(result)}`);

    // ── FILL VERIFICATION ──
    // v4: executor now returns fillStatus directly, but also check order status
    const isFilled = result.fillStatus === "filled" || 
      String(result.status || "").toLowerCase() === "matched" || 
      String(result.status || "").toLowerCase() === "filled";

    if (!isFilled) {
      // FOK order was killed (no fill) — no dangling orders to cancel
      asset._sellRetries++;
      
      if (asset._sellRetries >= MAX_SELL_RETRIES) {
        // Exhausted all retry levels — mark as exit_failed permanently
        asset._exitFailed = true;
        asset._sellCooldownUntil = Infinity;
        exitFailed.set(assetId, {
          timestamp: Date.now(),
          isoTime: new Date().toISOString(),
          retries: MAX_SELL_RETRIES,
          reason,
          market: asset._marketName || asset._market || asset.market || `Asset ${assetId.slice(0,20)}`,
          outcome: asset.outcome,
          size: asset.size,
          avgPrice: asset.avgPrice,
          lastSlippage: slippagePct,
          walkPrice: result.walkPrice,
          bestBid: result.bestBid,
        });
        persistExitFailed();
        const failMsg = `${reason}: SELL PERMANENTLY FAILED after ${MAX_SELL_RETRIES} attempts (slippage up to ${(slippagePct*100).toFixed(0)}%). Position stuck: ${asset.size} shares @ ${asset.avgPrice}. bestBid=${result.bestBid}, depth=${result.availableDepth}. Manual intervention needed.`;
        log("EXEC", `🚨 ${failMsg}`);
        pushAlert("SELL_FAILED", assetId, asset, null, null, failMsg);
        sendTelegramAlert(`🚨 EXIT FAILED: ${asset._marketName || assetId.slice(0,20)} — ${asset.size} shares stuck after ${MAX_SELL_RETRIES} sell attempts (up to ${(slippagePct*100).toFixed(0)}% slippage). bestBid=${result.bestBid}. Needs manual exit or wait for resolution.`);
        return;
      }
      
      // Short cooldown (30s) before next attempt with higher slippage
      const nextSlippage = SELL_RETRY_SLIPPAGE[Math.min(asset._sellRetries, SELL_RETRY_SLIPPAGE.length - 1)];
      asset._sellCooldownUntil = Date.now() + SELL_RETRY_COOLDOWN_MS;
      pushAlert("SELL_FAILED", assetId, asset, null, null, 
        `${reason}: FOK not filled (bestBid=${result.bestBid}, walked=${result.walkPrice}, slip=${(slippagePct*100).toFixed(0)}%). ` +
        `Retry ${asset._sellRetries}/${MAX_SELL_RETRIES} in 30s with ${(nextSlippage*100).toFixed(0)}% slippage.`);
      return;
    }
    
    // ── FILLED SUCCESSFULLY ──
    asset._sellRetries = 0;

    pushAlert("SELL_EXECUTED", assetId, asset, result.executedPrice, null, 
      `${reason}: Sold ${asset.size} @ ${result.executedPrice} (FOK, slip=${(slippagePct*100).toFixed(0)}%)`);
    
    // EXIT LEDGER — log every exit with full context
    // Wrapped in its own try/catch so logging failures NEVER prevent position cleanup
    try {
      const exitPrice = parseFloat(result.executedPrice) || 0;
      const costBasis = asset.size * asset.avgPrice;
      const proceeds = asset.size * exitPrice;
      const stopLossVal = asset.stopLoss || DEFAULT_STOP_LOSS;
      const takeProfitVal = asset.takeProfit || DEFAULT_TAKE_PROFIT;
      logExit({
        assetId,
        market: asset._marketName || asset._market || asset.market || `Asset ${assetId.slice(0,20)}...`,
        outcome: asset.outcome || "Unknown",
        reason: reason === "STOP_LOSS" ? EXIT_REASONS.STOP_LOSS 
              : reason === "TAKE_PROFIT" ? EXIT_REASONS.TAKE_PROFIT
              : reason === "TRAILING_STOP" ? EXIT_REASONS.TRAILING_STOP
              : EXIT_REASONS.MANUAL_SELL,
        triggerSource: "ws-feed-auto",
        entryPrice: asset.avgPrice,
        exitPrice,
        size: asset.size,
        costBasis,
        proceeds,
        realizedPnl: proceeds - costBasis,
        strategy: getStrategy(assetId),
        notes: reason === "TRAILING_STOP" 
          ? `FOK fill, slip=${(slippagePct*100).toFixed(0)}%, TrailingFloor=${asset._trailingFloor?.toFixed(4)}, HWM=+${(asset._highWaterPnlPct*100)?.toFixed(1)}%, Entry=${asset.avgPrice}`
          : `FOK fill, slip=${(slippagePct*100).toFixed(0)}%, SL=${stopLossVal}, TP=${takeProfitVal}, Entry=${asset.avgPrice}`,
      });
    } catch (logErr) {
      log("EXEC", `⚠️ Exit ledger logging failed (non-fatal): ${logErr.message}`);
    }

    // If this was a manual position, remove from persisted file
    if (asset._manual) {
      const manualPositions = loadManualPositions();
      delete manualPositions[assetId];
      saveManualPositions(manualPositions);
      log("MANUAL", `Sold manual position — removed from persistence: ${assetId.slice(0,20)}`);
    }

    // ALWAYS remove sold position from tracking immediately
    subscribedAssets.delete(assetId);
    recentlySold.set(assetId, Date.now());
    persistRecentlySold();
    // Clear exit-failed if this asset was previously stuck (e.g., manual retry succeeded)
    if (exitFailed.has(assetId)) {
      exitFailed.delete(assetId);
      persistExitFailed();
      log("EXEC", `Cleared exit-failed for ${assetId.slice(0,20)} — sell finally succeeded`);
    }
    log("EXEC", `Removed sold position from tracking: ${assetId.slice(0,20)} (blocked from re-sync for 2h)`);

    // PHANTOM SELL DETECTION — verify on-chain after a delay
    // The CLOB can return "matched" but the fill may not settle on-chain.
    // After 15s, check the data API. If shares still exist, re-track the position.
    const verifyAssetId = assetId;
    const verifyAsset = { ...asset }; // snapshot current state
    setTimeout(async () => {
      try {
        const { positions } = await httpGet("/positions");
        const stillOnChain = positions.find(p => p.asset_id === verifyAssetId && p.size > 0.1);
        if (stillOnChain) {
          log("EXEC", `🚨 PHANTOM SELL DETECTED: ${verifyAssetId.slice(0,20)} still on-chain with ${stillOnChain.size} shares after "filled" sell!`);
          // Remove from recentlySold so syncPositions can re-add it
          recentlySold.delete(verifyAssetId);
          persistRecentlySold();
          // Re-add to tracking immediately with fresh data
          subscribedAssets.set(verifyAssetId, {
            ...verifyAsset,
            size: stillOnChain.size,
            _stopLossTriggered: false, // allow stop-loss to re-fire
            _takeProfitTriggered: false,
            _sellRetries: 0,
            _sellCooldownUntil: Date.now() + 60 * 1000, // 1-min cooldown before re-triggering
          });
          pushAlert("PHANTOM_SELL", verifyAssetId, verifyAsset, null, null,
            `Sell reported as filled but ${stillOnChain.size} shares still on-chain. Position re-tracked.`);
        } else {
          log("EXEC", `✅ Sell verified: ${verifyAssetId.slice(0,20)} confirmed gone from data API`);
        }
      } catch (e) {
        log("EXEC", `⚠️ Post-sell verification failed (non-fatal): ${e.message}`);
      }
    }, 15000);
  } catch (e) {
    log("EXEC", `❌ Auto-sell FAILED: ${e.message}`);
    // Network/API errors: use same retry/cooldown logic
    asset._sellRetries = (asset._sellRetries || 0) + 1;
    if (asset._sellRetries >= MAX_SELL_RETRIES) {
      asset._exitFailed = true;
      asset._sellCooldownUntil = Infinity;
      exitFailed.set(assetId, {
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
        retries: MAX_SELL_RETRIES,
        reason,
        market: asset._marketName || asset._market || asset.market || `Asset ${assetId.slice(0,20)}`,
        outcome: asset.outcome,
        size: asset.size,
        avgPrice: asset.avgPrice,
        error: e.message,
      });
      persistExitFailed();
      sendTelegramAlert(`🚨 EXIT FAILED (error): ${asset._marketName || assetId.slice(0,20)} — ${e.message}. Manual intervention needed.`);
    } else {
      asset._sellCooldownUntil = Date.now() + SELL_RETRY_COOLDOWN_MS;
    }
    pushAlert("SELL_FAILED", assetId, asset, null, null, `${reason} sell error: ${e.message}. Retry ${asset._sellRetries}/${MAX_SELL_RETRIES}`);
  } finally {
    // Clear lock after sell completes (success or failure)
    sellLocks.delete(assetId);
  }
}

function checkSystemReady() {
  if (systemReady) return true;
  if (!syncCompletedOnce) return false;

  const total = subscribedAssets.size;
  if (total === 0) return false;

  let priced = 0;
  for (const [, asset] of subscribedAssets) {
    if (asset.currentBid !== undefined && asset.currentBid !== null) priced++;
  }

  const pct = priced / total;
  if (pct >= 0.8) {
    // Don't mark ready until cash balance is ACTUALLY known (not just fetched)
    // cachedCashBalance === 0 after fetch likely means executor returned bad data
    // BUT: timeout after 2 minutes — don't stay blind forever if RPC is down
    if (lastCashFetch === 0 || cachedCashBalance === 0) {
      fetchCashBalance().catch(() => {});
      const warmupElapsed = Date.now() - (checkSystemReady._firstPricedAt || Date.now());
      if (!checkSystemReady._firstPricedAt) checkSystemReady._firstPricedAt = Date.now();
      if (warmupElapsed < 120000) { // 2 minute timeout
        if (!checkSystemReady._lastCashLog || Date.now() - checkSystemReady._lastCashLog > 10000) {
          log("WARMUP", `Positions priced (${(pct * 100).toFixed(0)}%) but waiting for cash balance (${(120000 - warmupElapsed) / 1000}s until timeout)...`);
          checkSystemReady._lastCashLog = Date.now();
        }
        return false;
      }
      log("WARMUP", `⚠️ Cash balance timeout after 2min — proceeding with $0 cash. Stop-losses still active, circuit breaker may be inaccurate.`);
    }
    systemReady = true;
    systemReadyAt = Date.now();
    log("INIT", `✅ System ready — ${priced}/${total} positions priced (${(pct * 100).toFixed(0)}%). Auto-execute grace period: 60s.`);
    const posVal = computePositionValue();
    const totalVal = posVal + cachedCashBalance;
    currentPortfolioValue = totalVal;
    dailyStartValue = totalVal;
    log("INIT", `dailyStartValue set to $${totalVal.toFixed(2)} (positions: $${posVal.toFixed(2)}, cash: $${cachedCashBalance.toFixed(2)})`);
    return true;
  }

  // Throttle warmup logs to once every 5s
  const now = Date.now();
  if (!checkSystemReady._lastLog || now - checkSystemReady._lastLog > 5000) {
    log("WARMUP", `System warming up — ${priced}/${total} positions priced (${(pct * 100).toFixed(0)}%), waiting...`);
    checkSystemReady._lastLog = now;
  }
  return false;
}

function computePositionValue() {
  let v = 0;
  for (const [, asset] of subscribedAssets) {
    if (asset.size && asset.currentBid) v += asset.currentBid * asset.size;
  }
  return v;
}

async function updatePortfolioValue() {
  const positionValue = computePositionValue();

  // Kick off cash balance refresh (non-blocking — runs on its own timer)
  if (Date.now() - lastCashFetch > CASH_FETCH_INTERVAL) {
    fetchCashBalance().catch(() => {});
  }
  
  // CRITICAL: Don't run ANY portfolio/risk calculations until cash balance is known
  // This prevents false circuit breaker trips where positions=$206 vs dailyStart=$450
  if (lastCashFetch === 0) return;
  
  const totalValue = positionValue + cachedCashBalance;

  if (positionValue > 0) {
    currentPortfolioValue = totalValue; // TOTAL portfolio = positions + cash

    // Skip all risk checks until system is warmed up
    if (!checkSystemReady()) return;

    if (!dailyStartValue) dailyStartValue = totalValue;

    // Daily drawdown check (v3 §7) — compare TOTAL vs TOTAL (not positions vs total+cash)
    const drawdown = (dailyStartValue - totalValue) / dailyStartValue;
    if (drawdown >= MAX_DAILY_DRAWDOWN && !circuitBreakerTripped) {
      // SANITY CHECK: If drawdown >30%, it's almost certainly a stale/missing cash balance.
      // Re-fetch cash synchronously before tripping.
      if (drawdown > 0.30) {
        log("CB", `⚠️ Suspicious drawdown ${(drawdown * 100).toFixed(1)}% — verifying cash balance before tripping...`);
        log("CB", `  positionValue=$${positionValue.toFixed(2)}, cachedCash=$${cachedCashBalance.toFixed(2)}, dailyStart=$${dailyStartValue.toFixed(2)}`);
        try {
          await fetchCashBalance();
          const verifiedTotal = positionValue + cachedCashBalance;
          const verifiedDrawdown = (dailyStartValue - verifiedTotal) / dailyStartValue;
          log("CB", `  After re-fetch: cash=$${cachedCashBalance.toFixed(2)}, total=$${verifiedTotal.toFixed(2)}, drawdown=${(verifiedDrawdown * 100).toFixed(1)}%`);
          if (verifiedDrawdown < MAX_DAILY_DRAWDOWN) {
            log("CB", `  ✅ FALSE ALARM — real drawdown ${(verifiedDrawdown * 100).toFixed(1)}% is under ${MAX_DAILY_DRAWDOWN * 100}% threshold`);
            return; // Don't trip — it was stale data
          }
        } catch (e) {
          log("CB", `  ⚠️ Cash re-fetch failed: ${e.message} — tripping conservatively (cannot verify)`);
          // Fall through to trip — better a false halt than an unprotected drawdown
        }
      }
      circuitBreakerTripped = true;
      circuitBreakerResumeAt = Date.now() + DRAWDOWN_PAUSE_MS;
      pushAlert("CIRCUIT_BREAKER", null, null, null, -drawdown, 
        `Daily drawdown ${(drawdown * 100).toFixed(1)}% exceeds ${(MAX_DAILY_DRAWDOWN * 100).toFixed(0)}% — PAUSED for 2 hours`);
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
  // Suppress dust position alerts: skip trade-level alerts on positions with <$2 cost basis
  const costBasis = asset?.size && asset?.avgPrice ? asset.size * asset.avgPrice : null;
  const isDust = costBasis !== null && costBasis < 2;
  const isSystemAlert = type.includes("EMERGENCY") || type.includes("SURVIVAL") || type.includes("CIRCUIT") || type.includes("DRAWDOWN");
  if (TELEGRAM_ALERT_TYPES.has(type) && (!isDust || isSystemAlert)) {
    const emoji = type.includes("EMERGENCY") ? "🚨" : type.includes("SURVIVAL") ? "⚠️" : type.includes("STOP") ? "🔴" : type.includes("TAKE_PROFIT") || type.includes("SELL_EXECUTED") ? "💰" : type.includes("CIRCUIT") ? "⚡" : "📡";
    const tgText = `${emoji} <b>Stuart Bot — ${type}</b>\n${asset?.market ? `Market: ${asset.market}\n` : ""}${asset?.outcome ? `Outcome: ${asset.outcome}\n` : ""}${price ? `Price: ${price}\n` : ""}${pnlPct != null ? `P&L: ${(pnlPct * 100).toFixed(1)}%\n` : ""}${message || ""}`;
    sendTelegramAlert(tgText);
  } else if (isDust && !isSystemAlert) {
    log("ALERT", `Suppressed dust alert (cost $${costBasis.toFixed(2)}): ${type}`);
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

    // Clean up expired recentlySold entries
    const now_sync = Date.now();
    for (const [id, ts] of recentlySold) {
      if (now_sync - ts > RECENTLY_SOLD_TTL) recentlySold.delete(id);
    }

    const newAssetIds = [];
    for (const pos of positions) {
      // Skip positions with zero or dust size (< 0.1 shares)
      if (!pos.size || pos.size < 0.1) {
        subscribedAssets.delete(pos.asset_id);
        if (pos.size > 0) log("SYNC", `Removed dust position (${pos.size} shares): ${pos.asset_id.slice(0,20)}`);
        continue;
      }

      // Skip permanently ignored assets (ghost arb positions with corrupted data)
      if (IGNORED_ASSETS.has(pos.asset_id)) {
        subscribedAssets.delete(pos.asset_id);
        continue;
      }

      // Skip recently sold positions — executor may still report them before settlement
      if (recentlySold.has(pos.asset_id)) {
        // If position still exists on-chain (data API returns it with size > 0),
        // the sell likely failed — clear the stale recentlySold entry and re-track
        if (pos._source === "data-api" && pos.size > 0.1) {
          log("SYNC", `⚠️ Position ${pos.asset_id.slice(0,20)} in recentlySold but STILL ON-CHAIN (${pos.size} shares) — clearing stale sold flag, re-tracking`);
          recentlySold.delete(pos.asset_id);
          persistRecentlySold();
        } else {
          log("SYNC", `Skipping recently sold position: ${pos.asset_id.slice(0,20)} (sold ${((now_sync - recentlySold.get(pos.asset_id)) / 1000).toFixed(0)}s ago)`);
          continue;
        }
      }
      
      const existing = subscribedAssets.get(pos.asset_id) || {};
      // Determine if TP was explicitly set (not default)
      const persistedTP = alerts.positions?.[pos.asset_id]?.takeProfit;
      const effectiveTP = persistedTP || existing.takeProfit || DEFAULT_TAKE_PROFIT;
      const tpWasSet = existing._tpExplicitlySet || (persistedTP != null && persistedTP !== DEFAULT_TAKE_PROFIT);
      
      subscribedAssets.set(pos.asset_id, {
        ...existing,
        market: pos.market,
        outcome: pos.outcome,
        avgPrice: parseFloat(pos.avgPrice),
        size: pos.size,
        totalCost: pos.totalCost,
        stopLoss: alerts.positions?.[pos.asset_id]?.stopLoss || existing.stopLoss || DEFAULT_STOP_LOSS,
        takeProfit: effectiveTP,
        _stopLossTriggered: existing._stopLossTriggered || false,
        _takeProfitTriggered: existing._takeProfitTriggered || false,
        _singleLossAlerted: existing._singleLossAlerted || false,
        _trackedSince: existing._trackedSince || Date.now(),  // TP enforcement: when position was first seen
        _tpExplicitlySet: tpWasSet,                           // TP enforcement: was TP consciously set?
        // Restore exit-failed state from persisted file (survives restarts)
        _exitFailed: existing._exitFailed || exitFailed.has(pos.asset_id),
        _sellCooldownUntil: existing._sellCooldownUntil || (exitFailed.has(pos.asset_id) ? Infinity : undefined),
        _sellRetries: existing._sellRetries || (exitFailed.has(pos.asset_id) ? 3 : 0),
      });
      newAssetIds.push(pos.asset_id);
    }

    if (newAssetIds.length > 0) subscribe(newAssetIds);

    // Sync position ledger (single source of truth)
    const ledgerChanges = positionLedger.recordSync(positions, manualPositions);
    if (ledgerChanges.added || ledgerChanges.removed) {
      log("SYNC", `Position ledger: +${ledgerChanges.added} -${ledgerChanges.removed} ~${ledgerChanges.updated}`);
    }
    log("SYNC", `Tracking ${subscribedAssets.size} positions (${positions.length} from executor)`);
    if (!syncCompletedOnce) {
      syncCompletedOnce = true;
      log("INIT", `First sync complete — ${subscribedAssets.size} positions loaded, waiting for price data...`);
    }
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
        systemReady,
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
          trailingFloor: asset._trailingFloor || null,
          highWaterPnl: asset._highWaterPnlPct ? (asset._highWaterPnlPct * 100).toFixed(1) + "%" : null,
          lastUpdate: asset.lastUpdate,
        };
      }
      const _autoCap = getAutoDeployedCapital();
      return send(res, 200, {
        prices,
        portfolioValue: currentPortfolioValue,
        positionValue: computePositionValue(),
        cashBalance: cachedCashBalance,
        dailyStartValue,
        systemReady,
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

    if (url === "/binary-arb-results") {
      try {
        const data = JSON.parse(fs.readFileSync(BINARY_ARB_RESULTS_FILE, "utf8"));
        return send(res, 200, data);
      } catch (e) {
        return send(res, 200, { error: "No binary arb results yet", timestamp: null });
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

    if (url === "/report") {
      // On-demand performance report generation
      try {
        const reporter = require("./trade-reporter.js");
        const data = await reporter.collectData();
        const analysis = reporter.analyzePerformance(data);
        const tracker = reporter.generateStrategyTracker(analysis);
        // Write files
        const botDir = path.join(__dirname, "..");
        const wsDir = path.join(__dirname, "..", "..");
        fs.writeFileSync(path.join(botDir, "STRATEGY-TRACKER.json"), JSON.stringify(tracker, null, 2));
        fs.writeFileSync(path.join(wsDir, "STRATEGY-TRACKER.json"), JSON.stringify(tracker, null, 2));
        const tradesMd = reporter.generateTradesMd(analysis);
        fs.writeFileSync(path.join(wsDir, "TRADES.md"), tradesMd);
        // Save daily snapshot
        const reportsDir = path.join(botDir, "daily-reports");
        if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
        const dateStr = new Date().toISOString().split("T")[0];
        fs.writeFileSync(path.join(reportsDir, `${dateStr}.json`), JSON.stringify(analysis, null, 2));
        log("REPORT", `Performance report generated: P&L=$${analysis.summary.totalPnl?.toFixed(2)}, WR=${analysis.summary.overallWinRate}%`);
        return send(res, 200, { ok: true, summary: analysis.summary, strategies: tracker.strategies });
      } catch (e) {
        log("REPORT", `Report generation failed: ${e.message}`);
        return send(res, 500, { error: e.message });
      }
    }

    if (url === "/status") {
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
          positionValue: computePositionValue(),
          cashBalance: cachedCashBalance,
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
          exitFailedCount: exitFailed.size,
          exitFailedAssets: Array.from(exitFailed.entries()).map(([id, info]) => ({
            assetId: id.slice(0, 20) + '...',
            market: info.market,
            reason: info.reason,
            since: info.isoTime,
          })),
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
        if (body.takeProfit !== undefined) {
          asset.takeProfit = parseFloat(body.takeProfit);
          asset._tpExplicitlySet = true; // TP enforcement: mark as consciously set
        }
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
          _trackedSince: Date.now(),
          _tpExplicitlySet: !!takeProfit, // TP enforcement: set if caller provided explicit TP
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
        pushAlert("CIRCUIT_BREAKER_RESUMED", null, null, null, null, "Manual reset via API");
        return send(res, 200, { ok: true });
      }

      if (url === "/toggle-auto-execute") {
        autoExecuteEnabled = !autoExecuteEnabled;
        log("CONFIG", `Auto-execute: ${autoExecuteEnabled}`);
        return send(res, 200, { ok: true, autoExecuteEnabled });
      }

      if (url === "/clear-exit-failed") {
        const body = await parseBody(req);
        if (body.assetId) {
          // Clear a specific exit-failed asset
          const existed = exitFailed.delete(body.assetId);
          if (existed) {
            persistExitFailed();
            // Also clear in-memory flags on the tracked asset
            const asset = subscribedAssets.get(body.assetId);
            if (asset) {
              asset._exitFailed = false;
              asset._sellCooldownUntil = undefined;
              asset._sellRetries = 0;
              asset._stopLossTriggered = false;
              asset._takeProfitTriggered = false;
            }
            log("EXEC", `Cleared exit-failed for ${body.assetId.slice(0,20)} — will re-evaluate triggers`);
          }
          return send(res, 200, { ok: true, cleared: existed, remaining: exitFailed.size });
        } else {
          // Clear ALL exit-failed assets
          const count = exitFailed.size;
          exitFailed.clear();
          persistExitFailed();
          // Clear in-memory flags on all tracked assets
          for (const [, asset] of subscribedAssets) {
            if (asset._exitFailed) {
              asset._exitFailed = false;
              asset._sellCooldownUntil = undefined;
              asset._sellRetries = 0;
              asset._stopLossTriggered = false;
              asset._takeProfitTriggered = false;
            }
          }
          log("EXEC", `Cleared ALL ${count} exit-failed assets — will re-evaluate triggers`);
          return send(res, 200, { ok: true, clearedCount: count });
        }
      }

      if (url === "/exit-failed") {
        const list = [];
        for (const [assetId, info] of exitFailed) {
          list.push({ assetId, ...info });
        }
        return send(res, 200, { count: list.length, assets: list });
      }
    }

    // GET /exit-failed also works
    if (method === "GET" && url === "/exit-failed") {
      const list = [];
      for (const [assetId, info] of exitFailed) {
        list.push({ assetId, ...info });
      }
      return send(res, 200, { count: list.length, assets: list });
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
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
  });
}

// === PNL HISTORY RECORDING ===
function recordPnlSnapshot() {
  if (currentPortfolioValue == null) return;

  const liquid = cachedCashBalance || 0;
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
    writeFileAtomic(PNL_HISTORY_FILE, history);
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

    writeFileAtomic(ARB_RESULTS_FILE, output);
    log("ARB", `✅ Scan complete — Flagged: ${opportunities.length} | Viable: ${output.summary.viable} → ${ARB_RESULTS_FILE}`);

    // === ARB AUTO-EXECUTION ===
    // Gated by ARB_DISABLED file flag (created 2026-02-13, kept after 2026-02-15 removal).
    // Scan data collection always runs; auto-execution only runs if flag file is absent.
    const arbAutoDisabled = fs.existsSync(path.join(__dirname, '..', 'ARB_DISABLED'));
    if (arbAutoDisabled) {
      log("ARB", "Auto-execution DISABLED (ARB_DISABLED file present). Scan-only mode.");
    }
    if (!arbAutoDisabled && systemReady && !circuitBreakerTripped && !emergencyMode && !survivalMode && autoExecuteEnabled) {
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
          try { writeFileAtomic(ARB_EXECUTED_FILE, [...arbExecutedSlugs]); } catch {}
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

    writeFileAtomic(RESOLVING_FILE, output);
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
    writeFileAtomic(MARKET_NAMES_FILE, names);
    log("NAMES", `Registered: ${conditionId.slice(0,10)} → ${name}`);
  } catch (e) { log("NAMES", `Failed to register name: ${e.message}`); }
}

// === RESOLUTION HUNTER (auto-buy near-resolved markets) ===
const RESOLUTION_HUNTER_INTERVAL = 15 * 60 * 1000; // every 15 min
const RESOLUTION_HUNTER_FILE = path.join(__dirname, "..", "resolution-hunter.json");
const RH_EXECUTED_FILE = path.join(__dirname, "..", "rh-executed.json");
const RH_MIN_PRICE = 0.96;      // v4: dropped 95-96¢ tier (breakeven, highest loss rate)
const RH_MAX_PRICE = 0.98;      // backtest v4: 96-98¢ = 99.0% hit rate, $21.23 net P&L on 103 trades
const RH_MAX_SPEND = 10;        // $10 max per trade
const RH_MIN_LIQUIDITY = 500;   // min $500 liquidity
const RH_RESOLUTION_WINDOW_H = 6; // markets resolving within 6 hours
const RH_MIN_VOLUME_24H = 1000; // min $1K 24h volume (filters illiquid junk)

// === EXPANDED CATEGORY FILTERS (v4) ===
// Sports/esports + volatile single-data-point markets
// Backtest v4: 139 markets filtered, 99.0% hit rate on remainder

// Category-level skip (from Gamma API 'category' field)
const RH_SKIP_CATEGORIES = /sports|esports|gaming|mma|boxing|wrestling|racing|motorsport|weather/i;

// Slug-level skip — sports/esports patterns + league codes
const RH_SKIP_SLUGS = new RegExp([
  // Sports/esports base
  'esports', 'valorant', 'counter-strike', 'cs2', 'tennis', 'nba', 'nfl', 'mma', 'ufc',
  'soccer', 'football', 'dota', 'league-of-legends', 'lol-', 'r6siege', 'codmw',
  'cricket', 'boxing', 'rugby', 'hockey', 'nhl', 'mlb', 'baseball', 'basketball',
  // League/competition codes
  'a-league', 'serie-a', 'la-liga', 'premier-league', 'bundesliga', 'ligue-1',
  'eredivisie', 'copa', 'champions-league', 'europa-league', 'ncaa',
  'cbb-', 'cwbb-', 'sea-', 'bun-', 'efa-', 'fl1-', 'ere-', 'por-', 'es2-', 'fr2-', 'lal-', 'chi1-', 'elc-',
  // NEW: expanded sports coverage
  'bbl', 'apex.legends', 'jack.sock', 'overwatch', 'rocket.league', 'fortnite',
  'pubg', 'rainbow.six', 'call.of.duty', 'fifa', 'f1-', 'moto-?gp', 'wwe', 'aew',
  'pga', 'lpga', 'atp-', 'wta-', 'grand.slam', 'wimbledon', 'us.open',
  'world.cup', 'olympics', 'super.bowl', 'stanley.cup', 'world.series',
  // Country league codes
  'arg-', 'mex-', 'bra-', 'ita-', 'esp-', 'eng-', 'ger-', 'fra-', 'tur-',
  'val-', 'dota2-', 'cs2-', 'r6-', 'rl-',
  // Match patterns in slugs
  '-spread-', '-total-\\d', '-btts', '-handicap-', '-draw$',
].join('|'), 'i');

// Question-level skip — match patterns + volatile single-data-point markets
const RH_SKIP_QUESTIONS = new RegExp([
  // Sports/match patterns
  'vs\\.', 'vs ', 'winner', 'match', 'game \\d', 'map handicap', 'spread:', 'o\\/u \\d',
  'both teams', 'total games', 'score in', 'home win', 'away win',
  // Team mascot names
  'Bears|Bulldogs|Tigers|Eagles|Hawks|Lions|Panthers|Warriors|Spartans|Badgers|Crimson|Ramblers|Bobcats|Saints|Cougars|Peacocks|Pioneers|Big Green|Quakers|Billikens',
  // Earnings/financial
  'earnings', 'revenue beat', 'EPS beat', 'quarterly results',
  // ETF flows
  'ETF (in|out)flows', 'ETF flows', 'net (in|out)flows',
  // Crypto price targets
  '(Bitcoin|BTC|Ethereum|ETH|Solana|SOL|XRP|Doge|DOGE|ADA|DOT|AVAX|MATIC|LINK|UNI|AAVE).*(above|below|over|under|close at|finish at|hit)\\s*\\$',
  // Stock price targets (ticker + above/below + $)
  '(AAPL|MSFT|NVDA|GOOGL|AMZN|META|TSLA|NFLX|AMD|INTC|PLTR|OPEN|BA|DIS|UBER|COIN|HOOD|GME|AMC|PYPL|SQ|SHOP|SNAP|PINS|RBLX|ABNB|DASH|RIVN|LCID|NIO|F|GM|WMT|TGT|COST|KO|PEP).*(above|below|close|finish)\\s*(at\\s*)?\\$',
  // Close above/below patterns
  'close (above|below|at) \\$\\d', 'finish.*(above|below) \\$\\d',
  // Person-says-word-during-event
  '(say|mention|utter|use the word)\\b.*\\b(during|at|in the)\\b',
  '(State of the Union|SOTU|debate|press conference|speech|interview).*\\b(say|mention)\\b',
  // Tweet/post count markets
  '(tweets?|posts?) from', 'number of (tweets|posts)', 'how many (tweets|posts)',
  // Up/Down daily markets (coin flip)
  'Up or Down',
  // Weather/temperature markets (blocked by operator directive 2026-02-15)
  'temperature', 'highest temp', 'lowest temp', 'degrees?.*(celsius|fahrenheit|°[CF])',
  'weather', 'rainfall', 'precipitation', 'snowfall', 'wind speed',
].join('|'), 'i');

// Persist executed conditionIds to survive restarts
let rhExecutedIds = new Set();
try { rhExecutedIds = new Set(JSON.parse(fs.readFileSync(RH_EXECUTED_FILE, "utf8"))); } catch {}
function saveRhExecuted() {
  try { writeFileAtomic(RH_EXECUTED_FILE, [...rhExecutedIds]); } catch {}
}

async function runResolutionHunter() {
  if (!systemReady) { log("RH", "Skipping — system warming up"); return; }
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

        // v4 expanded filters — sports/esports + volatile single-data-point markets
        const slug = m.slug || "";
        const question = m.question || m.title || "";
        const category = m.category || "";
        if (RH_SKIP_CATEGORIES.test(category) || RH_SKIP_SLUGS.test(slug) || RH_SKIP_QUESTIONS.test(question)) continue;

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
      let size = Math.floor(RH_MAX_SPEND / c.price);
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
    writeFileAtomic(RESOLUTION_HUNTER_FILE, output);

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
    writeFileAtomic(WEATHER_TRADES_FILE, existing);
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

// === TAKE-PROFIT MANDATORY ENFORCEMENT ===
// Pattern 3 from LESSONS.md: TP treated as optional → Bad Bunny rode +22% back to -31%.
// Every 2 minutes, check all non-auto positions. If TP still at default 2min after
// position was first tracked, alert Telegram once. Forces conscious TP setting on every trade.
const TP_CHECK_INTERVAL = 2 * 60 * 1000;    // check every 2 min
const TP_GRACE_PERIOD = 2 * 60 * 1000;      // 2 min grace after first tracking
const TP_AUTO_STRATEGIES = new Set(["weather", "resolution", "arb"]); // auto-strategies exempt (use defaults by design)
const tpAlerted = new Set(); // assetIds already alerted (prevent spam)

function checkTakeProfitEnforcement() {
  if (!systemReady) return;
  const now = Date.now();
  
  for (const [assetId, asset] of subscribedAssets) {
    // Skip auto-strategy positions — they use defaults by design
    const strat = getStrategy(assetId);
    if (TP_AUTO_STRATEGIES.has(strat)) continue;
    
    // Skip if already alerted
    if (tpAlerted.has(assetId)) continue;
    
    // Skip if position hasn't been tracked long enough
    if (!asset._trackedSince || (now - asset._trackedSince) < TP_GRACE_PERIOD) continue;
    
    // Check if TP is still at default (never explicitly set)
    if (!asset._tpExplicitlySet) {
      const tp = asset.takeProfit || DEFAULT_TAKE_PROFIT;
      if (tp === DEFAULT_TAKE_PROFIT) {
        tpAlerted.add(assetId);
        const market = asset.market || asset._marketName || `Asset ${assetId.slice(0, 20)}`;
        const msg = `⚠️ <b>TAKE-PROFIT NOT SET</b>\n\nMarket: ${market}\nOutcome: ${asset.outcome || "?"}\nEntry: $${asset.avgPrice?.toFixed(4)}\nSize: ${asset.size} shares\nStrategy: ${strat}\n\nUsing default TP: +${(DEFAULT_TAKE_PROFIT * 100).toFixed(0)}%. Set explicit TP via /set-trigger or pm_trigger.`;
        log("TP-CHECK", `⚠️ No explicit TP on ${market} (${strat}) — alerting`);
        sendTelegramAlert(msg);
      }
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

// === STARTUP SAFETY SELF-TEST ===
// Meta-analysis finding (2026-02-14): #1 recurring failure is deploying code without
// validation. This function runs on every boot BEFORE enabling auto-execution.
// If any safety invariant is broken, auto-execute stays disabled and Telegram gets an alert.
function runSafetyTests() {
  const failures = [];
  
  // TEST 1: Circuit breaker threshold is reasonable
  if (MAX_DAILY_DRAWDOWN <= 0 || MAX_DAILY_DRAWDOWN > 0.50) {
    failures.push(`Circuit breaker threshold ${MAX_DAILY_DRAWDOWN} is outside safe range (0.01-0.50)`);
  }
  
  // TEST 2: Stop-loss / take-profit defaults are sane
  if (DEFAULT_STOP_LOSS <= 0 || DEFAULT_STOP_LOSS > 0.80) {
    failures.push(`Default stop-loss ${DEFAULT_STOP_LOSS} is outside safe range (0.01-0.80)`);
  }
  if (DEFAULT_TAKE_PROFIT <= 0 || DEFAULT_TAKE_PROFIT > 5.0) {
    failures.push(`Default take-profit ${DEFAULT_TAKE_PROFIT} is outside safe range (0.01-5.0)`);
  }
  
  // TEST 3: executeSell can construct logExit notes without ReferenceError
  // (This catches the stopLossThreshold bug class)
  try {
    const mockAsset = { stopLoss: 0.3, takeProfit: 0.5, avgPrice: 0.80, _trailingFloor: 0.75, _highWaterPnlPct: 0.25 };
    const stopLossVal = mockAsset.stopLoss || DEFAULT_STOP_LOSS;
    const takeProfitVal = mockAsset.takeProfit || DEFAULT_TAKE_PROFIT;
    const testNotes = `SL=${stopLossVal}, TP=${takeProfitVal}, Entry=${mockAsset.avgPrice}`;
    const testTrailingNotes = `TrailingFloor=${mockAsset._trailingFloor?.toFixed(4)}, HWM=+${(mockAsset._highWaterPnlPct*100)?.toFixed(1)}%, Entry=${mockAsset.avgPrice}`;
    if (!testNotes || !testTrailingNotes) failures.push("Exit notes construction returned falsy");
  } catch (e) {
    failures.push(`Exit notes construction threw: ${e.message}`);
  }
  
  // TEST 4: logExit function is callable
  try {
    if (typeof logExit !== "function") {
      failures.push("logExit is not a function — exit logging will fail");
    }
  } catch (e) {
    failures.push(`logExit check threw: ${e.message}`);
  }
  
  // TEST 5: EXIT_REASONS constants are defined
  try {
    const requiredReasons = ["STOP_LOSS", "TAKE_PROFIT", "TRAILING_STOP", "MANUAL_SELL"];
    for (const r of requiredReasons) {
      if (!EXIT_REASONS[r]) failures.push(`EXIT_REASONS.${r} is undefined`);
    }
  } catch (e) {
    failures.push(`EXIT_REASONS check threw: ${e.message}`);
  }
  
  // TEST 6: Survival/emergency floors are reasonable
  if (SURVIVAL_FLOOR <= 0 || SURVIVAL_FLOOR > 500) {
    failures.push(`Survival floor $${SURVIVAL_FLOOR} is outside safe range ($1-$500)`);
  }
  if (EMERGENCY_FLOOR <= 0 || EMERGENCY_FLOOR >= SURVIVAL_FLOOR) {
    failures.push(`Emergency floor $${EMERGENCY_FLOOR} must be >0 and < survival floor $${SURVIVAL_FLOOR}`);
  }
  
  // TEST 7: Telegram is configured (warning, not failure)
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log("SAFETY", "⚠️ Telegram not configured — alerts will be log-only");
  }
  
  // VERDICT
  if (failures.length > 0) {
    log("SAFETY", `🚨 SAFETY SELF-TEST FAILED (${failures.length} failures):`);
    for (const f of failures) log("SAFETY", `  ❌ ${f}`);
    log("SAFETY", "AUTO-EXECUTE DISABLED until issues are resolved");
    autoExecuteEnabled = false;
    const alertMsg = `🚨 <b>Stuart Bot — SAFETY TEST FAILED</b>\n\nAuto-execute DISABLED on startup.\n\n${failures.map(f => `❌ ${f}`).join("\n")}\n\nFix the code and restart.`;
    sendTelegramAlert(alertMsg);
    return false;
  }
  
  log("SAFETY", "✅ All safety self-tests passed — auto-execute enabled");
  return true;
}

// === MAIN ===
async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Polymarket WS Feed + Circuit Breakers   ║");
  console.log("║  v3 — Integrated Scanners                ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log();

  // RUN SAFETY SELF-TEST FIRST (before anything else)
  const safetyOk = runSafetyTests();

  log("INIT", `Executor: ${EXECUTOR_URL}`);
  log("INIT", `Feed API: port ${FEED_PORT}`);
  log("INIT", `P&L: chain-truth only (no hardcoded starting capital)`);
  log("INIT", `Stop-loss: ${DEFAULT_STOP_LOSS * 100}% | Take-profit: ${DEFAULT_TAKE_PROFIT * 100}%`);
  log("INIT", `Daily drawdown limit: ${MAX_DAILY_DRAWDOWN * 100}%`);
  log("INIT", `Survival: <$${SURVIVAL_FLOOR} | Emergency: <$${EMERGENCY_FLOOR}`);
  log("INIT", `Auto-execute: ${autoExecuteEnabled}${!safetyOk ? " (DISABLED by safety test)" : ""}`);
  log("INIT", `Arb scanner: every ${ARB_SCAN_INTERVAL / 60000}min | Resolving: every ${RESOLVING_SCAN_INTERVAL / 60000}min | Resolution hunter: every ${RESOLUTION_HUNTER_INTERVAL / 60000}min | Weather executor: every ${WEATHER_EXECUTOR_INTERVAL / 60000}min | TP enforcement: every ${TP_CHECK_INTERVAL / 60000}min`);
  log("INIT", `Telegram alerts: ${TELEGRAM_BOT_TOKEN ? "ENABLED" : "DISABLED (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)"}`);
  log("INIT", `PnL history: every ${PNL_RECORD_INTERVAL / 60000}min → ${PNL_HISTORY_FILE}`);
  console.log();

  // Load persisted state — but NEVER restore circuit breaker on restart
  // (dailyStartValue is freshly calculated, old CB state is meaningless)
  const alerts = loadAlerts();
  circuitBreakerTripped = false;  // Always start fresh — warmup sets new dailyStartValue
  circuitBreakerResumeAt = null;
  survivalMode = alerts.survivalMode || false;
  emergencyMode = alerts.emergencyMode || false;

  // Sync positions (retry up to 5x if executor not ready)
  for (let attempt = 1; attempt <= 5; attempt++) {
    await syncPositions();
    if (subscribedAssets.size > 0) break;
    log("INIT", `No positions loaded (attempt ${attempt}/5), retrying in 3s...`);
    await new Promise(r => setTimeout(r, 3000));
  }

  // Fetch cash balance BEFORE connecting WebSocket (prevents false circuit breaker)
  await fetchCashBalance();
  log("INIT", `Cash balance fetched: $${cachedCashBalance.toFixed(2)}`);

  // Connect WebSocket
  connect();

  // Periodic sync
  setInterval(syncPositions, POSITION_SYNC_INTERVAL);

  // REST price polling for NegRisk/stale tokens (every 60s)
  setTimeout(() => {
    pollStalePrices();
    setInterval(pollStalePrices, REST_POLL_INTERVAL);
  }, 15 * 1000); // first poll after 15s startup

  // Fee change detection (v5: text-only hashing to avoid dynamic HTML false positives)
  let lastKnownFees = null;
  let lastFeeAlertAt = 0;
  const FEE_ALERT_COOLDOWN = 24 * 60 * 60 * 1000; // suppress duplicate alerts for 24h
  async function checkFees() {
    try {
      const https = require("https");
      const feeData = await new Promise((resolve, reject) => {
        https.get("https://docs.polymarket.com/polymarket-learn/trading/fees", (res) => {
          let data = "";
          res.on("data", (c) => data += c);
          res.on("end", () => resolve(data));
        }).on("error", reject);
      });
      // v5: Strip HTML tags, normalize whitespace, extract ONLY text content.
      // Prevents false positives from dynamic script hashes, CSS fingerprints,
      // analytics tags, and timestamps that change every request.
      const textOnly = feeData
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const feeHash = require("crypto").createHash("md5").update(textOnly).digest("hex");
      if (lastKnownFees && feeHash !== lastKnownFees) {
        if (Date.now() - lastFeeAlertAt > FEE_ALERT_COOLDOWN) {
          pushAlert("FEE_CHANGE_DETECTED", null, null, null, null, 
            "⚠️ Fee structure content changed \u2014 review https://docs.polymarket.com/polymarket-learn/trading/fees");
          log("FEES", "🚨 Fee structure change detected!");
          sendTelegramAlert("⚠️ Fee structure page content changed \u2014 review and update FEE_RATES in ws-feed.js if needed.");
          lastFeeAlertAt = Date.now();
        } else {
          log("FEES", `Fee hash changed but alert suppressed (cooldown, next in ${((FEE_ALERT_COOLDOWN - (Date.now() - lastFeeAlertAt)) / 3600000).toFixed(1)}h)`);
        }
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

  // Take-profit enforcement — alert if non-auto positions lack explicit TP
  setTimeout(() => {
    setInterval(checkTakeProfitEnforcement, TP_CHECK_INTERVAL);
  }, TP_GRACE_PERIOD + 10000); // first check after grace period + 10s buffer

  // === ARB SCANNER — RE-ENABLED FOR DATA COLLECTION (2026-02-16, mechanic session) ===
  // Auto-execution gated by ARB_DISABLED file flag (present since 2026-02-13).
  // Scan runs every 15 min for fresh arb-results.json data (consumed by pm_scanners).
  // Binary arb scanner remains removed (same FOK→GTC bug, no separate data need).
  setTimeout(() => {
    runArbScan().catch(e => log("ARB", `❌ Uncaught error: ${e.message}`));
    setInterval(() => runArbScan().catch(e => log("ARB", `❌ Uncaught error: ${e.message}`)), ARB_SCAN_INTERVAL);
  }, 30 * 1000); // first scan 30s after startup

  // Resolving markets scanner: scan-only (no execution), kept for data collection.
  setTimeout(() => {
    runResolvingScan();
    setInterval(runResolvingScan, RESOLVING_SCAN_INTERVAL);
  }, 60 * 1000);

  // === RESOLUTION HUNTER — PERMANENTLY REMOVED (2026-02-15, user directive) ===
  // Same execution path issues as arb scanners. Places GTC limit orders at best ask.
  // While it has fill confirmation (60s timeout + cancel), it still deploys real capital
  // through the same broken pipeline. Removed alongside arb scanners.
  // Code retained in runResolutionHunter() for reference but never called.

  // Weather signal executor — PERMANENTLY DISABLED (2026-02-13)
  // Backtest showed NEGATIVE EDGE: 52.7% hit rate, -$234.74 simulated P&L on 129 signals.
  // Ensemble forecasts catastrophically miscalibrated at bucket granularity.
  // Code retained in repo for future reference if better data source found.
  // See weather-backtest.json for full results.
  // setTimeout(() => {
  //   runWeatherExecutor().catch(e => log("WX", `❌ Uncaught error: ${e.message}`));
  //   setInterval(() => runWeatherExecutor().catch(e => log("WX", `❌ Uncaught error: ${e.message}`)), WEATHER_EXECUTOR_INTERVAL);
  // }, 120 * 1000);

  // Resolution detection — check every 5 minutes for resolved markets
  // Calls executor /check-resolutions which queries Polymarket data API
  setInterval(() => {
    const req = http.get("http://localhost:3002/check-resolutions", (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const result = JSON.parse(d);
          if (result.newlyResolved && result.newlyResolved.length > 0) {
            log("RESOLUTION", `${result.newlyResolved.length} positions resolved: ${result.newlyResolved.map(r => r.market?.slice(0,30)).join(", ")}`);
            // Remove resolved positions from our tracking
            for (const r of result.newlyResolved) {
              subscribedAssets.delete(r.asset_id);
            }
          }
        } catch(e) {}
      });
    });
    req.on("error", () => {});
    req.setTimeout(15000, () => req.destroy());
  }, 5 * 60 * 1000);

  // Position reconciliation — check every 5 minutes for phantom positions
  setInterval(() => {
    const req = http.get("http://localhost:3002/reconcile", (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const result = JSON.parse(d);
          if (result.phantoms && result.phantoms.length > 0) {
            log("RECONCILE", `Removed ${result.phantoms.length} phantom positions: ${result.phantoms.map(p => p.market?.slice(0,30)).join(", ")}`);
            for (const p of result.phantoms) subscribedAssets.delete(p.assetId);
          }
          if (result.mismatches && result.mismatches.length > 0) {
            log("RECONCILE", `${result.mismatches.length} size mismatches detected`);
          }
        } catch(e) {}
      });
    });
    req.on("error", () => {});
    req.setTimeout(15000, () => req.destroy());
  }, 5 * 60 * 1000);

  // Run once at startup after warmup
  setTimeout(() => {
    http.get("http://localhost:3002/check-resolutions", () => {}).on("error", () => {});
    http.get("http://localhost:3002/reconcile", () => {}).on("error", () => {});
  }, 120 * 1000);

  // Daily performance report — runs at midnight UTC and on first startup after 5min
  const DAILY_REPORT_HOUR_UTC = 0; // midnight UTC
  function scheduleDailyReport() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(DAILY_REPORT_HOUR_UTC, 5, 0, 0); // 00:05 UTC
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const msUntil = next - now;
    log("REPORT", `Daily report scheduled for ${next.toISOString()} (${(msUntil / 3600000).toFixed(1)}h from now)`);
    setTimeout(async () => {
      try {
        const reporter = require("./trade-reporter.js");
        await reporter.main();
        log("REPORT", "Daily performance report generated and sent");
      } catch (e) {
        log("REPORT", `Daily report failed: ${e.message}`);
      }
      scheduleDailyReport(); // schedule next day
    }, msUntil);
  }
  scheduleDailyReport();
  // Also generate a report 5 minutes after startup for immediate visibility
  setTimeout(async () => {
    try {
      const reporter = require("./trade-reporter.js");
      const data = await reporter.collectData();
      const analysis = reporter.analyzePerformance(data);
      const tracker = reporter.generateStrategyTracker(analysis);
      const botDir = path.join(__dirname, "..");
      const wsDir = path.join(__dirname, "..", "..");
      fs.writeFileSync(path.join(botDir, "STRATEGY-TRACKER.json"), JSON.stringify(tracker, null, 2));
      fs.writeFileSync(path.join(wsDir, "STRATEGY-TRACKER.json"), JSON.stringify(tracker, null, 2));
      const tradesMd = reporter.generateTradesMd(analysis);
      fs.writeFileSync(path.join(wsDir, "TRADES.md"), tradesMd);
      log("REPORT", `Startup report: P&L=$${analysis.summary.totalPnl?.toFixed(2)}, ${analysis.summary.totalTrades} trades, WR=${analysis.summary.overallWinRate}%`);
    } catch (e) {
      log("REPORT", `Startup report failed: ${e.message}`);
    }
  }, 5 * 60 * 1000);

  // Daily reset
  scheduleDailyReset();

  // Start HTTP API
  const server = http.createServer(apiHandler);
  server.listen(FEED_PORT, () => {
    log("INIT", `Feed API running on port ${FEED_PORT}`);
  });
}

// === CRASH SAFETY: Catch unhandled errors before they kill the process ===
process.on("unhandledRejection", (reason) => {
  console.error("[WS-FEED] Unhandled rejection:", reason);
  sendTelegramAlert(`🚨 <b>WS-FEED UNHANDLED REJECTION</b>\n<pre>${String(reason).slice(0, 500)}</pre>\n\nProcess may restart via PM2.`);
});

process.on("uncaughtException", (err) => {
  console.error("[WS-FEED] Uncaught exception:", err);
  sendTelegramAlert(`🚨 <b>WS-FEED CRASH</b>\n<pre>${String(err.stack || err).slice(0, 500)}</pre>\n\nProcess will restart via PM2.`);
  setTimeout(() => process.exit(1), 2000);
});

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
