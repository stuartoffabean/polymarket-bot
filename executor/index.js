/**
 * Polymarket Order Executor — Node.js sidecar
 * Uses official @polymarket/clob-client for proper EIP712 order signing
 * 
 * HTTP API on port 3002:
 *   GET  /health
 *   GET  /balance
 *   GET  /positions
 *   GET  /orders
 *   GET  /price?token_id=XXX
 *   GET  /book?token_id=XXX
 *   POST /order  { tokenID, price, size, side: "BUY"|"SELL" }
 *   DELETE /order { orderID }
 *   DELETE /orders (cancel all)
 */

const http = require("http");
const { ClobClient, Side } = require("@polymarket/clob-client");
const { BuilderConfig } = require("@polymarket/builder-signing-sdk");
const { Wallet } = require("ethers");

const HOST = process.env.CLOB_PROXY_URL || "https://clob.polymarket.com";
console.log(`CLOB HOST: ${HOST}`);
const CHAIN_ID = 137;
const PORT = parseInt(process.env.EXECUTOR_PORT || "3002");

// === PRE-TRADE RISK GATE ===
// Enforces position sizing limits BEFORE orders reach the CLOB.
// This is the programmatic fix for the recurring position sizing violations
// documented in LESSONS.md (Feb 11: 17.1% Gov Shutdown, 17% Bangladesh;
// Feb 13: 26.6% Gov Shutdown — all exceeded the 15% max).
const RISK_MAX_SINGLE_POSITION_PCT = 0.15; // 15% of portfolio per position
const RISK_CASH_RESERVE_PCT = 0.10;        // Always keep 10% uninvested
const RISK_MIN_LIQUIDITY_DEPTH = 5;        // Minimum 5 shares of depth at best price
const RISK_MAX_SPREAD_PCT = 0.15;          // 15% spread = skip (illiquid trap)

