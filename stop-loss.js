#!/usr/bin/env node
/**
 * Stop Loss Manager — Unified stop logic for all paper trades
 * 
 * Two mechanisms:
 * 1. FIXED STOP (50%): For non-volatile markets (politics, AI, economic, deadlines)
 *    - Triggers when current price drops 50% from entry
 * 2. TRAILING STOP: For ALL markets once position is +20%
 *    - Floor = high water mark - 20 points, never decreases
 *    - Locks in gains progressively without capping upside
 * 
 * NO fixed stop for: sports, crypto price, live events, weather
 * These swing too wildly during live resolution — size correctly instead.
 * 
 * Usage:
 *   const stopLoss = require('./stop-loss');
 *   const result = stopLoss.check(trade, currentPrice);
 *   // result: { triggered: bool, reason: string, exitPrice: number, pnl: number }
 */

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════
// CATEGORY DETECTION
// ═══════════════════════════════════════════════════════════════

const VOLATILE_CATEGORIES = ['sports', 'crypto', 'live_event', 'weather'];
const FIXED_STOP_CATEGORIES = ['politics', 'ai_tech', 'economic', 'deadline', 'other'];

/**
 * Detect market category from question text.
 * Returns: sports | crypto | live_event | weather | politics | ai_tech | economic | deadline | other
 */
function detectCategory(question) {
  const q = (question || '').toLowerCase();

  // Weather
  if (/temperature|degrees|°[fc]|high.*temp|weather|fahrenheit|celsius/.test(q)) return 'weather';

  // Sports
  if (/\b(nba|nfl|mlb|nhl|mls|epl|premier league|la liga|serie a|bundesliga|ufc|boxing|tennis|f1|formula|olympics|medal|soccer|football|basketball|baseball|hockey|cricket|rugby|golf|atp|wta)\b/.test(q)) return 'sports';
  if (/\bvs\.?\b|\bversus\b|\bgame\b|\bmatch\b|\btournament\b|\bplayoff\b|\bfinal[s]?\b|\bchampion/.test(q)) return 'sports';
  // Team names (common NBA/NFL/etc)
  if (/\b(lakers|celtics|warriors|76ers|sixers|hawks|pacers|wizards|nets|cavaliers|rockets|hornets|knicks|bulls|heat|suns|bucks|nuggets|clippers|mavericks|grizzlies|pelicans|pistons|raptors|kings|spurs|timberwolves|blazers|thunder|jazz|magic|chiefs|eagles|cowboys|49ers|bills|ravens|bengals|dolphins|jets|patriots|steelers|packers|lions|bears|vikings|rams|chargers|broncos|raiders|commanders|texans|colts|jaguars|titans|saints|falcons|panthers|buccaneers|cardinals|seahawks|giants)\b/.test(q)) return 'sports';

  // Crypto price markets
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|dogecoin|doge|crypto|token)\b.*\b(price|above|below|reach|hit)\b/.test(q)) return 'crypto';
  if (/\b(price|above|below|reach|hit)\b.*\b(bitcoin|btc|ethereum|eth|solana|sol|xrp)\b/.test(q)) return 'crypto';
  if (/\$\d+[kK]?\s*(btc|bitcoin|eth|ethereum|sol|solana)/i.test(q)) return 'crypto';

  // Live events (awards, TV, debates, elections on election night)
  if (/\b(oscar|emmy|grammy|golden globe|academy award|best picture|best actor|best actress|beast games|survivor|bachelor|debate|live show|reality tv|award show|box office|opening weekend|super bowl halftime)\b/.test(q)) return 'live_event';
  if (/\b(election night|election result|vote count|ballot)\b/.test(q)) return 'live_event';

  // Politics / legislation
  if (/\b(congress|senate|house|bill|legislation|executive order|impeach|resign|government shutdown|tariff|sanction|veto|filibuster|supreme court|scotus|confirm|nominate|cabinet|secretary)\b/.test(q)) return 'politics';
  if (/\b(trump|biden|president|governor|mayor|democrat|republican|gop|dnc|rnc)\b/.test(q)) return 'politics';

  // AI / Tech
  if (/\b(gpt|claude|gemini|llama|mistral|openai|anthropic|google ai|deepseek|chatgpt|ai model|benchmark|lmsys|chatbot arena|elo rating)\b/.test(q)) return 'ai_tech';
  if (/\b(apple|microsoft|nvidia|tesla|meta|amazon|google)\b.*\b(launch|release|announce|stock)\b/.test(q)) return 'ai_tech';

  // Economic data
  if (/\b(gdp|inflation|cpi|unemployment|jobs report|nonfarm|fed|interest rate|fomc|recession|s&p|nasdaq|dow|stock market|treasury|yield|bond)\b/.test(q)) return 'economic';

  // Deadline markets
  if (/\bby\s+(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2}|end of|before)\b/.test(q)) return 'deadline';
  if (/\bwill.*happen\b.*\b(before|by)\b/.test(q)) return 'deadline';

  return 'other';
}

