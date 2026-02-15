/**
 * Crypto Binary Scanner — Daily "Up or Down" Markets
 * 
 * SCOPE: This scanner targets DAILY crypto binary markets (BTC, ETH, SOL, XRP).
 * NOTE: 5-minute and 15-minute crypto binaries DO NOT EXIST on Polymarket.
 * 
 * Strategy: Monitor daily crypto "Up or Down" markets for:
 *   - Rebalancing arb (YES ask + NO ask < $0.98)
 *   - Pre-resolution directional opportunities (when outcome becomes clear before resolution)
 * 
 * Resolution: Daily at 17:00 UTC (or market-specific time)
 * Assets: BTC, ETH, SOL, XRP
 * Capital velocity: LOW (1 cycle per day max) — not suitable for high-velocity trading
 * 
 * Flow:
 *   1. Fetch active crypto binary markets from Gamma API
 *   2. Filter for "Up or Down" or similar daily price direction markets
 *   3. Check order books for arb opportunities
 *   4. Log opportunities (DO NOT auto-execute without approval)
 */

const fs = require("fs");
const path = require("path");

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

const RESULTS_FILE = path.join(__dirname, "crypto-binary-opportunities.json");

// Scanner config
const MIN_VOLUME_24H = 10000; // $10K minimum volume
const ARB_THRESHOLD = 0.98;   // 2% guaranteed profit minimum
const MIN_DEPTH = 50;         // Min shares at best ask
const CLOB_DELAY_MS = 350;    // Rate limit protection

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function getBookPrices(tokenId) {
  try {
    const book = await fetchJSON(`${CLOB_API}/book?token_id=${tokenId}`);
    
    const bestBid = book.bids && book.bids.length > 0 
      ? parseFloat(book.bids[book.bids.length - 1].price)
      : null;
    const bestAsk = book.asks && book.asks.length > 0
      ? parseFloat(book.asks[0].price)
      : null;
    
    const askDepth = book.asks && book.asks.length > 0
      ? parseFloat(book.asks[0].size)
      : 0;
    const bidDepth = book.bids && book.bids.length > 0
      ? parseFloat(book.bids[book.bids.length - 1].size)
      : 0;
    
    return { bestBid, bestAsk, bidDepth, askDepth };
  } catch (e) {
    return null;
  }
}

/**
 * Main scan function
 * 
 * @param {Object} opts
 * @param {Function} opts.log - logging function
 * @returns {Object} scan results
 */
async function runCryptoBinaryScan(opts = {}) {
  const log = opts.log || ((tag, msg) => console.log(`[${tag}] ${msg}`));
  
  log("CRYPTO", "Starting crypto binary scan...");
  
  try {
    // Fetch active markets
    const markets = await fetchJSON(
      `${GAMMA_API}/markets?limit=300&active=true&closed=false&order=volume24hr&ascending=false`
    );
    
    // Filter for crypto binaries
    const cryptoBinaries = markets.filter(m => {
      const text = ((m.question || '') + ' ' + (m.slug || '')).toLowerCase();
      
      // Must mention crypto asset
      if (!/\b(bitcoin|ethereum|solana|ripple|btc|eth|sol|xrp)\b/.test(text)) return false;
      
      // Must be price direction market
      if (!/up or down|updown|higher or lower|rise or fall/.test(text)) return false;
      
      // Sufficient volume
      const vol24h = parseFloat(m.volume24hr || 0);
      if (vol24h < MIN_VOLUME_24H) return false;
      
      return true;
    });
    
    log("CRYPTO", `Found ${cryptoBinaries.length} active crypto binary markets`);
    
    const opportunities = [];
    
    for (const m of cryptoBinaries) {
      // Parse tokens
      let yesToken, noToken;
      try {
        const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        if (!tokens || tokens.length !== 2) continue;
        yesToken = tokens[0];
        noToken = tokens[1];
      } catch (e) { continue; }
      
      // Fetch order books
      const yesBook = await getBookPrices(yesToken);
      await sleep(CLOB_DELAY_MS);
      
      const noBook = await getBookPrices(noToken);
      await sleep(CLOB_DELAY_MS);
      
      if (!yesBook || !noBook) continue;
      
      // Check for arb
      if (yesBook.bestAsk !== null && noBook.bestAsk !== null) {
        const askSum = yesBook.bestAsk + noBook.bestAsk;
        const minDepth = Math.min(yesBook.askDepth, noBook.askDepth);
        
        // Calculate hours to resolution
        const now = new Date();
        const endDate = new Date(m.endDate);
        const hoursToEnd = (endDate - now) / 3600000;
        
        const opp = {
          timestamp: now.toISOString(),
          market: m.question,
          slug: m.slug,
          conditionId: m.conditionId,
          yesToken,
          noToken,
          yesAsk: yesBook.bestAsk,
          noAsk: noBook.bestAsk,
          askSum: +askSum.toFixed(4),
          yesDepth: yesBook.askDepth,
          noDepth: noBook.askDepth,
          minDepth,
          vol24h: parseFloat(m.volume24hr || 0),
          endDate: m.endDate,
          hoursToEnd: hoursToEnd > 0 ? +hoursToEnd.toFixed(1) : null,
          arbOpportunity: askSum < ARB_THRESHOLD,
          spread: +((askSum - 1.0) * 100).toFixed(2), // % above/below $1.00
        };
        
        opportunities.push(opp);
        
        if (opp.arbOpportunity && minDepth >= MIN_DEPTH) {
          log("CRYPTO", `🎯 ARB: ${m.question.slice(0, 50)} | YES $${yesBook.bestAsk} + NO $${noBook.bestAsk} = $${askSum.toFixed(4)} | Depth: ${minDepth}`);
        } else {
          log("CRYPTO", `📊 ${m.question.slice(0, 30)} | Sum: $${askSum.toFixed(4)} | Spread: ${opp.spread}% | Hrs: ${opp.hoursToEnd || '?'}`);
        }
      }
    }
    
    const results = {
      timestamp: new Date().toISOString(),
      summary: {
        marketsScanned: cryptoBinaries.length,
        arbOpportunities: opportunities.filter(o => o.arbOpportunity && o.minDepth >= MIN_DEPTH).length,
        avgSpread: opportunities.length > 0
          ? +(opportunities.reduce((sum, o) => sum + o.spread, 0) / opportunities.length).toFixed(2)
          : null,
      },
      opportunities: opportunities.sort((a, b) => a.spread - b.spread), // Best spreads first
    };
    
    // Write results
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
    
    log("CRYPTO", `✅ Scan complete | Markets: ${results.summary.marketsScanned} | Arbs: ${results.summary.arbOpportunities} | Avg spread: ${results.summary.avgSpread}%`);
    
    return results;
    
  } catch (e) {
    log("CRYPTO", `❌ Scan failed: ${e.message}`);
    return { error: e.message };
  }
}

// If run directly
if (require.main === module) {
  runCryptoBinaryScan({
    log: (tag, msg) => console.log(`[${tag}] ${msg}`),
  }).then(results => {
    console.log('\n' + JSON.stringify(results, null, 2));
  });
}

module.exports = { runCryptoBinaryScan };