async function getPortfolioValue() {
  // Try ws-feed first (has live prices)
  try {
    const data = await new Promise((resolve, reject) => {
      const req = http.get("http://localhost:3003/status", (res) => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req.on("error", reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
    });
    if (data.portfolio && data.portfolio.positionValue > 0) {
      return {
        positionValue: data.portfolio.positionValue,
        liquidBalance: data.portfolio.liquidBalance || 0,
        totalValue: data.portfolio.totalValue || data.portfolio.positionValue,
        source: "ws-feed"
      };
    }
  } catch (e) { /* ws-feed unavailable, fallback */ }

  // Fallback: get on-chain balance + position cost basis
  try {
    const { ethers } = require("ethers");
    const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com");
    const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
    const usdc = new ethers.Contract(USDC_E, erc20Abi, provider);
    const bal = await usdc.balanceOf(OUR_ADDR);
    const balance = parseFloat(ethers.utils.formatUnits(bal, 6));
    
    const cached = await getCachedPositions();
    const posValue = cached.openPositions.reduce((sum, p) => sum + p.totalCost, 0);
    
    return {
      positionValue: posValue,
      liquidBalance: balance,
      totalValue: balance + posValue,
      source: "chain+cache"
    };
  } catch (e) {
    return { positionValue: 0, liquidBalance: 0, totalValue: 0, source: "error: " + e.message };
  }
}

async function getExistingExposure(tokenID) {
  // Check if we already hold a position in this token
  try {
    const cached = await getCachedPositions();
    const existing = cached.openPositions.find(p => p.asset_id === tokenID);
    if (existing) {
      return { size: existing.size, costBasis: existing.totalCost, avgPrice: parseFloat(existing.avgPrice) };
    }
  } catch (e) { /* ignore */ }
  return { size: 0, costBasis: 0, avgPrice: 0 };
}

/**
 * Pre-trade risk validation. Returns { allowed, reason, details } 
 * Checks: max single position %, cash reserve, spread, existing exposure.
 * Pass force:true to bypass (logged + alerted).
 */
async function preTradeRiskCheck(tokenID, price, size, side, force = false) {
  // Only validate BUY orders (SELL is always allowed — exiting risk)
  if (side === "SELL") return { allowed: true, reason: "sell_always_allowed" };

  const orderValue = price * size;
  const portfolio = await getPortfolioValue();
  const totalValue = portfolio.totalValue;

  // If portfolio is unknown/zero, use a conservative floor
  const effectivePortfolio = totalValue > 10 ? totalValue : 500;
  
  const checks = [];
  let blocked = false;

  // 1. Single position size check (including existing exposure)
  const existing = await getExistingExposure(tokenID);
  const totalExposure = existing.costBasis + orderValue;
  const exposurePct = totalExposure / effectivePortfolio;
  
  if (exposurePct > RISK_MAX_SINGLE_POSITION_PCT) {
    blocked = true;
    checks.push({
      check: "MAX_SINGLE_POSITION",
      status: "BLOCKED",
      detail: `Total exposure $${totalExposure.toFixed(2)} = ${(exposurePct * 100).toFixed(1)}% of $${effectivePortfolio.toFixed(2)} portfolio (max ${RISK_MAX_SINGLE_POSITION_PCT * 100}%)`,
      existing: existing.costBasis > 0 ? `Already hold $${existing.costBasis.toFixed(2)} in this token` : null,
    });
  } else {
    checks.push({ check: "MAX_SINGLE_POSITION", status: "OK", pct: (exposurePct * 100).toFixed(1) + "%" });
  }

  // 2. Cash reserve check
  const cashAfter = portfolio.liquidBalance - orderValue;
  const reserveRequired = effectivePortfolio * RISK_CASH_RESERVE_PCT;
  if (cashAfter < reserveRequired) {
    blocked = true;
    checks.push({
      check: "CASH_RESERVE",
      status: "BLOCKED",
      detail: `Cash after trade: $${cashAfter.toFixed(2)}, reserve required: $${reserveRequired.toFixed(2)} (${RISK_CASH_RESERVE_PCT * 100}% of portfolio)`,
    });
  } else {
    checks.push({ check: "CASH_RESERVE", status: "OK", cashAfter: "$" + cashAfter.toFixed(2) });
  }

  // 3. Spread / liquidity check (only for non-trivial orders)
  if (orderValue > 2) {
    try {
      const book = await client.getOrderBook(tokenID);
      const bestBid = book.bids?.length > 0 ? parseFloat(book.bids[book.bids.length - 1].price) : null;
      const bestAsk = book.asks?.length > 0 ? parseFloat(book.asks[0].price) : null;
      
      if (bestBid && bestAsk) {
        const spread = (bestAsk - bestBid) / bestAsk;
        if (spread > RISK_MAX_SPREAD_PCT) {
          blocked = true;
          checks.push({
            check: "SPREAD",
            status: "BLOCKED",
            detail: `Spread ${(spread * 100).toFixed(1)}% (bid=${bestBid}, ask=${bestAsk}) exceeds max ${RISK_MAX_SPREAD_PCT * 100}%`,
          });
        } else {
          checks.push({ check: "SPREAD", status: "OK", spread: (spread * 100).toFixed(1) + "%" });
        }
      }
      
      // Check depth at best ask
      if (book.asks?.length > 0) {
        const topAskSize = parseFloat(book.asks[0].size || 0);
        if (topAskSize < RISK_MIN_LIQUIDITY_DEPTH) {
          checks.push({
            check: "DEPTH",
            status: "WARNING",
            detail: `Only ${topAskSize} shares at best ask — thin liquidity`,
          });
        }
      }
    } catch (e) {
      checks.push({ check: "BOOK", status: "SKIP", detail: "Could not fetch order book: " + e.message });
    }
  }

  // Force override
  if (blocked && force) {
    console.log(`⚠️ RISK GATE OVERRIDDEN (force=true): ${checks.filter(c => c.status === "BLOCKED").map(c => c.check).join(", ")}`);
    return {
      allowed: true,
      reason: "force_override",
      overridden: checks.filter(c => c.status === "BLOCKED").map(c => c.check),
      checks,
      portfolio: { total: effectivePortfolio, liquid: portfolio.liquidBalance, source: portfolio.source },
    };
  }

  if (blocked) {
    console.log(`🚫 RISK GATE BLOCKED: ${checks.filter(c => c.status === "BLOCKED").map(c => c.detail).join(" | ")}`);
  }

  return {
    allowed: !blocked,
    reason: blocked ? "risk_check_failed" : "all_checks_passed",
    checks,
    portfolio: { total: effectivePortfolio, liquid: portfolio.liquidBalance, source: portfolio.source },
  };
}

let client;

// === TRADE CACHE — compute position derivation once, invalidate on new trade ===
const OUR_ADDR = "0xe693Ef449979E387C8B4B5071Af9e27a7742E18D".toLowerCase();
let _tradeCache = null;
let _tradeCacheTime = 0;
const TRADE_CACHE_TTL = 30000; // 30s TTL

function invalidateTradeCache() { _tradeCache = null; _tradeCacheTime = 0; }

// Auto-push snapshot to GitHub after trades (debounced 5s so batch sells don't spam)
const { execFile } = require("child_process");
let _snapshotTimer = null;
function triggerSnapshotPush() {
  if (_snapshotTimer) clearTimeout(_snapshotTimer);
  _snapshotTimer = setTimeout(() => {
    console.log("📸 Auto-pushing snapshot after trade...");
    execFile("bash", ["/data/workspace/polymarket-bot/executor/push-snapshot.sh"], 
      { cwd: "/data/workspace/polymarket-bot", timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) console.error("Snapshot push failed:", err.message);
        else console.log("📸 Snapshot pushed to GitHub");
      });
  }, 5000);
}

async function getCachedPositions() {
  if (_tradeCache && (Date.now() - _tradeCacheTime) < TRADE_CACHE_TTL) return _tradeCache;

  const trades = await client.getTrades();
  const posMap = {};

  for (const t of trades) {
    if (t.trader_side === "TAKER") {
      const key = t.asset_id;
      if (!posMap[key]) posMap[key] = { asset_id: key, market: t.market, outcome: t.outcome, size: 0, totalCost: 0, trades: [] };
      const qty = parseFloat(t.size);
      const px = parseFloat(t.price);
      if (t.side === "BUY") { posMap[key].size += qty; posMap[key].totalCost += qty * px; }
      else { posMap[key].size -= qty; posMap[key].totalCost -= qty * px; }
      posMap[key].trades.push(t);
    } else if (t.trader_side === "MAKER" && t.maker_orders) {
      for (const mo of t.maker_orders) {
        if (mo.maker_address && mo.maker_address.toLowerCase() === OUR_ADDR) {
          const key = mo.asset_id;
          if (!posMap[key]) posMap[key] = { asset_id: key, market: t.market, outcome: mo.outcome, size: 0, totalCost: 0, trades: [] };
          const qty = parseFloat(mo.matched_amount);
          const px = parseFloat(mo.price);
          if (mo.side === "BUY") { posMap[key].size += qty; posMap[key].totalCost += qty * px; }
          else { posMap[key].size -= qty; posMap[key].totalCost -= qty * px; }
          posMap[key].trades.push({ ...t, _makerFill: mo });
        }
      }
    }
  }

  const openPositions = Object.values(posMap).filter(p => p.size > 0.001).map(p => ({
    asset_id: p.asset_id, market: p.market, outcome: p.outcome,
    size: p.size, totalCost: p.totalCost,
    avgPrice: p.size > 0 ? (p.totalCost / p.size).toFixed(4) : "0",
  }));

  const allPositions = Object.values(posMap); // includes closed (size <= 0)

  _tradeCache = { trades, posMap, openPositions, allPositions };
  _tradeCacheTime = Date.now();
  return _tradeCache;
}

async function init() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY not set");

  const signer = new Wallet(pk);
  console.log(`Wallet: ${signer.address}`);

  // Create temp client to derive API creds
  const apiCreds = {
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_SECRET,
    passphrase: process.env.POLYMARKET_PASSPHRASE,
  };

  // Builder credentials for order attribution + gas subsidies
  const builderCreds = {
    key: process.env.BUILDER_API_KEY,
    secret: process.env.BUILDER_SECRET,
    passphrase: process.env.BUILDER_PASSPHRASE,
  };
  const builderConfig = (builderCreds.key && builderCreds.secret && builderCreds.passphrase)
    ? new BuilderConfig({ localBuilderCreds: builderCreds })
    : undefined;

  // Signature type 0 = EOA
  // Args: host, chainId, signer, creds, signatureType, funderAddress, geoBlockToken, useServerTime, builderConfig
  client = new ClobClient(HOST, CHAIN_ID, signer, apiCreds, 0, undefined, undefined, undefined, builderConfig);
  console.log(`CLOB client initialized (EOA mode${builderConfig ? ' + Builder attribution' : ''})`);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
  });
}