/**
 * Check if a category uses fixed stop loss
 */
function usesFixedStop(category) {
  return !VOLATILE_CATEGORIES.includes(category);
}

// ═══════════════════════════════════════════════════════════════
// STOP LOSS LOGIC
// ═══════════════════════════════════════════════════════════════

const FIXED_STOP_PCT = 0.50;       // 50% loss from entry
const TRAILING_ACTIVATION = 0.20;  // Activate trailing at +20%
const TRAILING_DISTANCE = 0.20;    // Trail 20 points below high water mark

/**
 * Check stop loss conditions for a trade.
 * 
 * @param {Object} trade - Paper trade object with at minimum:
 *   - entryPrice: number (0-1)
 *   - action: 'BUY_YES' | 'BUY_NO'
 *   - question: string (for category detection)
 *   - shares: number
 *   - totalCost: number
 *   - category: string (optional, auto-detected from question if missing)
 *   - _stopState: object (internal, managed by this module)
 * @param {number} currentPrice - Current market price for the YES token (0-1)
 * @returns {Object} { triggered, reason, exitPrice, pnl, category, stopState }
 */
function check(trade, currentPrice) {
  // Build detection string: combine available fields for better category matching
  const detectStr = trade.question || [trade.city, trade.bucket, trade.unit].filter(Boolean).join(' ') || '';
  const category = trade.category || (trade.city ? 'weather' : detectCategory(detectStr));
  const entry = trade.entryPrice;
  const shares = trade.shares || 0;
  
  // For BUY_NO trades, our position value = 1 - currentYesPrice
  // So if YES price goes UP, our NO position loses value
  const isNo = (trade.action || '').includes('NO');
  const positionValue = isNo ? (1 - currentPrice) : currentPrice;
  const entryValue = isNo ? (1 - entry) : entry;  // Wait — entry for BUY_NO is the NO ask price
  
  // Actually for BUY_NO: entryPrice IS the NO ask price we paid.
  // Current value of our NO shares = 1 - currentYesPrice (or equivalently, current NO bid)
  // So: unrealized gain = (currentNoPrice - entryPrice) / entryPrice
  // Let's use the position value directly
  const effectiveEntry = entry; // What we paid per share
  const effectiveCurrentValue = isNo ? (1 - currentPrice) : currentPrice; // What our shares are worth now
  
  const unrealizedPct = (effectiveCurrentValue - effectiveEntry) / effectiveEntry;
  
  // Initialize stop state
  const stopState = trade._stopState || {
    highWaterMark: effectiveCurrentValue,
    trailingActive: false,
    trailingFloor: null,
  };

  // Update high water mark
  if (effectiveCurrentValue > stopState.highWaterMark) {
    stopState.highWaterMark = effectiveCurrentValue;
  }

  // Check trailing stop activation
  if (!stopState.trailingActive && unrealizedPct >= TRAILING_ACTIVATION) {
    stopState.trailingActive = true;
    stopState.trailingFloor = Math.max(effectiveEntry, stopState.highWaterMark - TRAILING_DISTANCE);
  }

  // Update trailing floor (ratchet up, never down)
  if (stopState.trailingActive) {
    const newFloor = stopState.highWaterMark - TRAILING_DISTANCE;
    if (newFloor > (stopState.trailingFloor || 0)) {
      stopState.trailingFloor = newFloor;
    }
  }

  const result = {
    triggered: false,
    reason: null,
    exitPrice: effectiveCurrentValue,
    pnl: null,
    category,
    unrealizedPct: Math.round(unrealizedPct * 1000) / 10, // e.g. 21.5%
    stopState: { ...stopState },
  };

  // Check trailing stop
  if (stopState.trailingActive && effectiveCurrentValue <= stopState.trailingFloor) {
    result.triggered = true;
    result.reason = 'TRAILING_STOP';
    result.exitPrice = stopState.trailingFloor; // Assume fill at floor
    result.pnl = Math.round((stopState.trailingFloor - effectiveEntry) * shares * 100) / 100;
    return result;
  }

  // Check fixed stop (only for non-volatile categories)
  if (usesFixedStop(category) && unrealizedPct <= -FIXED_STOP_PCT) {
    result.triggered = true;
    result.reason = 'FIXED_STOP';
    result.exitPrice = effectiveCurrentValue;
    result.pnl = Math.round((effectiveCurrentValue - effectiveEntry) * shares * 100) / 100;
    return result;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// PAPER TRADE STOP CHECKER — Batch process all open trades
// ═══════════════════════════════════════════════════════════════

const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'StopLoss/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * Get current YES price for a token from CLOB orderbook
 */
async function getCurrentPrice(yesToken) {
  if (!yesToken) return null;
  try {
    const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${yesToken}`);
    if (book.bids && book.bids.length > 0) {
      return parseFloat(book.bids[0].price); // Best bid = what we could sell YES for
    }
    if (book.asks && book.asks.length > 0) {
      return parseFloat(book.asks[0].price);
    }
  } catch { }
  return null;
}

/**
 * Check all open paper trades in a paper log file.
 * Updates _stopState in place, triggers exits where needed.
 * 
 * @param {string} paperFile - Path to paper trade JSON file
 * @returns {Object} { checked, triggered, results }
 */
async function checkAllTrades(paperFile) {
  let log;
  try {
    log = JSON.parse(fs.readFileSync(paperFile, 'utf8'));
  } catch {
    return { checked: 0, triggered: 0, results: [] };
  }

  const trades = log.paperTrades || [];
  const openTrades = trades.filter(t => !t.resolution && t.dollarPnl === null);
  const results = [];
  let triggered = 0;

  for (const trade of openTrades) {
    const yesToken = trade.yesToken;
    if (!yesToken) continue;

    const currentYesPrice = await getCurrentPrice(yesToken);
    if (currentYesPrice === null) continue;

    const result = check(trade, currentYesPrice);
    
    // Persist stop state back to trade
    trade._stopState = result.stopState;
    trade.category = trade.category || result.category;

    if (result.triggered) {
      triggered++;
      trade.resolution = 'STOPPED';
      trade.dollarPnl = result.pnl;
      trade.exitPrice = result.exitPrice;
      trade.exitReason = result.reason;
      trade.exitTimestamp = new Date().toISOString();
      console.log(`🛑 ${result.reason}: ${trade.question || trade.city || 'unknown'} — P&L: $${result.pnl}`);
    }

    results.push({
      question: trade.question || `${trade.city} ${trade.bucket}`,
      category: result.category,
      entryPrice: trade.entryPrice,
      currentValue: result.exitPrice,
      unrealizedPct: result.unrealizedPct,
      trailingActive: result.stopState.trailingActive,
      trailingFloor: result.stopState.trailingFloor,
      highWaterMark: result.stopState.highWaterMark,
      triggered: result.triggered,
      reason: result.reason,
    });
  }

  // Save updated stop states back
  fs.writeFileSync(paperFile, JSON.stringify(log, null, 2));

  return { checked: openTrades.length, triggered, results };
}

// ═══════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════

if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args[0] === 'check' || args.length === 0) {
    const weatherFile = path.join(__dirname, 'weather-v2-paper.json');
    const directionalFile = path.join(__dirname, 'directional-paper.json');

    (async () => {
      console.log('🛡️ Stop Loss Checker\n');

      if (fs.existsSync(weatherFile)) {
        console.log('--- Weather Paper Trades ---');
        const w = await checkAllTrades(weatherFile);
        console.log(`Checked: ${w.checked}, Stopped: ${w.triggered}`);
        w.results.forEach(r => {
          const status = r.triggered ? `🛑 ${r.reason}` : r.trailingActive ? `📈 trailing (floor: ${r.trailingFloor?.toFixed(2)})` : `⏳ ${r.unrealizedPct}%`;
          console.log(`  ${r.question}: ${status}`);
        });
      }

      console.log('');

      if (fs.existsSync(directionalFile)) {
        console.log('--- Directional Paper Trades ---');
        const d = await checkAllTrades(directionalFile);
        console.log(`Checked: ${d.checked}, Stopped: ${d.triggered}`);
        d.results.forEach(r => {
          const status = r.triggered ? `🛑 ${r.reason}` : r.trailingActive ? `📈 trailing (floor: ${r.trailingFloor?.toFixed(2)})` : `⏳ ${r.unrealizedPct}%`;
          console.log(`  ${r.question}: ${status}`);
        });
      }
    })();
  }

  if (args[0] === 'detect') {
    // Test category detection
    const q = args.slice(1).join(' ');
    console.log(`"${q}" → ${detectCategory(q)} (fixed stop: ${usesFixedStop(detectCategory(q))})`);
  }
}

module.exports = { check, checkAllTrades, detectCategory, usesFixedStop };
