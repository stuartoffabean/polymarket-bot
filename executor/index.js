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
const https = require("https");
const { ClobClient, Side } = require("@polymarket/clob-client");
const { BuilderConfig } = require("@polymarket/builder-signing-sdk");
const { Wallet } = require("ethers");

const HOST = process.env.CLOB_PROXY_URL || "https://clob.polymarket.com";
console.log(`CLOB HOST: ${HOST}`);
const CHAIN_ID = 137;
const PORT = parseInt(process.env.EXECUTOR_PORT || "3002");

// === POLYGON RPC FALLBACK ===
// Multiple RPC providers to avoid single-point-of-failure on balance checks.
// If the primary is down, we cycle through alternatives before giving up.
const POLYGON_RPC_URLS = [
  "https://polygon-rpc.com",
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://1rpc.io/matic",
];
const USDC_E_ADDR = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function getPolygonProvider() {
  const { ethers } = require("ethers");
  for (const url of POLYGON_RPC_URLS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(url);
      await provider.getNetwork(); // verify connectivity
      return provider;
    } catch (e) { /* try next */ }
  }
  throw new Error("All Polygon RPC providers failed");
}

// === PRE-TRADE RISK GATE ===
// Enforces position sizing limits BEFORE orders reach the CLOB.
// This is the programmatic fix for the recurring position sizing violations
// documented in LESSONS.md (Feb 11: 17.1% Gov Shutdown, 17% Bangladesh;
// Feb 13: 26.6% Gov Shutdown — all exceeded the 15% max).
const RISK_MAX_SINGLE_POSITION_PCT = 0.15; // 15% of portfolio per position
const RISK_CASH_RESERVE_PCT = 0.10;        // Always keep 10% uninvested
const RISK_MIN_LIQUIDITY_DEPTH = 5;        // Minimum 5 shares of depth at best price
const RISK_MAX_SPREAD_PCT = 0.15;          // 15% spread = skip (illiquid trap)
const RISK_MAX_CORRELATED_PCT = 0.15;      // 15% combined exposure across correlated positions (same event)

// === FEATURE 1: TOTAL DIRECTIONAL EXPOSURE CAP ===
const RISK_MAX_TOTAL_DIRECTIONAL_PCT = 0.60; // Max 60% of bankroll in manual positions

// === FEATURE 2: ENTRY QUALITY GATE ===
const ENTRY_MAX_PRICE_LONG_HORIZON = 0.85;   // No manual entries above 85¢ unless <24h to resolution

// === FEATURE 4: THESIS REQUIRED GATE (2026-02-16 Meta-Analysis Fix) ===
// Root cause: $43 of $86 total losses from scanner-generated trades with ZERO research.
// Fix: No BUY order executes without a thesis on file. Forces research before capital deployment.
const THESIS_REQUIRED = true;

// === TRADING HALT ===
// Master kill switch: blocks ALL new BUY orders on every endpoint (/order, /execute-opportunity, etc.)
// Set to true when operator halts real-money entries. SELL orders always allowed (exiting risk).
// Toggle via: POST /trading-halt { enabled: true/false }
let TRADING_HALTED = true; // DEFAULT: halted per operator directive 2026-02-16

// === FEATURE 5: LOTTERY TICKET BAN (2026-02-16 Meta-Analysis Fix) ===
// Root cause: Spray-and-pray lottery tickets (<5¢) create false confidence from lucky wins.
// At our accuracy level, <5% implied probability events are pure gambling.
const LOTTERY_MIN_PRICE = 0.05;            // Block entries below 5¢
const MIN_ORDER_VALUE = 2.00;              // Block orders under $2 (execution cycle waste at current scale)

// === SHARED: Polymarket Data API Position Fetcher ===
// Single source of truth for all position queries. Uses data-api.polymarket.com
// which returns ACTUAL on-chain positions (not reconstructed from trade history).
// INFRA-001: Never reconstruct positions from getTrades() — it misses sells and creates phantoms.
const OUR_ADDR_CHECKSUM = "0xe693Ef449979E387C8B4B5071Af9e27a7742E18D";
let _dataApiCache = null;
let _dataApiCacheTime = 0;
const DATA_API_CACHE_TTL = 30_000; // 30s cache

async function getDataApiPositions(forceRefresh = false) {
  if (!forceRefresh && _dataApiCache && (Date.now() - _dataApiCacheTime) < DATA_API_CACHE_TTL) {
    return _dataApiCache;
  }
  return new Promise((resolve, reject) => {
    const url = `https://data-api.polymarket.com/positions?user=${OUR_ADDR_CHECKSUM}&limit=200&sizeThreshold=0`;
    const req = https.get(url, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const positions = JSON.parse(d);
          if (!Array.isArray(positions)) return reject(new Error(`data API: non-array response: ${d.slice(0,100)}`));
          _dataApiCache = positions;
          _dataApiCacheTime = Date.now();
          resolve(positions);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("data API timeout")); });
  });
}

/**
 * Check Polymarket data API for resolved positions.
 * Positions with redeemable=true have resolved. Records P&L and notifies.
 */
