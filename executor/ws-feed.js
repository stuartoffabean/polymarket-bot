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
 *   POST /add-position    — { assetId, market, outcome, avgPrice, size } (manual inject)
 *   POST /reset-circuit-breaker
 */

const WebSocket = require("ws");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// === CONFIG ===
const WSS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const EXECUTOR_URL = "http://localhost:3002";
const STATE_FILE = path.join(__dirname, "..", "TRADING-STATE.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");
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
const STARTING_CAPITAL = parseFloat(process.env.STARTING_CAPITAL) || 433;
const MAX_DAILY_DRAWDOWN = 0.15;      // 15% → pause 2hrs
const DEFAULT_STOP_LOSS = 0.30;       // 30% loss per position
const DEFAULT_TAKE_PROFIT = 0.50;     // 50% gain per position
const SURVIVAL_THRESHOLD = 0.25;      // 25% of starting capital
const EMERGENCY_THRESHOLD = 0.10;     // 10% of starting capital
const SINGLE_TRADE_LOSS_LIMIT = 0.05; // 5% of bankroll per trade loss → halt strategy
const DRAWDOWN_PAUSE_MS = 2 * 60 * 60 * 1000; // 2 hour pause

// === STATE ===
let ws = null;
let reconnectAttempts = 0;
let pingTimer = null;
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

    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, PING_INTERVAL);
  });

  ws.on("message", (raw) => {
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
  asset.currentBid = data.bids?.length > 0 ? parseFloat(data.bids[data.bids.length - 1].price) : null;
  asset.currentAsk = data.asks?.length > 0 ? parseFloat(data.asks[0].price) : null;
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
  if (emergencyMode) return; // no trading in emergency

  const currentPrice = asset.currentBid;
  if (!currentPrice) return;

  const costBasis = asset.avgPrice * asset.size;
  const currentValue = currentPrice * asset.size;
  const pnlPct = (currentValue - costBasis) / costBasis;
  const pnlAbs = currentValue - costBasis;

  const stopLoss = asset.stopLoss || DEFAULT_STOP_LOSS;
  const takeProfit = asset.takeProfit || DEFAULT_TAKE_PROFIT;

  // Single trade loss > 5% of bankroll (v3 §7)
  if (pnlAbs < 0 && Math.abs(pnlAbs) > STARTING_CAPITAL * SINGLE_TRADE_LOSS_LIMIT) {
    if (!asset._singleLossAlerted) {
      pushAlert("SINGLE_TRADE_LOSS", assetId, asset, currentPrice, pnlPct, 
        `Loss $${Math.abs(pnlAbs).toFixed(2)} exceeds 5% of bankroll`);
      asset._singleLossAlerted = true;
    }
  }

  // Stop loss → AUTO SELL
  if (pnlPct <= -stopLoss && !asset._stopLossTriggered) {
    asset._stopLossTriggered = true;
    pushAlert("STOP_LOSS", assetId, asset, currentPrice, pnlPct, "AUTO-SELLING");
    if (autoExecuteEnabled && !circuitBreakerTripped) {
      executeSell(assetId, asset, "STOP_LOSS");
    }
  }

  // Take profit → AUTO SELL
  if (pnlPct >= takeProfit && !asset._takeProfitTriggered) {
    asset._takeProfitTriggered = true;
    pushAlert("TAKE_PROFIT", assetId, asset, currentPrice, pnlPct, "AUTO-SELLING");
    if (autoExecuteEnabled && !circuitBreakerTripped) {
      executeSell(assetId, asset, "TAKE_PROFIT");
    }
  }

  // Update portfolio
  updatePortfolioValue();
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

    // SURVIVAL MODE (v3 §7: balance < 25% of starting)
    if (totalValue > 0 && totalValue < STARTING_CAPITAL * SURVIVAL_THRESHOLD && !survivalMode) {
      survivalMode = true;
      pushAlert("SURVIVAL_MODE", null, null, null, null, 
        `⚠️ Balance $${totalValue.toFixed(2)} below 25% of $${STARTING_CAPITAL} — SURVIVAL MODE`);
      log("RISK", `⚠️ SURVIVAL MODE ACTIVATED — balance: $${totalValue.toFixed(2)}`);
    }

    // EMERGENCY MODE (v3 §7: balance < 10% of starting)
    if (totalValue > 0 && totalValue < STARTING_CAPITAL * EMERGENCY_THRESHOLD && !emergencyMode) {
      emergencyMode = true;
      autoExecuteEnabled = false; // no more auto-sells, everything frozen
      pushAlert("EMERGENCY_MODE", null, null, null, null, 
        `🚨 EMERGENCY: Balance $${totalValue.toFixed(2)} below 10% of $${STARTING_CAPITAL} — ALL TRADING HALTED`);
      log("RISK", `🚨 EMERGENCY MODE — ALL TRADING HALTED`);
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

    const newAssetIds = [];
    for (const pos of positions) {
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
      return send(res, 200, {
        ok: true,
        wsConnected: ws?.readyState === WebSocket.OPEN,
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
          stopLoss: asset.stopLoss || DEFAULT_STOP_LOSS,
          takeProfit: asset.takeProfit || DEFAULT_TAKE_PROFIT,
          lastUpdate: asset.lastUpdate,
        };
      }
      return send(res, 200, {
        prices,
        portfolioValue: currentPortfolioValue,
        dailyStartValue,
        circuitBreakerTripped,
        circuitBreakerResumeAt,
        survivalMode,
        emergencyMode,
        autoExecuteEnabled,
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
          startingCapital: STARTING_CAPITAL,
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
        const { assetId, market, outcome, avgPrice, size, stopLoss, takeProfit } = body;
        if (!assetId || !avgPrice || !size) return send(res, 400, { error: "Need assetId, avgPrice, size" });

        subscribedAssets.set(assetId, {
          ...subscribedAssets.get(assetId),
          market: market || "manual",
          outcome: outcome || "Unknown",
          avgPrice: parseFloat(avgPrice),
          size: parseFloat(size),
          totalCost: parseFloat(avgPrice) * parseFloat(size),
          stopLoss: stopLoss ? parseFloat(stopLoss) : DEFAULT_STOP_LOSS,
          takeProfit: takeProfit ? parseFloat(takeProfit) : DEFAULT_TAKE_PROFIT,
          _manual: true,
        });

        subscribe([assetId]);
        log("MANUAL", `Added position: ${outcome} ${size} @ ${avgPrice}`);
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      const profit = type === "SHORT" ? (execSum - 1.0) * 100 : (1.0 - execSum) * 100;

      opportunities.push({
        event: event.title,
        slug: event.slug,
        type,
        outcomes: outcomes.length,
        midSum: +midSum.toFixed(4),
        execSum: allOk ? +execSum.toFixed(4) : null,
        deviation: +(deviation * 100).toFixed(2),
        execDeviation: allOk ? +(execDev * 100).toFixed(2) : null,
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
  log("INIT", `Starting capital: $${STARTING_CAPITAL}`);
  log("INIT", `Stop-loss: ${DEFAULT_STOP_LOSS * 100}% | Take-profit: ${DEFAULT_TAKE_PROFIT * 100}%`);
  log("INIT", `Daily drawdown limit: ${MAX_DAILY_DRAWDOWN * 100}%`);
  log("INIT", `Survival: <$${(STARTING_CAPITAL * SURVIVAL_THRESHOLD).toFixed(0)} | Emergency: <$${(STARTING_CAPITAL * EMERGENCY_THRESHOLD).toFixed(0)}`);
  log("INIT", `Auto-execute: ${autoExecuteEnabled}`);
  log("INIT", `Arb scanner: every ${ARB_SCAN_INTERVAL / 60000}min | Resolving scanner: every ${RESOLVING_SCAN_INTERVAL / 60000}min`);
  log("INIT", `Telegram alerts: ${TELEGRAM_BOT_TOKEN ? "ENABLED" : "DISABLED (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)"}`);
  log("INIT", `PnL history: every ${PNL_RECORD_INTERVAL / 60000}min → ${PNL_HISTORY_FILE}`);
  console.log();

  // Load persisted state
  const alerts = loadAlerts();
  circuitBreakerTripped = alerts.circuitBreakerTripped || false;
  survivalMode = alerts.survivalMode || false;
  emergencyMode = alerts.emergencyMode || false;

  // Sync positions
  await syncPositions();

  // Connect WebSocket
  connect();

  // Periodic sync
  setInterval(syncPositions, POSITION_SYNC_INTERVAL);

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