function parseQuery(url) {
  const q = {};
  const idx = url.indexOf("?");
  if (idx >= 0) {
    url.slice(idx + 1).split("&").forEach((p) => {
      const [k, v] = p.split("=");
      q[decodeURIComponent(k)] = decodeURIComponent(v || "");
    });
  }
  return q;
}

async function handler(req, res) {
  const url = req.url;
  const path = url.split("?")[0];
  const method = req.method;
  const query = parseQuery(url);

  res.setHeader("Content-Type", "application/json");

  try {
    // Health check
    if (path === "/health") {
      return send(res, 200, { ok: true, wallet: client ? "ready" : "not initialized" });
    }

    if (!client) return send(res, 503, { error: "Client not initialized" });

    // GET /balance — on-chain USDC balance
    if (method === "GET" && path === "/balance") {
      try {
        const { ethers } = require("ethers");
        const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com");
        const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
        const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
        const usdc = new ethers.Contract(USDC_E, erc20Abi, provider);
        const bal = await usdc.balanceOf("0xe693Ef449979E387C8B4B5071Af9e27a7742E18D");
        const balance = parseFloat(ethers.utils.formatUnits(bal, 6));
        return send(res, 200, { balance, currency: "USDC", wallet: "executor" });
      } catch(e) {
        return send(res, 500, { error: e.message });
      }
    }

    // GET endpoints
    if (method === "GET") {
      if (path === "/price" && query.token_id) {
        const price = await client.getPrice(query.token_id);
        return send(res, 200, { price });
      }
      if (path === "/midpoint" && query.token_id) {
        const mid = await client.getMidpoint(query.token_id);
        return send(res, 200, { mid });
      }
      if (path === "/book" && query.token_id) {
        const book = await client.getOrderBook(query.token_id);
        return send(res, 200, book);
      }
      if (path === "/orders") {
        const orders = await client.getOpenOrders();
        return send(res, 200, { orders });
      }
      if (path === "/positions") {
        const cached = await getCachedPositions();
        return send(res, 200, { positions: cached.openPositions });
      }
      if (path === "/strategy-pnl") {
        // P&L grouped by strategy tag
        const cached = await getCachedPositions();
        const fs = require("fs");
        const pathMod = require("path");
        
        // Load strategy tags
        let strategyTags = {};
        try { strategyTags = JSON.parse(fs.readFileSync(pathMod.join(__dirname, "..", "strategy-tags.json"), "utf8")); } catch {}
        
        // Load market names
        let marketNames = {};
        try { marketNames = JSON.parse(fs.readFileSync(pathMod.join(__dirname, "market-names.json"), "utf8")); } catch {}
        
        // Get live prices from ws-feed
        let livePrices = {};
        try {
          const priceData = await new Promise((resolve, reject) => {
            http.get("http://localhost:3003/prices", (res) => {
              let d = ""; res.on("data", c => d += c);
              res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
            }).on("error", () => resolve({}));
          });
          livePrices = priceData.prices || {};
        } catch {}
        
        const strategies = {};
        
        for (const pos of cached.allPositions) {
          const tag = strategyTags[pos.asset_id]?.strategy || 'manual';
          if (!strategies[tag]) strategies[tag] = { 
            strategy: tag, openTrades: 0, closedTrades: 0, 
            totalDeployed: 0, realizedPnl: 0, unrealizedPnl: 0,
            positions: []
          };
          
          const s = strategies[tag];
          const name = marketNames[pos.asset_id] || marketNames[pos.market] || pos.market?.slice(0, 20) || 'unknown';
          
          if (pos.size > 0.001) {
            // Open position
            s.openTrades++;
            s.totalDeployed += pos.totalCost;
            
            // Get live bid for unrealized P&L
            const shortId = pos.asset_id.slice(0, 20);
            const liveData = livePrices[shortId];
            const currentBid = liveData ? parseFloat(liveData.bid) : null;
            const currentValue = currentBid ? currentBid * pos.size : null;
            const unrealized = currentValue ? currentValue - pos.totalCost : 0;
            s.unrealizedPnl += unrealized;
            
            s.positions.push({
              asset_id: pos.asset_id.slice(0, 20),
              market: name,
              outcome: pos.outcome,
              size: pos.size,
              avgPrice: parseFloat(pos.avgPrice),
              costBasis: +pos.totalCost.toFixed(2),
              currentValue: currentValue ? +currentValue.toFixed(2) : null,
              unrealizedPnl: +unrealized.toFixed(2),
              status: 'open',
            });
          } else {
            // Closed position — realized P&L = sell proceeds - buy cost
            s.closedTrades++;
            const buyTotal = pos.trades?.filter(t => (t.side === 'BUY' || t._makerFill?.side === 'BUY'))
              .reduce((sum, t) => sum + (parseFloat(t.size || t._makerFill?.matched_amount || 0) * parseFloat(t.price || t._makerFill?.price || 0)), 0) || 0;
            const sellTotal = pos.trades?.filter(t => (t.side === 'SELL' || t._makerFill?.side === 'SELL'))
              .reduce((sum, t) => sum + (parseFloat(t.size || t._makerFill?.matched_amount || 0) * parseFloat(t.price || t._makerFill?.price || 0)), 0) || 0;
            const realized = sellTotal - buyTotal;
            s.realizedPnl += realized;
            s.totalDeployed += Math.abs(pos.totalCost);
            
            s.positions.push({
              asset_id: pos.asset_id.slice(0, 20),
              market: name,
              outcome: pos.outcome,
              realizedPnl: +realized.toFixed(2),
              status: 'closed',
            });
          }
        }
        
        // Round totals
        for (const s of Object.values(strategies)) {
          s.totalDeployed = +s.totalDeployed.toFixed(2);
          s.realizedPnl = +s.realizedPnl.toFixed(2);
          s.unrealizedPnl = +s.unrealizedPnl.toFixed(2);
          s.totalPnl = +(s.realizedPnl + s.unrealizedPnl).toFixed(2);
        }
        
        return send(res, 200, { 
          timestamp: new Date().toISOString(),
          strategies: Object.values(strategies).sort((a, b) => b.totalDeployed - a.totalDeployed),
        });
      }
      if (path === "/trades") {
        const trades = await client.getTrades();
        return send(res, 200, { trades });
      }
      if (path === "/trade-ledger") {
        // Full trade ledger: uses cached trades to avoid re-fetching
        const cached = await getCachedPositions();
        const trades = cached.trades;
        
        // Load market name mappings
        let marketNames = {};
        try { marketNames = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "market-names.json"), "utf8")); } catch(e) {}
        const resolveName = (assetId, conditionId) => marketNames[assetId] || marketNames[conditionId] || conditionId || assetId?.slice(0,16)+'...';
        
        const posMap = {};
        const tradeLog = []; // every individual fill

        for (const t of trades) {
          if (t.trader_side === "TAKER") {
            const key = t.asset_id;
            const mktName = resolveName(key, t.market);
            if (!posMap[key]) posMap[key] = { asset_id: key, market: mktName, outcome: t.outcome, buys: [], sells: [], size: 0, totalBuyCost: 0, totalSellProceeds: 0 };
            const qty = parseFloat(t.size);
            const px = parseFloat(t.price);
            const ts = t.created_at || t.timestamp;
            if (t.side === "BUY") {
              posMap[key].size += qty;
              posMap[key].totalBuyCost += qty * px;
              posMap[key].buys.push({ size: qty, price: px, time: ts });
            } else {
              posMap[key].size -= qty;
              posMap[key].totalSellProceeds += qty * px;
              posMap[key].sells.push({ size: qty, price: px, time: ts });
            }
            tradeLog.push({ asset_id: key, market: mktName, outcome: t.outcome, side: t.side, size: qty, price: px, time: ts });
          } else if (t.trader_side === "MAKER" && t.maker_orders) {
            for (const mo of t.maker_orders) {
              if (mo.maker_address && mo.maker_address.toLowerCase() === OUR_ADDR) {
                const key = mo.asset_id;
                const mktName2 = resolveName(key, t.market);
                if (!posMap[key]) posMap[key] = { asset_id: key, market: mktName2, outcome: mo.outcome, buys: [], sells: [], size: 0, totalBuyCost: 0, totalSellProceeds: 0 };
                const qty = parseFloat(mo.matched_amount);
                const px = parseFloat(mo.price);
                const ts = t.created_at || t.timestamp;
                if (mo.side === "BUY") {
                  posMap[key].size += qty;
                  posMap[key].totalBuyCost += qty * px;
                  posMap[key].buys.push({ size: qty, price: px, time: ts });
                } else {
                  posMap[key].size -= qty;
                  posMap[key].totalSellProceeds += qty * px;
                  posMap[key].sells.push({ size: qty, price: px, time: ts });
                }
                tradeLog.push({ asset_id: key, market: mktName2, outcome: mo.outcome, side: mo.side, size: qty, price: px, time: ts });
              }
            }
          }
        }

        const openPositions = [];
        const closedPositions = [];
        let totalRealizedPnl = 0;

        for (const p of Object.values(posMap)) {
          const avgBuyPrice = p.buys.length > 0 ? p.totalBuyCost / p.buys.reduce((s, b) => s + b.size, 0) : 0;
          const totalBought = p.buys.reduce((s, b) => s + b.size, 0);
          const totalSold = p.sells.reduce((s, b) => s + b.size, 0);
          const realizedPnl = p.totalSellProceeds - (totalSold * avgBuyPrice);

          if (p.size > 0.01) {
            openPositions.push({
              asset_id: p.asset_id,
              market: p.market,
              outcome: p.outcome,
              size: Math.round(p.size * 100) / 100,
              avgPrice: avgBuyPrice.toFixed(4),
              costBasis: (p.size * avgBuyPrice).toFixed(2),
              totalBought,
              totalSold,
              realizedPnl: realizedPnl.toFixed(2),
              status: "OPEN",
              firstBuy: p.buys[0]?.time,
              lastTrade: [...p.buys, ...p.sells].sort((a, b) => new Date(b.time) - new Date(a.time))[0]?.time,
            });
          } else {
            const closed = {
              asset_id: p.asset_id,
              market: p.market,
              outcome: p.outcome,
              totalBought,
              totalSold,
              avgBuyPrice: avgBuyPrice.toFixed(4),
              avgSellPrice: totalSold > 0 ? (p.totalSellProceeds / totalSold).toFixed(4) : "0",
              totalCost: p.totalBuyCost.toFixed(2),
              totalProceeds: p.totalSellProceeds.toFixed(2),
              realizedPnl: realizedPnl.toFixed(2),
              realizedPnlPct: p.totalBuyCost > 0 ? ((realizedPnl / p.totalBuyCost) * 100).toFixed(1) : "0",
              status: "CLOSED",
              firstBuy: p.buys[0]?.time,
              lastTrade: [...p.buys, ...p.sells].sort((a, b) => new Date(b.time) - new Date(a.time))[0]?.time,
            };
            closedPositions.push(closed);
            totalRealizedPnl += realizedPnl;
          }
        }

        // Merge manual positions (personal wallet) into open positions
        try {
          const manualPath = require("path").join(__dirname, "manual-positions.json");
          const manualData = JSON.parse(require("fs").readFileSync(manualPath, "utf8"));
          for (const [assetId, mp] of Object.entries(manualData)) {
            // Skip if already in openPositions (by asset_id prefix match)
            const prefix = assetId.slice(0, 20);
            const alreadyTracked = openPositions.some(op => op.asset_id.slice(0, 20) === prefix);
            if (!alreadyTracked && mp.size > 0) {
              const mktName = mp.market || resolveName(assetId, "");
              openPositions.push({
                asset_id: assetId,
                market: mktName,
                outcome: mp.outcome || "Yes",
                size: mp.size,
                avgPrice: (mp.avgPrice || 0).toFixed(4),
                costBasis: (mp.size * (mp.avgPrice || 0)).toFixed(2),
                totalBought: mp.size,
                totalSold: 0,
                realizedPnl: "0.00",
                status: "OPEN",
                source: "personal_wallet",
                firstBuy: mp.addedAt || null,
                lastTrade: mp.addedAt || null,
              });
            }
          }
        } catch(e) { /* no manual positions file */ }

        return send(res, 200, {
          openPositions,
          closedPositions,
          totalRealizedPnl: totalRealizedPnl.toFixed(2),
          tradeCount: tradeLog.length,
          tradeLog: tradeLog.sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 50),
          timestamp: new Date().toISOString(),
        });
      }
      if (path === "/api/pnl" || path === "/pnl") {
        // Read P&L history from snapshots file
        const pnlPath = require("path").join(__dirname, "..", "pnl-history.json");
        try {
          const data = require("fs").readFileSync(pnlPath, "utf8");
          return send(res, 200, JSON.parse(data));
        } catch(e) {
          return send(res, 200, { points: [] });
        }
      }
      // GET /risk-check?token_id=XXX&price=0.50&size=100&side=BUY
      // Preview risk check without placing order
      if (path === "/risk-check") {
        const tokenID = query.token_id;
        const price = parseFloat(query.price || "0");
        const size = parseFloat(query.size || "0");
        const side = query.side || "BUY";
        if (!tokenID || !price || !size) return send(res, 400, { error: "Need token_id, price, size params" });
        const result = await preTradeRiskCheck(tokenID, price, size, side, false);
        return send(res, 200, result);
      }
      if (path === "/api/snapshot" || path === "/snapshot") {
        const cached = await getCachedPositions();
        const orders = await client.getOpenOrders();
        return send(res, 200, { 
          status: "ok", 
          positions: cached.openPositions, 
          orders,
          timestamp: new Date().toISOString()
        });
      }
    }

    // POST /order — place order (with pre-trade risk validation)
    if (method === "POST" && path === "/order") {
      const body = await parseBody(req);
      const { tokenID, price, size, side } = body;
      
      if (!tokenID || !price || !size || !side) {
        return send(res, 400, { error: "Missing tokenID, price, size, or side" });
      }

      // === PRE-TRADE RISK GATE ===
      // Validates position sizing, cash reserve, spread before execution.
      // Pass force:true to bypass (logged). skipRiskCheck:true for internal
      // auto-execution paths (ws-feed) that have their own risk checks.
      const skipRisk = body.skipRiskCheck === true;
      const forceRisk = body.force === true;
      
      if (!skipRisk) {
        const riskResult = await preTradeRiskCheck(tokenID, parseFloat(price), parseFloat(size), side, forceRisk);
        if (!riskResult.allowed) {
          console.log(`🚫 ORDER REJECTED by risk gate: ${side} ${size} @ ${price}`);
          return send(res, 422, {
            error: "Order rejected by pre-trade risk check",
            riskResult,
            hint: "Pass force:true to override (will be logged), or reduce position size",
          });
        }
        // Log risk check result for audit
        if (riskResult.overridden) {
          console.log(`⚠️ RISK OVERRIDE: ${riskResult.overridden.join(", ")}`);
        }
      }

      const orderType = body.orderType || "GTC"; // GTC, GTD, FOK
      console.log(`Placing ${orderType} order: ${side} ${size} @ ${price} on ${tokenID.slice(0, 20)}...`);
      
      const orderOpts = {
        tokenID,
        price: parseFloat(price),
        size: parseFloat(size),
        side: side === "BUY" ? Side.BUY : Side.SELL,
      };

      // FOK = Fill or Kill (for arb trades — v3 §4)
      if (orderType === "GTD" && body.expiration) orderOpts.expiration = body.expiration;

      // Post-only = maker order (earns rebates, never takes liquidity)
      const postOnly = body.postOnly === true;
      if (postOnly) console.log("  → Post-only (maker) order");

      const order = await client.createAndPostOrder(orderOpts, undefined, orderType, false, postOnly);
      invalidateTradeCache();
      triggerSnapshotPush();

      console.log(`Order result:`, JSON.stringify(order));
      return send(res, 200, order);
    }

    // POST /market-sell — sell position at best bid (emergency exit)
    if (method === "POST" && path === "/market-sell") {
      const body = await parseBody(req);
      const { tokenID, size } = body;
      if (!tokenID || !size) return send(res, 400, { error: "Missing tokenID or size" });

      // Get current best bid
      const book = await client.getOrderBook(tokenID);
      // CLOB REST API returns bids ascending (lowest first, best/highest last)
      const bestBid = book.bids && book.bids.length > 0 
        ? parseFloat(book.bids[book.bids.length - 1].price) 
        : null;
      
      if (!bestBid) return send(res, 400, { error: "No bids available" });

      console.log(`🚨 MARKET SELL: ${size} @ ${bestBid} (best bid) on ${tokenID.slice(0, 20)}...`);
      
      const order = await client.createAndPostOrder({
        tokenID,
        price: bestBid,
        size: parseFloat(size),
        side: Side.SELL,
      });

      console.log(`Sell result:`, JSON.stringify(order));
      invalidateTradeCache();
      triggerSnapshotPush();
      return send(res, 200, { ...order, executedPrice: bestBid });
    }

    // POST /batch-orders — submit multiple orders concurrently (v3 §4: speed)
    if (method === "POST" && path === "/batch-orders") {
      const body = await parseBody(req);
      const { orders: orderList } = body; // [{ tokenID, price, size, side, orderType }]
      if (!orderList || !Array.isArray(orderList)) return send(res, 400, { error: "Need orders array" });

      console.log(`⚡ BATCH: Submitting ${orderList.length} orders concurrently`);
      const results = await Promise.allSettled(
        orderList.map(o => client.createAndPostOrder({
          tokenID: o.tokenID,
          price: parseFloat(o.price),
          size: parseFloat(o.size),
          side: o.side === "BUY" ? Side.BUY : Side.SELL,
          ...(o.orderType === "FOK" ? { orderType: "FOK" } : {}),
        }))
      );

      const summary = results.map((r, i) => ({
        index: i,
        status: r.status,
        result: r.status === "fulfilled" ? r.value : null,
        error: r.status === "rejected" ? r.reason?.message : null,
      }));
      const filled = summary.filter(s => s.status === "fulfilled").length;
      console.log(`BATCH: ${filled}/${orderList.length} succeeded`);
      return send(res, 200, { total: orderList.length, filled, results: summary });
    }

    // POST /arb — execute both legs of an arbitrage simultaneously (FOK)
    // v3 §4: Always use FOK for simultaneous legs
    // v3 §7: Partial fill → immediately unwind filled leg
    if (method === "POST" && path === "/arb") {
      const body = await parseBody(req);
      const { legs } = body; // [{ tokenID, price, size, side }, ...]
      
      if (!legs || legs.length < 2) return send(res, 400, { error: "Need at least 2 legs" });

      console.log(`⚡ ARB: Executing ${legs.length} legs simultaneously (FOK)`);
      
      const results = await Promise.allSettled(
        legs.map(leg => 
          client.createAndPostOrder({
            tokenID: leg.tokenID,
            price: parseFloat(leg.price),
            size: parseFloat(leg.size),
            side: leg.side === "BUY" ? Side.BUY : Side.SELL,
            orderType: "FOK",
          })
        )
      );

      const filled = [];
      const failed = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && r.value && !r.value.error) {
          filled.push({ leg: i, result: r.value });
        } else {
          failed.push({ leg: i, error: r.reason?.message || r.value?.error || "Unknown" });
        }
      });

      // v3 §7: If partial fill, unwind
      if (filled.length > 0 && failed.length > 0) {
        console.log(`🚨 PARTIAL FILL: ${filled.length}/${legs.length} legs filled — UNWINDING`);
        
        const unwindResults = [];
        for (const f of filled) {
          const leg = legs[f.leg];
          try {
            // Sell what we bought, buy back what we sold
            const unwindSide = leg.side === "BUY" ? Side.SELL : Side.BUY;
            const book = await client.getOrderBook(leg.tokenID);
            const unwindPrice = unwindSide === Side.SELL 
              ? (book.bids?.length > 0 ? parseFloat(book.bids[book.bids.length - 1].price) : null)
              : (book.asks?.length > 0 ? parseFloat(book.asks[0].price) : null);
            
            if (unwindPrice) {
              const unwind = await client.createAndPostOrder({
                tokenID: leg.tokenID,
                price: unwindPrice,
                size: parseFloat(leg.size),
                side: unwindSide,
              });
              unwindResults.push({ leg: f.leg, price: unwindPrice, result: unwind });
            }
          } catch (e) {
            unwindResults.push({ leg: f.leg, error: e.message });
          }
        }
        
        return send(res, 200, { 
          status: "PARTIAL_FILL_UNWOUND",
          filled, failed, unwindResults,
          warning: "Arbitrage incomplete — filled legs unwound"
        });
      }

      return send(res, 200, { 
        status: filled.length === legs.length ? "ALL_FILLED" : "ALL_FAILED",
        filled, failed 
      });
    }

    // GET /get-order?id=... — fetch order status from CLOB
    if (method === "GET" && path === "/get-order") {
      const orderID = query.id;
      if (!orderID) return send(res, 400, { error: "Missing id param" });
      const order = await client.getOrder(orderID);
      return send(res, 200, order);
    }

    // POST /cancel-order — cancel specific order (used by ws-feed confirmOrder)
    if (method === "POST" && path === "/cancel-order") {
      const body = await parseBody(req);
      const { orderID } = body;
      if (!orderID) return send(res, 400, { error: "Missing orderID" });
      const result = await client.cancelOrder(orderID);
      return send(res, 200, { success: true, result });
    }

    // DELETE /order — cancel specific order
    if (method === "DELETE" && path === "/order") {
      const body = await parseBody(req);
      const { orderID } = body;
      if (!orderID) return send(res, 400, { error: "Missing orderID" });
      
      const result = await client.cancelOrder(orderID);
      return send(res, 200, { success: true, result });
    }

    // DELETE /orders — cancel all
    if (method === "DELETE" && path === "/orders") {
      const result = await client.cancelAll();
      return send(res, 200, { success: true, result });
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("Error:", err.message);
    send(res, 500, { error: err.message });
  }
}

function send(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

async function main() {
  await init();
  
  const server = http.createServer(handler);
  server.listen(PORT, () => {
    console.log(`Executor API running on http://0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