async function checkResolutions() {
  const https = require("https");
  const addr = OUR_ADDR || "0xe693Ef449979E387C8B4B5071Af9e27a7742E18D".toLowerCase();
  
  return new Promise((resolve, reject) => {
    const url = `https://data-api.polymarket.com/positions?user=${addr}&limit=200&sizeThreshold=0`;
    const req = https.get(url, (res) => {
      let d = ""; 
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const positions = JSON.parse(d);
          if (!Array.isArray(positions)) return resolve({ error: "unexpected response", raw: d.slice(0, 200) });
          
          const resolved = loadResolved();
          const newlyResolved = [];
          
          for (const p of positions) {
            if (!p.redeemable) continue;           // Not resolved yet
            if (resolved[p.asset]) continue;         // Already recorded
            if (p.size <= 0) continue;               // No position
            
            const won = p.curPrice >= 0.99 || p.currentValue > 0;
            const payout = won ? p.size : 0;         // $1 per share if won
            const costBasis = p.size * p.avgPrice;
            const pnl = payout - costBasis;
            
            const record = {
              asset_id: p.asset,
              conditionId: p.conditionId,
              market: p.title || p.slug || "Unknown",
              outcome: p.outcome || "Yes",
              size: p.size,
              avgPrice: p.avgPrice,
              costBasis: parseFloat(costBasis.toFixed(4)),
              payout: parseFloat(payout.toFixed(4)),
              realizedPnl: parseFloat(pnl.toFixed(4)),
              won,
              resolvedAt: new Date().toISOString(),
              endDate: p.endDate,
              slug: p.slug,
            };
            
            resolved[p.asset] = record;
            newlyResolved.push(record);
            
            // EXIT LEDGER — log resolution
            logExit({
              assetId: p.asset,
              market: record.market,
              outcome: record.outcome,
              reason: won ? EXIT_REASONS.RESOLUTION_WON : EXIT_REASONS.RESOLUTION_LOST,
              triggerSource: "resolution-detection",
              entryPrice: p.avgPrice,
              exitPrice: won ? 1.0 : 0,
              size: p.size,
              costBasis: record.costBasis,
              proceeds: record.payout,
              realizedPnl: record.realizedPnl,
              strategy: "unknown",
              notes: `Resolved ${record.won ? "WON" : "LOST"} at ${record.resolvedAt}`,
            });

            // Telegram notification
            const emoji = won ? "✅" : "❌";
            const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
            sendTelegramAlert(`${emoji} <b>MARKET RESOLVED</b>\n${p.title || p.slug}\nOutcome: ${record.outcome} ${won ? "WON" : "LOST"}\nSize: ${p.size} shares @ $${p.avgPrice.toFixed(4)}\nPayout: $${payout.toFixed(2)}\nP&L: ${pnlStr}`);
          }
          
          if (newlyResolved.length > 0) {
            saveResolved(resolved);
            console.log(`[RESOLUTION] ${newlyResolved.length} newly resolved positions recorded`);
            
            // Remove from ws-feed tracking (with retry)
            for (const r of newlyResolved) {
              const removeFromFeed = () => {
                const req = http.request({ hostname: "localhost", port: 3003, path: "/remove-position", method: "POST",
                  headers: { "Content-Type": "application/json" }
                }, (res) => {
                  let body = '';
                  res.on('data', d => body += d);
                  res.on('end', () => console.log(`[RESOLUTION] Removed ${r.asset_id.slice(0,20)} from ws-feed: ${body}`));
                });
                req.on("error", (e) => {
                  console.error(`[RESOLUTION] Failed to remove ${r.asset_id.slice(0,20)} from ws-feed: ${e.message}, retrying in 5s...`);
                  setTimeout(removeFromFeed, 5000);
                });
                req.end(JSON.stringify({ assetId: r.asset_id }));
              };
              removeFromFeed();
            }
          }
          
          resolve({ total: Object.keys(resolved).length, newlyResolved, allResolved: resolved });
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

/**
 * Auto-redeem resolved positions on-chain.
 * For NegRisk markets: CTF.redeemPositions(WCOL, 0x0, conditionId, [1,2])
 * Then unwrap WCOL → USDC.e via WCOL.unwrap(to, amount)
 * Runs after checkResolutions() detects redeemable positions.
 */
async function autoRedeem() {
  const { ethers } = require("ethers");

  const CTF_ADDR = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
  const WCOL_ADDR = "0x3A3BD7bb9528E159577F7C2e685CC81A765002E2";

  const CTF_ABI = [
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
  ];
  const WCOL_ABI = [
    "function unwrap(address _to, uint256 _amount) external",
    "function balanceOf(address) view returns (uint256)",
  ];

  const pk = process.env.PRIVATE_KEY;
  if (!pk) { console.log("[REDEEM] No PRIVATE_KEY, skipping"); return { redeemed: 0 }; }

  // Connect to a working RPC (uses shared fallback list)
  let provider, wallet;
  try {
    provider = await getPolygonProvider();
    wallet = new ethers.Wallet(pk, provider);
  } catch (e) {
    console.log("[REDEEM] All RPCs failed"); return { redeemed: 0, error: "no RPC" };
  }

  // Fetch redeemable positions from data API
  const https = require("https");
  const positions = await new Promise((resolve, reject) => {
    const addr = OUR_ADDR || "0xe693Ef449979E387C8B4B5071Af9e27a7742E18D".toLowerCase();
    const req = https.get(`https://data-api.polymarket.com/positions?user=${addr}&limit=200&sizeThreshold=0`, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
  });

  if (!Array.isArray(positions)) return { redeemed: 0, error: "bad response" };

  const redeemable = positions.filter(p => p.redeemable && p.size > 0 && p.negativeRisk);
  if (redeemable.length === 0) return { redeemed: 0 };

  // Group by conditionId (deduplicate)
  const conditions = {};
  for (const p of redeemable) {
    if (!conditions[p.conditionId]) conditions[p.conditionId] = { title: p.title, value: 0 };
    conditions[p.conditionId].value += (p.currentValue || 0);
  }

  console.log(`[REDEEM] Found ${Object.keys(conditions).length} redeemable conditions (${redeemable.length} positions)`);

  const ctf = new ethers.Contract(CTF_ADDR, CTF_ABI, wallet);
  const gasPrice = (await provider.getGasPrice()).mul(130).div(100);

  let redeemed = 0;
  let totalValue = 0;
  const results = [];

  for (const [condId, info] of Object.entries(conditions)) {
    try {
      const tx = await ctf.redeemPositions(WCOL_ADDR, ethers.constants.HashZero, condId, [1, 2], {
        gasLimit: 300000, gasPrice, type: 0,
      });
      const receipt = await tx.wait(1);
      if (receipt.status === 1) {
        redeemed++;
        totalValue += info.value;
        console.log(`[REDEEM] ✅ ${info.title?.slice(0, 40)} (value: $${info.value.toFixed(2)})`);
        results.push({ conditionId: condId, title: info.title, value: info.value, tx: tx.hash });
      } else {
        console.log(`[REDEEM] ❌ Reverted: ${info.title?.slice(0, 40)}`);
      }
      // Small delay between txs
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.log(`[REDEEM] ❌ ${info.title?.slice(0, 40)}: ${e.message?.slice(0, 80)}`);
    }
  }

  // Unwrap WCOL → USDC.e
  if (redeemed > 0) {
    try {
      const wcol = new ethers.Contract(WCOL_ADDR, WCOL_ABI, wallet);
      const wcolBal = await wcol.balanceOf(wallet.address);
      if (wcolBal.gt(0)) {
        const wcolAmount = ethers.utils.formatUnits(wcolBal, 6);
        console.log(`[REDEEM] Unwrapping ${wcolAmount} WCOL → USDC.e`);
        const tx = await wcol.unwrap(wallet.address, wcolBal, {
          gasLimit: 100000, gasPrice, type: 0,
        });
        const receipt = await tx.wait(1);
        if (receipt.status === 1) {
          console.log(`[REDEEM] ✅ Unwrapped ${wcolAmount} WCOL → USDC.e`);
          // Telegram alert for the total redemption
          sendTelegramAlert(`💰 <b>AUTO-REDEEMED</b>\n${redeemed} resolved position(s)\nTotal value: $${totalValue.toFixed(2)}\nUSDC.e recovered: $${wcolAmount}`);
        }
      }
    } catch (e) {
      console.log(`[REDEEM] ⚠️ WCOL unwrap failed: ${e.message?.slice(0, 100)}`);
      sendTelegramAlert(`⚠️ <b>REDEEM WARNING</b>\n${redeemed} positions redeemed but WCOL unwrap failed!\nManual unwrap needed for $${totalValue.toFixed(2)}`);
    }
  }

  return { redeemed, totalValue, results };
}

/**
 * Position reconciliation: cross-check manual-positions.json against actual on-chain holdings.
 * Flags phantom positions (we think we hold shares but actually don't).
 */
async function reconcilePositions() {
  const https = require("https");
  const addr = "0xe693Ef449979E387C8B4B5071Af9e27a7742E18D".toLowerCase();

  // 1. Get actual positions from data API
  const actual = await new Promise((resolve, reject) => {
    const req = https.get(`https://data-api.polymarket.com/positions?user=${addr}&limit=200&sizeThreshold=0`, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
  });
  if (!Array.isArray(actual)) return { error: "unexpected response" };

  // Build map of actual holdings: asset_id -> { size, curPrice, title }
  const actualMap = {};
  for (const p of actual) {
    if (p.size > 0.001) {
      actualMap[p.asset] = { size: p.size, curPrice: p.curPrice, title: p.title, redeemable: p.redeemable };
    }
  }

  // 2. Load manual positions
  const manualPath = path.join(__dirname, "manual-positions.json");
  let manual = {};
  try { manual = JSON.parse(fs.readFileSync(manualPath, "utf8")); } catch(e) { return { error: "no manual-positions.json" }; }

  // 3. Compare
  const phantoms = [];
  const mismatches = [];
  for (const [assetId, mp] of Object.entries(manual)) {
    if (!mp.size || mp.size <= 0) continue;
    const onChain = actualMap[assetId];
    if (!onChain) {
      // PHANTOM: we think we hold it but on-chain says NO
      phantoms.push({ assetId, market: mp.market, trackedSize: mp.size, actualSize: 0 });
    } else if (Math.abs(onChain.size - mp.size) > 0.5) {
      // SIZE MISMATCH: significant difference
      mismatches.push({ assetId, market: mp.market, trackedSize: mp.size, actualSize: onChain.size, diff: mp.size - onChain.size });
    }
  }

  // 4. Auto-fix phantoms: remove from manual-positions.json and alert
  if (phantoms.length > 0) {
    for (const p of phantoms) {
      delete manual[p.assetId];
      // Remove from ws-feed tracking too
      http.request({ hostname: "localhost", port: 3003, path: "/remove-position", method: "POST",
        headers: { "Content-Type": "application/json" }
      }, () => {}).on("error", () => {}).end(JSON.stringify({ assetId: p.assetId }));
    }
    writeFileAtomic(manualPath, manual);

    const phantomList = phantoms.map(p => `• ${p.market || p.assetId.slice(0,20)} (tracked ${p.trackedSize}sh, actual 0)`).join("\n");
    sendTelegramAlert(`🚨 <b>PHANTOM POSITIONS DETECTED & REMOVED</b>\n${phantomList}\n\nThese positions were in tracking but NOT on-chain. Auto-cleaned.`);
    console.log(`[RECONCILE] Removed ${phantoms.length} phantom positions`);
  }

  if (mismatches.length > 0) {
    const mismatchList = mismatches.map(m => `• ${m.market || m.assetId.slice(0,20)} (tracked ${m.trackedSize}sh, actual ${m.actualSize}sh)`).join("\n");
    sendTelegramAlert(`⚠️ <b>POSITION SIZE MISMATCHES</b>\n${mismatchList}`);
    console.log(`[RECONCILE] ${mismatches.length} size mismatches found`);
  }

  return { phantoms, mismatches, manualCount: Object.keys(manual).length, onChainCount: Object.keys(actualMap).length };
}

const ENTRY_EXEMPT_STRATEGIES = ["resolution", "arb"]; // RH has own validated params

// === FEATURE 5: DEPTH CHECK FOR MANUAL ORDERS ===
const DEPTH_SLIPPAGE_TOL_MANUAL = 0.02;  // 2% max slippage
const DEPTH_MIN_SHARES_MANUAL = 5;       // Don't bother with <5 shares

const fs = require("fs");
const path = require("path");
const { logExit, getExits, getExitSummary, EXIT_REASONS } = require("./exit-ledger");
const { logIntent, resolveIntent, getUnresolved, markStaleAsUnresolved } = require("./trade-wal");
const { writeFileAtomic } = require("./safe-write");
const positionLedger = require("./position-ledger");

// Market name resolver — loads from market-names.json
function getMarketName(assetIdOrConditionId) {
  try {
    const names = JSON.parse(fs.readFileSync(path.join(__dirname, "market-names.json"), "utf8"));
    return names[assetIdOrConditionId] || null;
  } catch { return null; }
}

// === RESOLUTION DETECTION ===
const RESOLVED_FILE = path.join(__dirname, "..", "resolved-positions.json");
function loadResolved() { try { return JSON.parse(fs.readFileSync(RESOLVED_FILE, "utf8")); } catch(e) { return {}; } }
function saveResolved(data) { writeFileAtomic(RESOLVED_FILE, data); }

// === EVENT MAP: conditionId → eventGroupId (for correlation checking) ===
// eventGroupId = neg_risk_market_id (for NegRisk multi-outcome markets) or market_slug (for standalone)
// This groups positions that bet on the same underlying event (e.g., multiple Bad Bunny markets)
const EVENT_MAP_FILE = path.join(__dirname, "event-map.json");
function loadEventMap() { try { return JSON.parse(fs.readFileSync(EVENT_MAP_FILE, "utf8")); } catch(e) { return {}; } }
function saveEventMap(data) { writeFileAtomic(EVENT_MAP_FILE, data); }

// Look up the event group for a conditionId. Checks local cache first, then CLOB API.
async function getEventGroup(conditionId) {
  if (!conditionId) return null;
  const eventMap = loadEventMap();
  if (eventMap[conditionId]) return eventMap[conditionId];
  
  // Fetch from CLOB API — neg_risk_market_id groups NegRisk markets, market_slug for standalone
  try {
    const proxyUrl = process.env.CLOB_PROXY_URL || "https://clob.polymarket.com";
    const resp = await fetch(`${proxyUrl}/markets/${conditionId}`);
    if (resp.ok) {
      const data = await resp.json();
      // NegRisk markets share neg_risk_market_id — that's the event-level correlation key
      // Standalone markets use market_slug as a unique key
      const groupId = data.neg_risk_market_id || data.market_slug || null;
      if (groupId) {
        eventMap[conditionId] = groupId;
        saveEventMap(eventMap);
        console.log(`[CORRELATION] Mapped ${conditionId.slice(0,20)} → ${groupId.slice(0,50)}`);
        return groupId;
      }
    }
  } catch (e) { console.log(`[CORRELATION] Failed to lookup ${conditionId}: ${e.message}`); }
  return null;
}

// Register a conditionId → eventGroupId mapping (called on trade execution)
function registerEventMapping(conditionId, eventGroupId) {
  if (!conditionId || !eventGroupId) return;
  const eventMap = loadEventMap();
  if (eventMap[conditionId] !== eventGroupId) {
    eventMap[conditionId] = eventGroupId;
    saveEventMap(eventMap);
  }
}

// Get total cost basis of all open positions correlated to a given event group
async function getCorrelatedExposure(eventGroupId, excludeTokenID) {
  if (!eventGroupId) return { total: 0, positions: [] };
  const eventMap = loadEventMap();
  const cached = await getCachedPositions();
  
  // Find all conditionIds belonging to this event group
  const correlatedConditionIds = new Set();
  for (const [cid, gid] of Object.entries(eventMap)) {
    if (gid === eventGroupId) correlatedConditionIds.add(cid);
  }
  
  // Sum exposure across all open positions whose market (conditionId) is correlated
  let total = 0;
  const positions = [];
  for (const pos of cached.openPositions) {
    if (pos.asset_id === excludeTokenID) continue; // Don't double-count the token being checked
    const posConditionId = pos.market; // In CLOB trade data, "market" = conditionId
    if (correlatedConditionIds.has(posConditionId)) {
      total += pos.totalCost;
      positions.push({ asset_id: pos.asset_id, conditionId: posConditionId, costBasis: pos.totalCost, outcome: pos.outcome });
    }
  }
  return { total, positions };
}

// === DAILY CONVICTION BUDGET ===
// Max 30% of bankroll in NEW manual positions per day. Resets at midnight UTC.
// Resolution Hunter exempt (validated strategy with own limits).
const DAILY_CONVICTION_BUDGET_PCT = 1.00; // Unblocked per operator directive 2026-02-15
const DAILY_BUDGET_FILE = path.join(__dirname, "daily-conviction-budget.json");

function loadDailyBudget() {
  try {
    const data = JSON.parse(fs.readFileSync(DAILY_BUDGET_FILE, "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    if (data.date === today) return data;
    // New day — reset
    return { date: today, deployed: 0, trades: [] };
  } catch {
    return { date: new Date().toISOString().slice(0, 10), deployed: 0, trades: [] };
  }
}

function saveDailyBudget(budget) {
  writeFileAtomic(DAILY_BUDGET_FILE, budget);
}

function recordDailyBudgetSpend(orderValue, market) {
  const budget = loadDailyBudget();
  budget.deployed += orderValue;
  budget.trades.push({ market, value: orderValue, time: new Date().toISOString() });
  saveDailyBudget(budget);
  return budget;
}

// === FEATURE 3: THESIS TRACKING ===
const THESES_DIR = path.join(__dirname, "..", "theses");
if (!fs.existsSync(THESES_DIR)) fs.mkdirSync(THESES_DIR, { recursive: true });

function saveThesis(tokenID, thesis) {
  const file = path.join(THESES_DIR, `${tokenID.slice(0, 20)}.json`);
  fs.writeFileSync(file, JSON.stringify(thesis, null, 2));
  console.log(`📝 Thesis saved: ${thesis.market} → ${file}`);
}

function loadThesis(tokenID) {
  const file = path.join(THESES_DIR, `${tokenID.slice(0, 20)}.json`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * Entry quality score (1-10). Higher = better entry.
 * Factors: price (lower=better), time to resolution (shorter=better), edge magnitude
 */
function computeEntryQuality(price, hoursToResolution, edge) {
  let score = 5; // baseline
  
  // Price: ideal entry is 50-70¢. Penalize >85¢ heavily
  if (price <= 0.50) score += 2;
  else if (price <= 0.65) score += 1.5;
  else if (price <= 0.75) score += 1;
  else if (price <= 0.82) score += 0.5;
  else if (price <= 0.85) score += 0;
  else if (price <= 0.90) score -= 1;
  else score -= 2;

  // Time: shorter = higher capital velocity
  const hrs = hoursToResolution ? parseFloat(hoursToResolution) : null;
  if (hrs && hrs <= 6) score += 1.5;
  else if (hrs && hrs <= 24) score += 1;
  else if (hrs && hrs <= 48) score += 0.5;
  else if (hrs && hrs > 168) score -= 1; // >7 days

  // Edge: higher = better
  const edgeNum = edge ? parseFloat(String(edge).replace("%", "")) / 100 : null;
  if (edgeNum && edgeNum > 0.30) score += 1.5;
  else if (edgeNum && edgeNum > 0.15) score += 1;
  else if (edgeNum && edgeNum > 0.05) score += 0.5;

  return Math.max(1, Math.min(10, Math.round(score)));
}

function loadAllTheses() {
  try {
    return fs.readdirSync(THESES_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(THESES_DIR, f), "utf8")); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// === FEATURE 4: OPPORTUNITY ALERT ===
function sendTelegramAlert(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  const https = require("https");
  const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_notification: false });
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${botToken}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
  }, () => {});
  req.on("error", () => {});
  req.write(payload);
  req.end();
}

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
        liquidBalance: data.portfolio.cashBalance || data.portfolio.liquidBalance || 0,
        totalValue: data.portfolio.portfolioValue || (data.portfolio.positionValue + (data.portfolio.cashBalance || data.portfolio.liquidBalance || 0)),
        source: "ws-feed"
      };
    }
  } catch (e) { /* ws-feed unavailable, fallback */ }

  // Fallback: get on-chain balance + position cost basis (with RPC fallback)
  try {
    const { ethers } = require("ethers");
    const provider = await getPolygonProvider();
    const usdc = new ethers.Contract(USDC_E_ADDR, ERC20_ABI, provider);
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
async function preTradeRiskCheck(tokenID, price, size, side, force = false, opts = {}) {
  // Only validate BUY orders (SELL is always allowed — exiting risk)
  if (side === "SELL") return { allowed: true, reason: "sell_always_allowed" };

  // === TRADING HALT: Master kill switch ===
  if (TRADING_HALTED) {
    console.log(`🛑 TRADING HALTED: BUY ${size} @ ${price} on ${tokenID.slice(0, 20)}... REJECTED (master halt active)`);
    return {
      allowed: false,
      blocked: true,
      reason: "trading_halted",
      checks: [{ check: "TRADING_HALT", status: "BLOCKED", detail: "All new BUY orders halted by operator. Use POST /trading-halt {enabled:false} to resume." }],
    };
  }

  const orderValue = price * size;
  const portfolio = await getPortfolioValue();
  const totalValue = portfolio.totalValue;

  // If portfolio is unknown/zero, use a conservative floor
  const effectivePortfolio = totalValue > 10 ? totalValue : 500;
  
  const checks = [];
  let blocked = false;
  const strategy = opts.strategy || "unknown";
  const isAutoStrategy = ENTRY_EXEMPT_STRATEGIES.includes(strategy);

  // === CHECK 1: Single position size (15% max) ===
  const existing = await getExistingExposure(tokenID);
  const totalExposure = existing.costBasis + orderValue;
  const exposurePct = totalExposure / effectivePortfolio;
  
  // Feature 1: Calculate recommended max size
  const maxAllowedExposure = effectivePortfolio * RISK_MAX_SINGLE_POSITION_PCT;
  const maxOrderValue = Math.max(0, maxAllowedExposure - existing.costBasis);
  const maxShares = maxOrderValue > 0 ? Math.floor(maxOrderValue / price) : 0;
  
  if (exposurePct > RISK_MAX_SINGLE_POSITION_PCT) {
    blocked = true;
    checks.push({
      check: "MAX_SINGLE_POSITION",
      status: "BLOCKED",
      detail: `Total exposure $${totalExposure.toFixed(2)} = ${(exposurePct * 100).toFixed(1)}% of $${effectivePortfolio.toFixed(2)} portfolio (max ${RISK_MAX_SINGLE_POSITION_PCT * 100}%)`,
      existing: existing.costBasis > 0 ? `Already hold $${existing.costBasis.toFixed(2)} in this token` : null,
      recommended: { maxShares, maxOrderValue: maxOrderValue.toFixed(2) },
    });
  } else {
    checks.push({ check: "MAX_SINGLE_POSITION", status: "OK", pct: (exposurePct * 100).toFixed(1) + "%" });
  }

  // === CHECK 1.5: Correlated position exposure (15% max across same event) ===
  // Uses neg_risk_market_id (NegRisk multi-outcome) or market_slug (standalone) to group positions
  {
    try {
      let eventGroupId = null;
      const conditionId = opts.conditionId || null;
      
      if (conditionId) {
        eventGroupId = await getEventGroup(conditionId);
      }
      
      if (eventGroupId) {
        // Register this mapping for future lookups
        registerEventMapping(conditionId, eventGroupId);
        
        const correlated = await getCorrelatedExposure(eventGroupId, tokenID);
        const correlatedTotal = correlated.total + orderValue;
        const correlatedPct = correlatedTotal / effectivePortfolio;
        
        if (correlatedPct > RISK_MAX_CORRELATED_PCT) {
          blocked = true;
          checks.push({
            check: "CORRELATED_EXPOSURE",
            status: "BLOCKED",
            detail: `Combined exposure on event "${eventGroupId.slice(0,50)}": $${correlatedTotal.toFixed(2)} = ${(correlatedPct * 100).toFixed(1)}% of portfolio (max ${RISK_MAX_CORRELATED_PCT * 100}%). Existing correlated positions: ${correlated.positions.length}`,
            correlatedPositions: correlated.positions.map(p => ({ asset: p.asset_id.slice(0,20) + "...", costBasis: "$" + p.costBasis.toFixed(2), outcome: p.outcome })),
            thisOrder: `$${orderValue.toFixed(2)}`,
            recommended: { maxOrderValue: Math.max(0, effectivePortfolio * RISK_MAX_CORRELATED_PCT - correlated.total).toFixed(2) },
          });
        } else {
          checks.push({ check: "CORRELATED_EXPOSURE", status: "OK", pct: (correlatedPct * 100).toFixed(1) + "%", correlatedPositions: correlated.positions.length, eventGroup: eventGroupId.slice(0,50) });
        }
      } else if (conditionId) {
        checks.push({ check: "CORRELATED_EXPOSURE", status: "SKIPPED", detail: "Could not resolve event group for conditionId" });
      }
      // If no conditionId provided, skip silently (backward compat)
    } catch (e) {
      checks.push({ check: "CORRELATED_EXPOSURE", status: "SKIPPED", detail: `Error: ${e.message}` });
    }
  }

  // === CHECK 2: Total directional exposure (60% max for manual) ===
  if (!isAutoStrategy) {
    const totalDirectional = await getTotalDirectionalExposure();
    const newTotalDirectional = totalDirectional + orderValue;
    const directionalPct = newTotalDirectional / effectivePortfolio;
    
    if (directionalPct > RISK_MAX_TOTAL_DIRECTIONAL_PCT) {
      blocked = true;
      const headroom = Math.max(0, effectivePortfolio * RISK_MAX_TOTAL_DIRECTIONAL_PCT - totalDirectional);
      checks.push({
        check: "TOTAL_DIRECTIONAL",
        status: "BLOCKED",
        detail: `Total manual exposure would be $${newTotalDirectional.toFixed(2)} = ${(directionalPct * 100).toFixed(1)}% of portfolio (max ${RISK_MAX_TOTAL_DIRECTIONAL_PCT * 100}%)`,
        currentDirectional: `$${totalDirectional.toFixed(2)}`,
        headroom: `$${headroom.toFixed(2)}`,
      });
    } else {
      checks.push({ check: "TOTAL_DIRECTIONAL", status: "OK", pct: (directionalPct * 100).toFixed(1) + "%" });
    }
  }

  // === CHECK 3: Entry quality gate (no entries above 85¢ for long-horizon) ===
  if (!isAutoStrategy && price > ENTRY_MAX_PRICE_LONG_HORIZON) {
    const hoursToResolution = opts.hoursToResolution || null;
    if (hoursToResolution === null || hoursToResolution > 24) {
      blocked = true;
      checks.push({
        check: "ENTRY_QUALITY",
        status: "BLOCKED",
        detail: `Entry price ${price} exceeds ${ENTRY_MAX_PRICE_LONG_HORIZON} for market with ${hoursToResolution ? hoursToResolution.toFixed(0) + 'h' : 'unknown'} to resolution (min margin of safety violated). Winners enter at 62-82¢. Exception: provide hoursToResolution <= 24 to override.`,
      });
    } else {
      checks.push({ check: "ENTRY_QUALITY", status: "OK", detail: `Price ${price} > ${ENTRY_MAX_PRICE_LONG_HORIZON} but resolution in ${hoursToResolution.toFixed(0)}h (exempt)` });
    }
  } else if (!isAutoStrategy) {
    checks.push({ check: "ENTRY_QUALITY", status: "OK", price: price });
  }

  // === CHECK 3.5: Daily conviction budget (30% max new manual per day) ===
  if (!isAutoStrategy) {
    const budget = loadDailyBudget();
    const budgetLimit = effectivePortfolio * DAILY_CONVICTION_BUDGET_PCT;
    const newTotal = budget.deployed + orderValue;
    if (newTotal > budgetLimit) {
      blocked = true;
      const headroom = Math.max(0, budgetLimit - budget.deployed);
      checks.push({
        check: "DAILY_CONVICTION_BUDGET",
        status: "BLOCKED",
        detail: `Daily budget: $${budget.deployed.toFixed(2)} deployed + $${orderValue.toFixed(2)} = $${newTotal.toFixed(2)} exceeds $${budgetLimit.toFixed(2)} (30% of portfolio). Headroom: $${headroom.toFixed(2)}. Trades today: ${budget.trades.length}`,
        todaysTrades: budget.trades,
      });
    } else {
      checks.push({ check: "DAILY_CONVICTION_BUDGET", status: "OK", deployed: `$${budget.deployed.toFixed(2)}/$${budgetLimit.toFixed(2)}`, remaining: `$${(budgetLimit - budget.deployed - orderValue).toFixed(2)}` });
    }
  }

  // === CHECK 3.6: Lottery ticket ban (no entries < 5¢) ===
  // Rationale: <5¢ = <5% implied probability. Our scanners cannot predict these.
  // XRP +$10.37 and SOL $50-60 +$12.03 were LUCK, not edge. See LESSONS.md 2026-02-16.
  if (!isAutoStrategy && price < LOTTERY_MIN_PRICE) {
    blocked = true;
    checks.push({
      check: "LOTTERY_BAN",
      status: "BLOCKED",
      detail: `Entry price ${price.toFixed(4)} is below ${LOTTERY_MIN_PRICE} (${(LOTTERY_MIN_PRICE * 100).toFixed(0)}¢). Lottery tickets banned — our models lack precision for <5% probability events. Build a quantitative model first.`,
    });
  } else if (!isAutoStrategy) {
    checks.push({ check: "LOTTERY_BAN", status: "OK", price: price });
  }

  // === CHECK 3.7: Minimum order value ($2 floor) ===
  // Rationale: At $358 scale, sub-$2 trades are execution cycle waste.
  // 19 weather trades averaging $5.45 each proved that many small bad trades = death by a thousand cuts.
  if (!isAutoStrategy && orderValue < MIN_ORDER_VALUE) {
    blocked = true;
    checks.push({
      check: "MIN_ORDER_VALUE",
      status: "BLOCKED",
      detail: `Order value $${orderValue.toFixed(2)} is below minimum $${MIN_ORDER_VALUE.toFixed(2)}. At current scale, sub-$2 trades waste execution cycles. Size up or skip.`,
    });
  } else if (!isAutoStrategy) {
    checks.push({ check: "MIN_ORDER_VALUE", status: "OK", orderValue: "$" + orderValue.toFixed(2) });
  }

  // === CHECK 3.8: Thesis required (no thesis = no trade) ===
  // THE #1 meta-failure: scanner output treated as trade signal without verification.
  // $43 of $86 total realized losses trace to trades with ZERO independent research.
  // This gate forces: write a thesis (POST /thesis) BEFORE placing a BUY order.
  // Exception: if opts.thesis is provided inline (e.g., from /execute-opportunity fast path),
  // that satisfies the requirement — the caller already validated thesis presence.
  if (THESIS_REQUIRED && !isAutoStrategy) {
    const savedThesis = loadThesis(tokenID);
    const inlineThesis = opts.thesis || null; // Fast-path passes thesis inline
    if (!savedThesis && !inlineThesis) {
      blocked = true;
      checks.push({
        check: "THESIS_REQUIRED",
        status: "BLOCKED",
        detail: `No thesis found for token ${tokenID.slice(0, 20)}. Every trade must answer: "Why is the market wrong and I'm right?" Submit thesis via POST /thesis first, then retry order. Scanner output is RESEARCH INPUT, not a trade signal.`,
        howToFix: "POST /thesis with { tokenID, market, thesis, invalidationConditions, expectedResolution, catalyst }",
      });
    } else {
      const source = savedThesis ? "saved" : "inline";
      const thesisText = savedThesis?.thesis || inlineThesis;
      const ageHours = savedThesis ? Math.round((Date.now() - new Date(savedThesis.timestamp).getTime()) / 3600000) : 0;
      checks.push({ check: "THESIS_REQUIRED", status: "OK", source, thesis: thesisText?.slice(0, 80), ageHours });
    }
  }

  // === CHECK 4: Cash reserve (10% minimum) ===
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

  // === CHECK 5: Spread + Depth check (for non-trivial orders) ===
  let depthResult = null;
  if (orderValue > 2) {
    try {
      const book = await client.getOrderBook(tokenID);
      const bestBid = book.bids?.length > 0 ? parseFloat(book.bids[book.bids.length - 1].price) : null;
      // Sort asks ascending to ensure we get the best (lowest) ask
      const askPrices = (book.asks || []).map(a => parseFloat(a.price)).sort((a, b) => a - b);
      const bestAsk = askPrices.length > 0 ? askPrices[0] : null;
      
      if (bestBid && bestAsk) {
        const spread = (bestAsk - bestBid) / bestAsk;
        const isNegRisk = book.neg_risk === true;
        if (spread > RISK_MAX_SPREAD_PCT && !isNegRisk) {
          blocked = true;
          checks.push({
            check: "SPREAD",
            status: "BLOCKED",
            detail: `Spread ${(spread * 100).toFixed(1)}% (bid=${bestBid}, ask=${bestAsk}) exceeds max ${RISK_MAX_SPREAD_PCT * 100}%`,
          });
        } else if (spread > RISK_MAX_SPREAD_PCT && isNegRisk) {
          // NegRisk/bucket markets structurally have wide spreads — skip spread check, depth check still applies
          checks.push({ check: "SPREAD", status: "OK_NEGRISK", spread: (spread * 100).toFixed(1) + "%", bestBid, bestAsk, note: "NegRisk market — spread check skipped, depth required" });
        } else {
          checks.push({ check: "SPREAD", status: "OK", spread: (spread * 100).toFixed(1) + "%", bestBid, bestAsk });
        }
      }
      
      // Feature 5: Full depth check (same as ws-feed checkBookDepth)
      if (book.asks?.length > 0 && side === "BUY") {
        const asks = (book.asks || [])
          .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
          .sort((a, b) => a.price - b.price);
        
        const depthBestAsk = asks[0].price;
        const maxPrice = depthBestAsk * (1 + DEPTH_SLIPPAGE_TOL_MANUAL);
        let filled = 0, totalCost = 0;
        
        for (const level of asks) {
          if (level.price > maxPrice) break;
          const canTake = Math.min(level.size, size - filled);
          filled += canTake;
          totalCost += canTake * level.price;
          if (filled >= size) break;
        }
        
        const avgFillPrice = filled > 0 ? totalCost / filled : depthBestAsk;
        const slippagePct = ((avgFillPrice - depthBestAsk) / depthBestAsk * 100);
        
        depthResult = { bestAsk: depthBestAsk, avgFillPrice, slippagePct, fillableShares: Math.floor(filled), intendedShares: size };
        
        if (filled < size) {
          const availableSize = Math.floor(filled);
          if (availableSize < DEPTH_MIN_SHARES_MANUAL) {
            blocked = true;
            checks.push({
              check: "DEPTH",
              status: "BLOCKED",
              detail: `Only ${availableSize}sh fillable within 2% of best ask ${depthBestAsk} (need ${size}sh)`,
            });
          } else {
            checks.push({
              check: "DEPTH",
              status: "WARNING",
              detail: `Only ${availableSize}/${size}sh fillable within 2% of best ask ${depthBestAsk}. Consider reducing to ${availableSize}sh.`,
              avgFillPrice: avgFillPrice.toFixed(4),
              slippagePct: slippagePct.toFixed(2) + "%",
            });
          }
        } else if (slippagePct > 1) {
          checks.push({
            check: "DEPTH",
            status: "WARNING",
            detail: `${size}sh fillable but avg fill ${avgFillPrice.toFixed(4)} is ${slippagePct.toFixed(2)}% above best ask ${depthBestAsk}`,
          });
        } else {
          checks.push({ check: "DEPTH", status: "OK", avgFillPrice: avgFillPrice.toFixed(4), slippage: slippagePct.toFixed(2) + "%" });
        }
      }
    } catch (e) {
      checks.push({ check: "BOOK", status: "SKIP", detail: "Could not fetch order book: " + e.message });
    }
  }

  // === SIZING CALCULATOR: always return recommended size ===
  const sizingAdvice = {
    maxSharesSinglePosition: maxShares,
    maxOrderValue: maxOrderValue.toFixed(2),
    portfolioValue: effectivePortfolio.toFixed(2),
    liquidBalance: portfolio.liquidBalance.toFixed(2),
  };

  // force:true removed — no gate bypasses on live trades, ever.
  // If a gate blocks a legitimate trade, fix the gate logic.

  if (blocked) {
    console.log(`🚫 RISK GATE BLOCKED: ${checks.filter(c => c.status === "BLOCKED").map(c => c.detail).join(" | ")}`);
  }

  return {
    allowed: !blocked,
    reason: blocked ? "risk_check_failed" : "all_checks_passed",
    checks,
    sizing: sizingAdvice,
    depth: depthResult,
    portfolio: { total: effectivePortfolio, liquid: portfolio.liquidBalance, source: portfolio.source },
  };
}

// Feature 1: Calculate total directional exposure across all manual positions
async function getTotalDirectionalExposure() {
  try {
    // Use Polymarket data API as ground truth (not trade reconstruction which misses sells)
    const addr = "0xe693Ef449979E387C8B4B5071Af9e27a7742E18D";
    const positions = await new Promise((resolve, reject) => {
      const req = https.get(`https://data-api.polymarket.com/positions?user=${addr}&limit=200&sizeThreshold=0`, (res) => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req.on("error", reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    });

    // Strategy tags from ws-feed
    let strategyTags = {};
    try {
      const data = await new Promise((resolve, reject) => {
        const req = http.get("http://localhost:3003/prices", (res) => {
          let d = ""; res.on("data", c => d += c);
          res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        });
        req.on("error", reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
      });
      if (data.prices) {
        for (const [id, p] of Object.entries(data.prices)) {
          strategyTags[id] = p.strategy;
        }
      }
    } catch {}

    let total = 0;
    for (const pos of positions) {
      if (pos.resolved) continue; // skip resolved positions
      const shortId = (pos.proxyWalletAssetId || pos.asset_id || "").slice(0, 20);
      const strat = strategyTags[shortId] || "unknown";
      // Auto strategies (resolution/arb/weather) don't count toward directional cap
      const isAuto = strat === "resolution" || strat === "arb" || strat === "weather";
      if (!isAuto) {
        total += pos.initialValue || 0;
      }
    }
    console.log(`[directional] Data API: ${positions.length} positions, total directional: $${total.toFixed(2)}`);
    return total;
  } catch (e) {
    console.log(`getTotalDirectionalExposure error (data API): ${e.message}, falling back to trade cache`);
    // Fallback to old method if data API fails
    try {
      const cached = await getCachedPositions();
      let total = 0;
      for (const pos of cached.openPositions) {
        total += pos.totalCost;
      }
      return total;
    } catch (e2) {
      console.log(`getTotalDirectionalExposure fallback error: ${e2.message}`);
      return 0;
    }
  }
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
    const botDir = path.join(__dirname, "..");
    execFile("bash", [path.join(__dirname, "push-snapshot.sh")],
      { cwd: botDir, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) console.error("Snapshot push failed:", err.message);
        else console.log("📸 Snapshot pushed to GitHub");
      });
  }, 5000);
}

// === OPPORTUNITY VALIDATION ===
// Single validation gate for all trade entry paths (fast-path + queue)
// Rejects phantom markets, empty order books, illiquid tokens
const REJECTION_LOG_FILE = path.join(__dirname, "rejected-opportunities.json");

function loadRejectionLog() {
  try { return JSON.parse(fs.readFileSync(REJECTION_LOG_FILE, "utf8")); } catch(e) { return []; }
}

function logRejection(opportunity, reason, details = {}) {
  const log = loadRejectionLog();
  const entry = {
    timestamp: new Date().toISOString(),
    market: opportunity.market || opportunity.slug || "unknown",
    tokenID: opportunity.tokenID ? opportunity.tokenID.slice(0, 30) + "..." : null,
    slug: opportunity.slug || null,
    reason,
    ...details,
  };
  log.push(entry);
  // Keep last 200 rejections
  if (log.length > 200) log.splice(0, log.length - 200);
  writeFileAtomic(REJECTION_LOG_FILE, log);
  console.log(`🚫 OPPORTUNITY REJECTED: ${reason} — ${entry.market}`);
  return entry;
}

async function validateOpportunity(opportunity) {
  const { tokenID, slug, market } = opportunity;
  const label = market || slug || (tokenID ? tokenID.slice(0, 20) : "unknown");

  // 1. Must have a tokenID to trade
  if (!tokenID) {
    const rejection = logRejection(opportunity, "NO_TOKEN_ID", { detail: "No tokenID provided" });
    return { valid: false, reason: "NO_TOKEN_ID", rejection };
  }

  // 2. Check order book exists and has liquidity
  try {
    const book = await client.getOrderBook(tokenID);
    
    if (!book) {
      const rejection = logRejection(opportunity, "NO_ORDER_BOOK", { detail: "getOrderBook returned null" });
      return { valid: false, reason: "NO_ORDER_BOOK", rejection };
    }

    const asks = book.asks || [];
    const bids = book.bids || [];

    if (asks.length === 0 && bids.length === 0) {
      const rejection = logRejection(opportunity, "EMPTY_ORDER_BOOK", { detail: "No bids or asks" });
      return { valid: false, reason: "EMPTY_ORDER_BOOK", rejection };
    }

    // Check minimum liquidity — at least $5 on ask side for buys
    const side = (opportunity.side || "BUY").toUpperCase();
    const relevantSide = side === "BUY" ? asks : bids;
    
    if (relevantSide.length === 0) {
      const rejection = logRejection(opportunity, "NO_LIQUIDITY", { 
        detail: `No ${side === "BUY" ? "asks" : "bids"} in book`,
        bids: bids.length,
        asks: asks.length,
      });
      return { valid: false, reason: "NO_LIQUIDITY", rejection };
    }

    // Calculate total available depth on relevant side
    const totalDepth = relevantSide.reduce((sum, level) => sum + parseFloat(level.size || 0) * parseFloat(level.price || 0), 0);
    
    if (totalDepth < 5) {
      const rejection = logRejection(opportunity, "INSUFFICIENT_DEPTH", { 
        detail: `Only $${totalDepth.toFixed(2)} depth on ${side === "BUY" ? "ask" : "bid"} side (min $5)`,
        totalDepth: totalDepth.toFixed(2),
        levels: relevantSide.length,
      });
      return { valid: false, reason: "INSUFFICIENT_DEPTH", rejection };
    }

    // Passed all checks
    console.log(`✅ OPPORTUNITY VALIDATED: ${label} — ${relevantSide.length} levels, $${totalDepth.toFixed(2)} depth`);
    return { valid: true, depth: totalDepth, levels: relevantSide.length };

  } catch (e) {
    // If getOrderBook throws, the market likely doesn't exist
    const isNotFound = e.message && (e.message.includes("404") || e.message.includes("not found") || e.message.includes("Not Found"));
    const reason = isNotFound ? "MARKET_NOT_FOUND" : "ORDER_BOOK_ERROR";
    const rejection = logRejection(opportunity, reason, { 
      detail: e.message,
      httpStatus: e.status || e.statusCode || null,
    });
    return { valid: false, reason, rejection };
  }
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
      else {
        // On sell, reduce totalCost by avg cost basis (not sell price)
        // This prevents avgPrice from going negative or exceeding 1.0
        const p = posMap[key];
        const avgCost = p.size > 0 ? p.totalCost / p.size : px;
        p.size -= qty;
        p.totalCost -= qty * avgCost;
        if (p.size < 0.001) { p.size = 0; p.totalCost = 0; }
      }
      posMap[key].trades.push(t);
    } else if (t.trader_side === "MAKER" && t.maker_orders) {
      for (const mo of t.maker_orders) {
        if (mo.maker_address && mo.maker_address.toLowerCase() === OUR_ADDR) {
          const key = mo.asset_id;
          if (!posMap[key]) posMap[key] = { asset_id: key, market: t.market, outcome: mo.outcome, size: 0, totalCost: 0, trades: [] };
          const qty = parseFloat(mo.matched_amount);
          const px = parseFloat(mo.price);
          if (mo.side === "BUY") { posMap[key].size += qty; posMap[key].totalCost += qty * px; }
          else {
            const p = posMap[key];
            const avgCost = p.size > 0 ? p.totalCost / p.size : px;
            p.size -= qty;
            p.totalCost -= qty * avgCost;
            if (p.size < 0.001) { p.size = 0; p.totalCost = 0; }
          }
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

    // GET /balance — on-chain USDC balance (with RPC fallback)
    if (method === "GET" && path === "/balance") {
      try {
        const { ethers } = require("ethers");
        const provider = await getPolygonProvider();
        const usdc = new ethers.Contract(USDC_E_ADDR, ERC20_ABI, provider);
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
        // PRIMARY: Polymarket data API (ground truth — actual on-chain positions)
        try {
          const dataPositions = await getDataApiPositions();
          const resolved = loadResolved();
          const positions = dataPositions
            .filter(p => p.size > 0.001 && !p.redeemable && !resolved[p.asset])
            .map(p => ({
              asset_id: p.asset,
              market: p.conditionId || p.slug,
              outcome: p.outcome,
              size: p.size,
              totalCost: p.initialValue || (p.size * p.avgPrice),
              avgPrice: String(p.avgPrice),
              _title: p.title,
              _slug: p.slug,
              _curPrice: p.curPrice,
              _currentValue: p.currentValue,
              _cashPnl: p.cashPnl,
              _source: "data-api",
            }));
          return send(res, 200, { positions, source: "data-api", count: positions.length });
        } catch (e) {
          console.log(`[positions] Data API failed (${e.message}), falling back to trade cache`);
        }
        // FALLBACK: Trade history reconstruction (known to create phantoms — last resort only)
        const cached = await getCachedPositions();
        const resolved = loadResolved();
        const filtered = cached.openPositions.filter(p => !resolved[p.asset_id]);
        return send(res, 200, { positions: filtered, source: "trade-cache-FALLBACK", count: filtered.length });
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

        // Load resolved positions to detect market resolutions (no sell on CLOB)
        const resolvedData = loadResolved();

        for (const p of Object.values(posMap)) {
          const avgBuyPrice = p.buys.length > 0 ? p.totalBuyCost / p.buys.reduce((s, b) => s + b.size, 0) : 0;
          const totalBought = p.buys.reduce((s, b) => s + b.size, 0);
          const totalSold = p.sells.reduce((s, b) => s + b.size, 0);
          const tradePnl = p.totalSellProceeds - (totalSold * avgBuyPrice);

          if (p.size > 0.01) {
            // Check if this "open" position actually resolved (payout bypasses CLOB)
            const resolution = resolvedData[p.asset_id];
            if (resolution) {
              // Market resolved — record as closed with resolution P&L
              const payout = resolution.won ? p.size * 1.0 : 0;
              const resolutionPnl = payout - (p.size * avgBuyPrice) + tradePnl;
              closedPositions.push({
                asset_id: p.asset_id,
                market: resolution.market || p.market,
                outcome: p.outcome,
                totalBought,
                totalSold: totalSold + p.size, // All shares "sold" via resolution
                avgBuyPrice: avgBuyPrice.toFixed(4),
                avgSellPrice: resolution.won ? "1.0000" : "0.0000",
                totalCost: p.totalBuyCost.toFixed(2),
                totalProceeds: (p.totalSellProceeds + payout).toFixed(2),
                realizedPnl: resolutionPnl.toFixed(2),
                realizedPnlPct: p.totalBuyCost > 0 ? ((resolutionPnl / p.totalBuyCost) * 100).toFixed(1) : "0",
                status: resolution.won ? "RESOLVED_WON" : "RESOLVED_LOST",
                resolvedAt: resolution.resolvedAt,
                firstBuy: p.buys[0]?.time,
                lastTrade: resolution.resolvedAt,
              });
              totalRealizedPnl += resolutionPnl;
            } else {
              openPositions.push({
                asset_id: p.asset_id,
                market: p.market,
                outcome: p.outcome,
                size: Math.round(p.size * 100) / 100,
                avgPrice: avgBuyPrice.toFixed(4),
                costBasis: (p.size * avgBuyPrice).toFixed(2),
                totalBought,
                totalSold,
                realizedPnl: tradePnl.toFixed(2),
                status: "OPEN",
                firstBuy: p.buys[0]?.time,
                lastTrade: [...p.buys, ...p.sells].sort((a, b) => new Date(b.time) - new Date(a.time))[0]?.time,
              });
            }
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
              realizedPnl: tradePnl.toFixed(2),
              realizedPnlPct: p.totalBuyCost > 0 ? ((tradePnl / p.totalBuyCost) * 100).toFixed(1) : "0",
              status: "CLOSED",
              firstBuy: p.buys[0]?.time,
              lastTrade: [...p.buys, ...p.sells].sort((a, b) => new Date(b.time) - new Date(a.time))[0]?.time,
            };
            closedPositions.push(closed);
            totalRealizedPnl += tradePnl;
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
      if (path === "/position-ledger") {
        const positions = positionLedger.getPositions();
        const txLog = positionLedger.getTxLog(parseInt(query.limit) || 50);
        return send(res, 200, { positions, txLog, count: positions.length });
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
      if (path === "/reconcile") {
        try {
          const result = await reconcilePositions();
          return send(res, 200, result);
        } catch(e) {
          return send(res, 500, { error: e.message });
        }
      }

      // GET /exit-ledger — full exit log with optional filters
      if (path === "/exit-ledger") {
        const since = query.since;  // ISO date string
        const reason = query.reason;
        const limit = query.limit ? parseInt(query.limit) : undefined;
        
        if (query.summary === "true") {
          return send(res, 200, getExitSummary(since));
        }
        
        const exits = getExits({ since, reason, limit });
        return send(res, 200, { count: exits.length, exits });
      }

      if (path === "/check-resolutions") {
        try {
          const result = await checkResolutions();
          // Auto-redeem resolved positions on-chain (non-blocking)
          autoRedeem().then(r => {
            if (r.redeemed > 0) console.log(`[REDEEM] Auto-redeemed ${r.redeemed} positions, $${r.totalValue?.toFixed(2)} recovered`);
          }).catch(e => console.log(`[REDEEM] Auto-redeem error: ${e.message?.slice(0, 100)}`));
          return send(res, 200, result);
        } catch(e) {
          return send(res, 500, { error: e.message });
        }
      }

      if (path === "/redeem") {
        try {
          const result = await autoRedeem();
          return send(res, 200, result);
        } catch(e) {
          return send(res, 500, { error: e.message });
        }
      }

      if (path === "/trade-history") {
        // Fetch full trade history from Polymarket data-api
        // This includes all trades with market names, used for accurate P&L calculation
        const https = require("https");
        const addr = OUR_ADDR || "0xe693Ef449979E387C8B4B5071Af9e27a7742E18D".toLowerCase();
        
        try {
          const trades = await new Promise((resolve, reject) => {
            const url = `https://data-api.polymarket.com/activity?user=${addr}&limit=500&type=TRADE`;
            https.get(url, (res) => {
              let data = "";
              res.on("data", c => data += c);
              res.on("end", () => {
                try {
                  resolve(JSON.parse(data));
                } catch(e) {
                  reject(e);
                }
              });
            }).on("error", reject);
          });

          if (!Array.isArray(trades)) {
            return send(res, 500, { error: "Unexpected data-api response" });
          }

          // Calculate P&L by position
          const positions = {};
          for (const t of trades) {
            const key = t.asset || t.conditionId;
            if (!positions[key]) {
              positions[key] = {
                asset_id: key,
                conditionId: t.conditionId,
                market: t.title || t.slug || "Unknown",
                outcome: t.outcome || "Yes",
                buys: [],
                sells: [],
                totalBought: 0,
                totalSold: 0,
                totalBuyCost: 0,
                totalSellProceeds: 0,
              };
            }
            const p = positions[key];
            const size = parseFloat(t.size || 0);
            const price = parseFloat(t.price || 0);
            
            if (t.side === "BUY") {
              p.buys.push({ size, price, time: new Date(t.timestamp * 1000).toISOString() });
              p.totalBought += size;
              p.totalBuyCost += size * price;
            } else if (t.side === "SELL") {
              p.sells.push({ size, price, time: new Date(t.timestamp * 1000).toISOString() });
              p.totalSold += size;
              p.totalSellProceeds += size * price;
            }
          }

          // Calculate realized and unrealized P&L
          let totalRealizedPnl = 0;
          const openPositions = [];
          const closedPositions = [];

          for (const p of Object.values(positions)) {
            const remaining = p.totalBought - p.totalSold;
            const avgBuyPrice = p.totalBought > 0 ? p.totalBuyCost / p.totalBought : 0;
            const avgSellPrice = p.totalSold > 0 ? p.totalSellProceeds / p.totalSold : 0;
            const tradePnl = p.totalSellProceeds - (p.totalSold * avgBuyPrice);

            if (remaining > 0.01) {
              // Open position
              openPositions.push({
                asset_id: p.asset_id,
                market: p.market,
                outcome: p.outcome,
                size: Math.round(remaining * 100) / 100,
                avgPrice: avgBuyPrice.toFixed(4),
                costBasis: (remaining * avgBuyPrice).toFixed(2),
                totalBought: p.totalBought,
                totalSold: p.totalSold,
                realizedPnl: tradePnl.toFixed(2),
                status: "OPEN",
              });
            } else {
              // Closed position
              closedPositions.push({
                asset_id: p.asset_id,
                market: p.market,
                outcome: p.outcome,
                totalBought: p.totalBought,
                totalSold: p.totalSold,
                avgBuyPrice: avgBuyPrice.toFixed(4),
                avgSellPrice: avgSellPrice.toFixed(4),
                totalCost: p.totalBuyCost.toFixed(2),
                totalProceeds: p.totalSellProceeds.toFixed(2),
                realizedPnl: tradePnl.toFixed(2),
                realizedPnlPct: p.totalBuyCost > 0 ? ((tradePnl / p.totalBuyCost) * 100).toFixed(1) : "0",
                status: "CLOSED",
              });
              totalRealizedPnl += tradePnl;
            }
          }

          return send(res, 200, {
            timestamp: new Date().toISOString(),
            totalTrades: trades.length,
            openPositions,
            closedPositions,
            totalRealizedPnl: totalRealizedPnl.toFixed(2),
            source: "data-api",
          });
        } catch(e) {
          return send(res, 500, { error: e.message });
        }
      }

      if (path === "/risk-check") {
        const tokenID = query.token_id;
        const price = parseFloat(query.price || "0");
        const size = parseFloat(query.size || "0");
        const side = query.side || "BUY";
        if (!tokenID || !price || !size) return send(res, 400, { error: "Need token_id, price, size params" });
        const riskOpts = {
          strategy: query.strategy || "unknown",
          hoursToResolution: query.hours_to_resolution ? parseFloat(query.hours_to_resolution) : null,
          conditionId: query.condition_id || null,
          slug: query.slug || null,
        };
        const result = await preTradeRiskCheck(tokenID, price, size, side, false, riskOpts);
        return send(res, 200, result);
      }
      // GET /daily-budget — current daily conviction budget status
      if (path === "/daily-budget") {
        const budget = loadDailyBudget();
        const portfolio = await getPortfolioValue();
        const eff = portfolio.totalValue > 10 ? portfolio.totalValue : 500;
        const limit = eff * DAILY_CONVICTION_BUDGET_PCT;
        return send(res, 200, {
          date: budget.date,
          deployed: budget.deployed,
          limit: parseFloat(limit.toFixed(2)),
          remaining: parseFloat(Math.max(0, limit - budget.deployed).toFixed(2)),
          pctUsed: ((budget.deployed / limit) * 100).toFixed(1) + "%",
          trades: budget.trades,
          portfolioValue: eff.toFixed(2),
        });
      }
      // GET /theses — list all active theses
      if (path === "/theses") {
        return send(res, 200, { theses: loadAllTheses() });
      }
      // GET /thesis?token_id=XXX — get thesis for a specific position
      if (path === "/thesis") {
        const t = loadThesis(query.token_id || "");
        return send(res, 200, t || { error: "No thesis found" });
      }
      // GET /sizing?price=X&conviction=1|2|3 — position sizing calculator
      if (path === "/sizing") {
        const p = parseFloat(query.price || "0");
        const conviction = parseInt(query.conviction || "2"); // 1=low, 2=med, 3=high
        if (!p || p <= 0) return send(res, 400, { error: "Need price param" });
        const portfolio = await getPortfolioValue();
        const eff = portfolio.totalValue > 10 ? portfolio.totalValue : 500;
        // Conviction scaling: low=5%, med=10%, high=15% of portfolio
        const convictionPct = [0.05, 0.10, 0.15][Math.min(Math.max(conviction, 1), 3) - 1];
        const maxByConviction = eff * convictionPct;
        const maxBySingleCap = eff * RISK_MAX_SINGLE_POSITION_PCT;
        const maxAlloc = Math.min(maxByConviction, maxBySingleCap);
        const maxShares = Math.floor(maxAlloc / p);
        const totalDirectional = await getTotalDirectionalExposure();
        const directionalHeadroom = Math.max(0, eff * RISK_MAX_TOTAL_DIRECTIONAL_PCT - totalDirectional);
        const maxByDirectional = Math.floor(directionalHeadroom / p);
        const finalMax = Math.min(maxShares, maxByDirectional);
        return send(res, 200, {
          price: p,
          conviction,
          convictionLabel: ["low", "medium", "high"][conviction - 1],
          portfolioValue: eff.toFixed(2),
          maxSharesByConviction: maxShares,
          maxSharesByDirectionalCap: maxByDirectional,
          recommendedShares: finalMax,
          recommendedCost: (finalMax * p).toFixed(2),
          pctOfPortfolio: ((finalMax * p) / eff * 100).toFixed(1) + "%",
          totalDirectionalExposure: totalDirectional.toFixed(2),
          directionalHeadroom: directionalHeadroom.toFixed(2),
          entryQualityGate: p > ENTRY_MAX_PRICE_LONG_HORIZON ? "⚠️ Price above 85¢ — need hoursToResolution < 24 to pass entry gate" : "✅ OK",
          dailyBudget: (() => { const b = loadDailyBudget(); const lim = eff * DAILY_CONVICTION_BUDGET_PCT; return { deployed: b.deployed.toFixed(2), limit: lim.toFixed(2), remaining: Math.max(0, lim - b.deployed).toFixed(2), tradesCount: b.trades.length }; })(),
          entryQualityScore: computeEntryQuality(p, parseFloat(query.hoursToResolution || "0") || null, query.edge || null),
        });
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

    // POST /trading-halt — toggle master trading halt
    if (method === "POST" && path === "/trading-halt") {
      const body = await parseBody(req);
      const enabled = body.enabled;
      if (typeof enabled !== "boolean") {
        return send(res, 400, { error: "Required: { enabled: true|false }" });
      }
      const prev = TRADING_HALTED;
      TRADING_HALTED = enabled;
      console.log(`${enabled ? "🛑" : "✅"} TRADING HALT ${enabled ? "ENABLED" : "DISABLED"} (was: ${prev})`);
      return send(res, 200, { tradingHalted: TRADING_HALTED, previous: prev });
    }

    // GET /trading-halt — check halt status
    if (method === "GET" && path === "/trading-halt") {
      return send(res, 200, { tradingHalted: TRADING_HALTED });
    }

    // POST /thesis — save a structured thesis for a position
    if (method === "POST" && path === "/thesis") {
      const body = await parseBody(req);
      const { tokenID, market, entryPrice, thesis, invalidationConditions, expectedResolution, catalyst } = body;
      if (!tokenID || !market || !thesis) {
        return send(res, 400, { error: "Need tokenID, market, thesis" });
      }
      const thesisObj = {
        tokenID,
        market,
        entryPrice: entryPrice || null,
        thesis,
        invalidationConditions: invalidationConditions || [],
        expectedResolution: expectedResolution || null,
        catalyst: catalyst || null,
        createdAt: new Date().toISOString(),
        status: "active",
      };
      saveThesis(tokenID, thesisObj);
      return send(res, 200, { ok: true, thesis: thesisObj });
    }

    // POST /opportunity-alert — high-conviction opportunity alert to Telegram
    if (method === "POST" && path === "/opportunity-alert") {
      const body = await parseBody(req);
      const { market, edge, resolution, price, thesis, slug } = body;
      if (!market) return send(res, 400, { error: "Need market" });
      const msg = [
        `🎯 <b>HIGH-CONVICTION OPPORTUNITY</b>`,
        ``,
        `<b>Market:</b> ${market}`,
        edge ? `<b>Edge:</b> ${edge}` : null,
        resolution ? `<b>Resolution:</b> ${resolution}` : null,
        price ? `<b>Current price:</b> ${price}` : null,
        thesis ? `\n<b>Thesis:</b> ${thesis}` : null,
        slug ? `\n🔗 polymarket.com/event/${slug}` : null,
        `\n⚡ Reply to approve for next execution window`,
      ].filter(Boolean).join("\n");
      sendTelegramAlert(msg);
      console.log(`📢 Opportunity alert sent: ${market}`);
      return send(res, 200, { ok: true, alertSent: true });
    }

    // GET /rejected-opportunities — view rejection log
    if (method === "GET" && path === "/rejected-opportunities") {
      const log = loadRejectionLog();
      const byReason = {};
      log.forEach(r => { byReason[r.reason] = (byReason[r.reason] || 0) + 1; });
      return send(res, 200, { 
        total: log.length, 
        byReason, 
        recent: log.slice(-20),
      });
    }

    // POST /validate-opportunity — standalone validation check (for crons to call before queuing)
    if (method === "POST" && path === "/validate-opportunity") {
      const body = await parseBody(req);
      const result = await validateOpportunity(body);
      return send(res, result.valid ? 200 : 404, result);
    }

    // POST /execute-opportunity — fast-path: validate all gates + execute in one call
    // Used by scanner crons for immediate execution of high-conviction opportunities
    if (method === "POST" && path === "/execute-opportunity") {
      const body = await parseBody(req);
      const { tokenID, price, size, side, market, thesis, invalidation, hoursToResolution, edge, slug } = body;
      
      if (!tokenID || !price || !size || !side) {
        return send(res, 400, { error: "Missing tokenID, price, size, or side" });
      }
      if (!thesis) {
        return send(res, 400, { error: "Thesis required for directional trades" });
      }

      // ── STRATEGY ALLOWLIST GATE ──
      // Only validated strategies can execute. To promote a strategy from paper → live,
      // add it to this list. Prevents cron sessions from trading unvalidated signals.
      const LIVE_STRATEGIES = ["event-scanner", "manual", "resolution"];
      const strategy = body.strategy || "unknown";
      if (!LIVE_STRATEGIES.includes(strategy)) {
        console.log(`🚫 STRATEGY BLOCKED: "${strategy}" is not in LIVE_STRATEGIES [${LIVE_STRATEGIES.join(", ")}] — ${market || tokenID.slice(0, 20)}`);
        sendTelegramAlert(
          `🚫 <b>STRATEGY BLOCKED</b>\n\n` +
          `<b>Market:</b> ${market || tokenID.slice(0, 20)}\n` +
          `<b>Strategy:</b> ${strategy}\n` +
          `<b>Allowed:</b> ${LIVE_STRATEGIES.join(", ")}\n` +
          `<b>Action:</b> Add "${strategy}" to LIVE_STRATEGIES in executor to enable`
        );
        return send(res, 403, { error: `Strategy "${strategy}" not in LIVE_STRATEGIES allowlist`, allowedStrategies: LIVE_STRATEGIES });
      }

      console.log(`⚡ FAST-PATH EXECUTION: ${market || tokenID.slice(0, 20)} [strategy: ${strategy}]`);

      // Step 0: Validate market exists with liquidity
      const validation = await validateOpportunity({ tokenID, slug, market, side });
      if (!validation.valid) {
        console.log(`🚫 FAST-PATH REJECTED: ${validation.reason} — ${market || tokenID.slice(0, 20)}`);
        sendTelegramAlert(
          `🚫 <b>OPPORTUNITY REJECTED</b>\n\n` +
          `<b>Market:</b> ${market || slug || tokenID.slice(0, 20)}\n` +
          `<b>Reason:</b> ${validation.reason}\n` +
          `<b>Detail:</b> ${validation.rejection?.detail || "N/A"}\n` +
          `<b>Edge:</b> ${edge || "?"}`
        );
        return send(res, 404, { error: `Market validation failed: ${validation.reason}`, validation });
      }

      // Step 1: Run all risk gates
      const riskOpts = {
        strategy: body.strategy || "directional",
        hoursToResolution: hoursToResolution != null ? parseFloat(hoursToResolution) : null,
        conditionId: body.conditionId || null,
        slug: slug || null,
        thesis: thesis, // Pass inline thesis so THESIS_REQUIRED gate accepts it
      };
      const riskResult = await preTradeRiskCheck(tokenID, parseFloat(price), parseFloat(size), side, false, riskOpts);
      
      if (!riskResult.allowed) {
        console.log(`🚫 FAST-PATH BLOCKED: ${riskResult.checks.filter(c => c.status === "BLOCKED").map(c => c.check).join(", ")}`);
        // Still send Telegram about the blocked opportunity
        sendTelegramAlert(
          `🚫 <b>OPPORTUNITY BLOCKED</b>\n\n` +
          `<b>Market:</b> ${market || tokenID.slice(0, 20)}\n` +
          `<b>Edge:</b> ${edge || "?"}\n` +
          `<b>Blocked by:</b> ${riskResult.checks.filter(c => c.status === "BLOCKED").map(c => c.check).join(", ")}\n` +
          `<b>Thesis:</b> ${thesis}`
        );
        return send(res, 422, { error: "Blocked by risk gates", riskResult });
      }

      // Step 2: Save thesis
      const thesisObj = {
        market: market || tokenID.slice(0, 20),
        tokenID,
        side,
        entryPrice: parseFloat(price),
        size: parseFloat(size),
        thesis,
        invalidation: invalidation || "N/A",
        hoursToResolution: hoursToResolution || null,
        edge: edge || null,
        slug: slug || null,
        entryTime: new Date().toISOString(),
        entryQualityScore: computeEntryQuality(parseFloat(price), hoursToResolution, edge),
        status: "OPEN",
      };
      saveThesis(tokenID, thesisObj);

      // Step 3: Execute
      const orderOpts = {
        tokenID,
        price: parseFloat(price),
        size: parseFloat(size),
        side: side === "BUY" ? Side.BUY : Side.SELL,
      };
      
      const walId = logIntent({ type: "buy", tokenID, price: parseFloat(price), size: parseFloat(size), side, strategy: "fast-path", source: "executor", meta: { market } });
      try {
        const order = await client.createAndPostOrder(orderOpts, undefined, "GTC");
        resolveIntent(walId, "filled", { orderID: order.orderID || order.id });
        invalidateTradeCache();
        triggerSnapshotPush();

        // Record to position ledger
        if (side === "BUY") {
          positionLedger.recordEntry({ assetId: tokenID, market, outcome: body.outcome, size: parseFloat(size), avgPrice: parseFloat(price), strategy: "fast-path", source: "executor" });
        }

        // Record daily budget + event mapping
        if (side === "BUY") {
          recordDailyBudgetSpend(parseFloat(price) * parseFloat(size), market || tokenID.slice(0, 20));
          // Register event mapping for correlation checker
          // Event mapping registered lazily by risk check's getEventGroup()
        }

        // Telegram notification
        sendTelegramAlert(
          `⚡ <b>FAST-PATH TRADE EXECUTED</b>\n\n` +
          `<b>${side}</b> ${size}sh @ $${parseFloat(price).toFixed(2)}\n` +
          `<b>Market:</b> ${market || tokenID.slice(0, 20)}\n` +
          `<b>Edge:</b> ${edge || "?"}\n` +
          `<b>Thesis:</b> ${thesis}\n` +
          `<b>Invalidation:</b> ${invalidation || "N/A"}\n` +
          `<b>Entry quality:</b> ${thesisObj.entryQualityScore}/10\n` +
          (slug ? `\n🔗 polymarket.com/event/${slug}` : "")
        );

        console.log(`⚡ FAST-PATH SUCCESS: ${order.orderID || order.id}`);
        return send(res, 200, { order, thesis: thesisObj, riskResult });
      } catch (e) {
        resolveIntent(walId, "failed", { error: e.message });
        console.error(`⚡ FAST-PATH ORDER FAILED: ${e.message}`);
        return send(res, 500, { error: e.message, thesis: thesisObj, riskResult });
      }
    }

    // POST /market-buy — FAK market buy (fill what's available, cancel rest)
    // Clean entry point for weather-v2 live trading. No risk gates, no thesis files.
    // Body: { tokenID, amount (dollars to spend), market (label) }
    if (method === "POST" && path === "/market-buy") {
      const body = await parseBody(req);
      const { tokenID, amount, market } = body;
      
      if (!tokenID || !amount) {
        return send(res, 400, { error: "Missing tokenID or amount" });
      }

      const dollarAmount = parseFloat(amount);
      if (dollarAmount < 1 || dollarAmount > 100) {
        return send(res, 400, { error: `Amount $${dollarAmount} out of bounds (min $1, max $100)` });
      }

      console.log(`🌤️ WEATHER MARKET BUY: $${dollarAmount} on ${market || tokenID.slice(0, 20)}`);

      try {
        const order = await client.createAndPostMarketOrder(
          { tokenID, amount: dollarAmount, side: Side.BUY },
          undefined, // options (auto-resolves tick size + neg risk)
          "FAK",     // Fill-And-Kill: fill what's available, cancel rest
        );

        const status = (order.status || order.orderStatus || "").toLowerCase();
        const filled = status === "matched" || status === "filled";
        console.log(`   ${filled ? '✅' : '⚠️'} Order ${order.orderID || order.id}: ${status} | $${dollarAmount} on ${market || ''}`);

        return send(res, 200, {
          success: true,
          orderID: order.orderID || order.id,
          status: status,
          filled,
          amount: dollarAmount,
          market: market || tokenID.slice(0, 20),
          raw: order,
        });
      } catch (e) {
        console.log(`   ❌ MARKET BUY FAILED: ${e.message}`);
        return send(res, 500, { error: e.message, market });
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
      // skipRiskCheck:true for internal auto-execution paths (ws-feed) that have their own risk checks.
      // force:true removed — fix gate logic instead of bypassing gates.
      const skipRisk = body.skipRiskCheck === true;
      
      if (!skipRisk) {
        const riskOpts = {
          strategy: body.strategy || "unknown",
          hoursToResolution: body.hoursToResolution != null ? parseFloat(body.hoursToResolution) : null,
          conditionId: body.conditionId || null,
          slug: body.slug || null,
        };
        const riskResult = await preTradeRiskCheck(tokenID, parseFloat(price), parseFloat(size), side, false, riskOpts);
        if (!riskResult.allowed) {
          console.log(`🚫 ORDER REJECTED by risk gate: ${side} ${size} @ ${price}`);
          return send(res, 422, {
            error: "Order rejected by pre-trade risk check",
            riskResult,
            hint: "Fix the gate logic if this is a legitimate trade, or reduce position size",
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

      const walId = logIntent({ type: side.toLowerCase(), tokenID, price: parseFloat(price), size: parseFloat(size), side, strategy: body.strategy || "manual", source: "executor", meta: { market: body.market } });
      let order;
      try {
        order = await client.createAndPostOrder(orderOpts, undefined, orderType, false, postOnly);
      } catch (e) {
        resolveIntent(walId, "failed", { error: e.message });
        throw e;
      }

      // Check fill status before resolving WAL intent
      const orderStatusField = order.status || order.orderStatus || order.order_status || "";
      const orderStatusStr = typeof orderStatusField === "string" ? orderStatusField.toLowerCase() : String(orderStatusField).toLowerCase();
      const orderIsFilled = orderStatusStr === "matched" || orderStatusStr === "filled" ||
        (order.takingAmount && order.takingAmount !== "" && order.takingAmount !== "0");
      resolveIntent(walId, orderIsFilled ? "filled" : "posted", { orderID: order.orderID || order.id });

      // Ledger writes in try/catch — failures must not prevent the HTTP response
      try {
        invalidateTradeCache();
        triggerSnapshotPush();

        // Record to position ledger
        if (side === "BUY") {
          positionLedger.recordEntry({ assetId: tokenID, market: body.market, outcome: body.outcome, size: parseFloat(size), avgPrice: parseFloat(price), strategy: body.strategy || "manual", source: "executor" });
        } else {
          positionLedger.recordExit({ assetId: tokenID, size: parseFloat(size), reason: "manual_sell", source: "executor" });
        }
      } catch (ledgerErr) {
        console.log(`⚠️ ORDER: Ledger write failed (non-fatal): ${ledgerErr.message}`);
      }

      console.log(`Order result:`, JSON.stringify(order));

      // Record daily budget spend for manual strategies
      const orderStrategy = body.strategy || "unknown";
      if (!ENTRY_EXEMPT_STRATEGIES.includes(orderStrategy) && side === "BUY") {
        const marketName = body.market || tokenID.slice(0, 20);
        recordDailyBudgetSpend(parseFloat(price) * parseFloat(size), marketName);
      }
      // Event mapping registered lazily by risk check's getEventGroup()

      // Informational Telegram notification for all trades
      {
        const marketName = body.market || tokenID.slice(0, 20);
        const strat = body.strategy || "manual";
        const emoji = side === "BUY" ? "🟢" : "🔴";
        sendTelegramAlert(
          `${emoji} <b>TRADE EXECUTED</b>\n\n` +
          `<b>${side}</b> ${size}sh @ $${parseFloat(price).toFixed(2)}\n` +
          `<b>Market:</b> ${marketName}\n` +
          `<b>Strategy:</b> ${strat}\n` +
          `<b>Value:</b> $${(parseFloat(price) * parseFloat(size)).toFixed(2)}\n` +
          `<b>Order:</b> ${order.orderID || order.id || "pending"}`
        );
      }

      return send(res, 200, order);
    }

    // POST /market-sell — sell position at market (emergency exit)
    // v4: Uses FOK (fill-or-kill) + book-walking price + slippage tolerance
    // Params: tokenID, size, slippagePct (0-1, default 0), orderType (default "FOK")
    // FOK = atomic fill-or-cancel. No more dangling "live"/"delayed" orders.
    if (method === "POST" && path === "/market-sell") {
      const body = await parseBody(req);
      const { tokenID, size } = body;
      if (!tokenID || !size) return send(res, 400, { error: "Missing tokenID or size" });

      const slippagePct = parseFloat(body.slippagePct || 0); // 0 = best bid, 0.05 = 5% below walked price
      const orderType = body.orderType || "FOK"; // FOK by default for emergency sells

      // Get current order book
      const book = await client.getOrderBook(tokenID);
      const bids = book.bids || [];
      if (bids.length === 0) return send(res, 400, { error: "No bids available", tokenID: tokenID.slice(0, 20) });

      // Walk the book to find the price where we can fill the full order
      // Bids are ascending (lowest first, best/highest last) — walk from highest down
      // IMPORTANT: Floor to 2 decimal places to avoid fractional share rejection
      // (fees can cause buy 6 → receive 5.97, selling 6 would reject)
      const sellSize = Math.floor(parseFloat(size) * 100) / 100;
      let cumSize = 0;
      let walkPrice = null;
      let availableDepth = 0;
      for (let i = bids.length - 1; i >= 0; i--) {
        const levelPrice = parseFloat(bids[i].price);
        const levelSize = parseFloat(bids[i].size);
        cumSize += levelSize;
        availableDepth += levelSize * levelPrice;
        if (cumSize >= sellSize) {
          walkPrice = levelPrice;
          break;
        }
      }

      // Best bid is always the highest bid for reference
      const bestBid = parseFloat(bids[bids.length - 1].price);

      // If book doesn't have enough depth, use lowest available bid (for GTC fallback)
      // For FOK, this means the order will fail — but we report clearly why
      if (!walkPrice) {
        if (orderType === "FOK") {
          return send(res, 400, { 
            error: "Insufficient depth for FOK fill", 
            tokenID: tokenID.slice(0, 20),
            requestedSize: sellSize,
            availableSize: cumSize,
            bestBid,
            availableDepth: availableDepth.toFixed(2),
          });
        }
        walkPrice = parseFloat(bids[0].price); // lowest bid for GTC
      }

      // Apply slippage tolerance — lower the price to increase fill probability
      // walkPrice already accounts for depth; slippage goes below that
      const tickSize = walkPrice >= 0.1 ? 0.01 : 0.001;
      let fillPrice = walkPrice * (1 - slippagePct);
      // Round DOWN to nearest tick (must be valid CLOB price)
      fillPrice = Math.floor(fillPrice / tickSize) * tickSize;
      // Clamp to minimum valid price
      fillPrice = Math.max(fillPrice, tickSize);

      console.log(`🚨 MARKET SELL (${orderType}): ${sellSize} @ ${fillPrice} (walked=${walkPrice}, best=${bestBid}, slip=${(slippagePct*100).toFixed(1)}%) on ${tokenID.slice(0, 20)}...`);

      const walId = logIntent({ type: "market-sell", tokenID, price: fillPrice, size: sellSize, side: "SELL", strategy: body.strategy || "manual", source: body.source || "executor-manual", meta: { reason: body.reason, orderType, slippagePct, walkPrice, bestBid } });
      let order;
      try {
        order = await client.createAndPostOrder({
          tokenID,
          price: fillPrice,
          size: sellSize,
          side: Side.SELL,
        }, undefined, orderType);
      } catch (e) {
        resolveIntent(walId, "failed", { error: e.message });
        throw e;
      }

      console.log(`Sell result:`, JSON.stringify(order));

      // Check fill status for FOK orders
      const statusField = order.status || order.orderStatus || order.order_status || "";
      const orderStatus = typeof statusField === "string" ? statusField.toLowerCase() : String(statusField).toLowerCase();
      const isFilled = orderStatus === "matched" || orderStatus === "filled" ||
        (order.takingAmount && order.takingAmount !== "" && order.takingAmount !== "0");

      // Resolve WAL intent AFTER fill check (was previously resolving as "filled" unconditionally)
      resolveIntent(walId, isFilled ? "filled" : "unfilled", {
        orderID: order.orderID || order.id,
        executedPrice: fillPrice,
        fillStatus: isFilled ? "filled" : "unfilled",
      });

      // EXIT LEDGER — log the sell (even if unfilled, for audit trail)
      // CRITICAL: wrapped in try/catch so ledger failures never prevent the HTTP response.
      // If this throws without the try/catch, ws-feed gets a broken connection, treats it as
      // a network error, and retries — but the CLOB order already went through on-chain.
      if (isFilled) {
        try {
          const cachedData = await getCachedPositions().catch(() => null);
          const cachedPos = cachedData?.openPositions || [];
          const pos = cachedPos.find(p => p.asset_id === tokenID);
          const entryPrice = pos ? parseFloat(pos.avgPrice) : 0;
          const costBasis = sellSize * entryPrice;
          const proceeds = sellSize * fillPrice;
          logExit({
            assetId: tokenID,
            market: getMarketName(tokenID) || (pos?.market) || `Asset ${tokenID.slice(0,20)}...`,
            outcome: pos?.outcome || body.outcome || "Unknown",
            reason: body.reason === "STOP_LOSS" ? EXIT_REASONS.STOP_LOSS
                  : body.reason === "TAKE_PROFIT" ? EXIT_REASONS.TAKE_PROFIT
                  : body.reason === "TIME_STOP" ? EXIT_REASONS.TIME_STOP
                  : body.reason === "EMERGENCY" ? EXIT_REASONS.EMERGENCY
                  : EXIT_REASONS.MANUAL_SELL,
            triggerSource: body.source || "executor-manual",
            entryPrice,
            exitPrice: fillPrice,
            size: sellSize,
            costBasis,
            proceeds,
            realizedPnl: proceeds - costBasis,
            strategy: pos?.strategy || body.strategy || "unknown",
            notes: body.notes || `${orderType} fill @ ${fillPrice} (walked=${walkPrice}, slip=${(slippagePct*100).toFixed(1)}%)`,
          });
          positionLedger.recordExit({ assetId: tokenID, size: sellSize, reason: body.reason || "manual_sell", source: body.source || "executor-manual" });
          invalidateTradeCache();
          triggerSnapshotPush();
        } catch (ledgerErr) {
          console.log(`⚠️ MARKET-SELL: Ledger write failed (non-fatal, sell DID fill): ${ledgerErr.message}`);
        }
      } else {
        // Cancel unfilled FOK order (shouldn't be needed for true FOK, but belt-and-suspenders)
        const orderId = order.orderID || order.id || order.order_id;
        if (orderId) {
          try { await client.cancelOrder(orderId); } catch (_) {}
        }
      }

      return send(res, 200, {
        ...order,
        executedPrice: fillPrice,
        fillStatus: isFilled ? "filled" : "unfilled",
        orderType,
        walkPrice,
        bestBid,
        slippagePct,
        availableDepth: cumSize,
      });
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

      const arbWalId = logIntent({ type: "arb", tokenID: legs.map(l => l.tokenID.slice(0, 12)).join("+"), price: 0, size: legs.length, side: "ARB", strategy: "arb", source: "executor", meta: { legs: legs.map(l => ({ token: l.tokenID.slice(0, 20), price: l.price, size: l.size, side: l.side })) } });
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
          // FOK orders: "live" means resting on book (NOT filled), "matched" means filled
          // Also check takingAmount/makingAmount — empty strings = no fill
          const val = r.value;
          const isActuallyFilled = val.status === "matched" || 
            (val.takingAmount && val.takingAmount !== "" && val.takingAmount !== "0") ||
            (val.makingAmount && val.makingAmount !== "" && val.makingAmount !== "0");
          
          if (isActuallyFilled) {
            filled.push({ leg: i, result: val });
          } else {
            console.log(`⚠️ ARB leg ${i}: order accepted but NOT filled (status: ${val.status}, taking: "${val.takingAmount}", making: "${val.makingAmount}") — treating as failed`);
            // Cancel the resting order if it got posted
            if (val.orderID) {
              client.cancelOrder(val.orderID).catch(e => console.log(`  Cancel cleanup: ${e.message}`));
            }
            failed.push({ leg: i, error: `Order posted but not filled (status: ${val.status})` });
          }
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
            // Sort asks ascending to get best (lowest) ask price
            const sortedAsks = (book.asks || []).map(a => parseFloat(a.price)).sort((a, b) => a - b);
            const unwindPrice = unwindSide === Side.SELL
              ? (book.bids?.length > 0 ? parseFloat(book.bids[book.bids.length - 1].price) : null)
              : (sortedAsks.length > 0 ? sortedAsks[0] : null);
            
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
        
        resolveIntent(arbWalId, "failed", { error: "Partial fill — unwound" });
        return send(res, 200, {
          status: "PARTIAL_FILL_UNWOUND",
          filled, failed, unwindResults,
          warning: "Arbitrage incomplete — filled legs unwound"
        });
      }

      const arbStatus = filled.length === legs.length ? "ALL_FILLED" : "ALL_FAILED";
      resolveIntent(arbWalId, arbStatus === "ALL_FILLED" ? "filled" : "failed", { error: arbStatus === "ALL_FAILED" ? "All legs failed" : null });
      return send(res, 200, {
        status: arbStatus,
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

  // WAL crash recovery: surface any orders that were in-flight when we last crashed
  const unresolved = getUnresolved();
  if (unresolved.length > 0) {
    console.log(`[WAL] ⚠️ Found ${unresolved.length} unresolved trade(s) from previous session`);
    const summary = unresolved.map(e => `• ${e.side} ${e.size}sh @ $${e.price} (${e.type}, ${e.strategy}) — ${e.createdAt}`).join("\n");
    sendTelegramAlert(
      `⚠️ <b>WAL RECOVERY: ${unresolved.length} unresolved trade(s)</b>\n\n` +
      `These orders may have filled on-chain but were not confirmed locally.\n` +
      `Check /positions and reconcile.\n\n${summary}`
    );
    markStaleAsUnresolved();
  }

  const server = http.createServer(handler);
  server.listen(PORT, () => {
    console.log(`Executor API running on http://0.0.0.0:${PORT}`);
  });
}

// === CRASH SAFETY: Catch unhandled errors before they kill the process ===
process.on("unhandledRejection", (reason) => {
  console.error("[EXECUTOR] Unhandled rejection:", reason);
  sendTelegramAlert(`🚨 <b>EXECUTOR UNHANDLED REJECTION</b>\n<pre>${String(reason).slice(0, 500)}</pre>\n\nProcess may restart via PM2.`);
});

process.on("uncaughtException", (err) => {
  console.error("[EXECUTOR] Uncaught exception:", err);
  sendTelegramAlert(`🚨 <b>EXECUTOR CRASH</b>\n<pre>${String(err.stack || err).slice(0, 500)}</pre>\n\nProcess will restart via PM2.`);
  // Give Telegram time to send before exit
  setTimeout(() => process.exit(1), 2000);
});

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
