/**
 * Binary Market Arb Scanner
 * 
 * Scans ALL active binary markets (not just NegRisk) for:
 *   LONG ARB: YES ask + NO ask < $1.00 → buy both, guaranteed profit at resolution
 *   SHORT ARB: YES bid + NO bid > $1.00 → sell both (if holding), guaranteed profit
 * 
 * The existing arb scanner ONLY checks multi-outcome NegRisk events.
 * This scanner fills that gap for the majority of Polymarket markets.
 * 
 * Strategy: Crypto Binary Pure Arb (promoted to TESTING 2026-02-14)
 * Risk: Near-zero per trade (payout = $1.00 guaranteed)
 * Expected edge: 2-5% per arb capture
 * 
 * Flow:
 *   1. Fetch top markets from Gamma API (pre-filtered by volume + activity)
 *   2. Use Gamma mid-prices as fast pre-filter (no CLOB calls needed)
 *   3. For promising markets (mid sum deviates from $1.00), fetch CLOB order books
 *   4. Calculate exact profit after taker fees
 *   5. Auto-execute viable arbs via /arb endpoint (FOK both legs)
 */

const fs = require("fs");
const path = require("path");

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

// Scanner config
const BINARY_ARB_RESULTS_FILE = path.join(__dirname, "..", "binary-arb-results.json");
const BINARY_ARB_EXECUTED_FILE = path.join(__dirname, "..", "binary-arb-executed.json");

// Pre-filter: only fetch CLOB books when Gamma mid-prices show deviation beyond this
const MID_PRICE_DEVIATION_THRESHOLD = 0.015; // 1.5% — if YES mid + NO mid < 0.985, check books
// Execution threshold: only execute when ask sum < this after fees
const EXEC_THRESHOLD = 0.98;  // 2% guaranteed profit minimum
// Minimum depth on each leg
const MIN_DEPTH_SHARES = 5;
// Max spend per arb
const MAX_SPEND_PER_ARB = 25;  // $25 per arb (conservative at $380 bankroll)
// Min absolute profit to bother
const MIN_PROFIT_FLAT = 0.25;  // at least 25 cents
// Max CLOB book fetches per scan cycle (rate limit protection)
const MAX_BOOK_FETCHES = 30;
// Minimum 24h volume to scan
const MIN_VOLUME_24H = 500;
// Rate limit delay between CLOB calls
const CLOB_DELAY_MS = 350;

// Fee rates (from ws-feed.js)
const FEE_RATES = { NONE: 0, CRYPTO_15MIN: 3.125, SPORTS: 0.875 };

function takerFeePerShare(price, marketType = 'NONE') {
  return price * (1 - price) * (FEE_RATES[marketType] || 0);
}

function detectMarketType(question = '', slug = '') {
  const q = (question + ' ' + slug).toLowerCase();
  if (q.includes('15m') || q.includes('up or down') || q.includes('updown')) return 'CRYPTO_15MIN';
  if (q.includes('ncaab') || q.includes('serie a')) return 'SPORTS';
  return 'NONE';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/**
 * Fetch order book from CLOB for a token
 * Returns { bestBid, bestAsk, bidDepth, askDepth } or null on error
 */
async function getBookPrices(tokenId) {
  try {
    const book = await fetchJSON(`${CLOB_API}/book?token_id=${tokenId}`);
    
    // CLOB returns bids ascending (lowest first, best/highest last)
    // CLOB returns asks ascending (lowest/best first)
    const bestBid = book.bids && book.bids.length > 0 
      ? parseFloat(book.bids[book.bids.length - 1].price)
      : null;
    const bestAsk = book.asks && book.asks.length > 0
      ? parseFloat(book.asks[0].price)
      : null;
    
    // Calculate depth at best price (how many shares available)
    const askDepth = book.asks && book.asks.length > 0
      ? parseFloat(book.asks[0].size)
      : 0;
    const bidDepth = book.bids && book.bids.length > 0
      ? parseFloat(book.bids[book.bids.length - 1].size)
      : 0;
    
    // Also get total depth across top 3 levels
    const askDepthTotal = (book.asks || []).slice(0, 3)
      .reduce((sum, a) => sum + parseFloat(a.size || 0), 0);
    const bidDepthTotal = (book.bids || []).slice(0, 3)
      .reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
    
    return { bestBid, bestAsk, bidDepth, askDepth, bidDepthTotal, askDepthTotal };
  } catch (e) {
    return null;
  }
}

/**
 * Main scan function. Call from ws-feed.js on a timer.
 * 
 * @param {Object} opts
 * @param {Function} opts.log - logging function (tag, msg)
 * @param {Function} opts.checkAutoCapBudget - auto-cap budget checker
 * @param {Function} opts.httpPost - post to executor
 * @param {Function} opts.sendTelegramAlert - telegram notification
 * @param {Function} opts.tagStrategy - strategy tagger
 * @param {boolean} opts.canExecute - whether auto-execution is allowed
 * @returns {Object} scan results
 */
async function runBinaryArbScan(opts = {}) {
  const log = opts.log || ((tag, msg) => console.log(`[${tag}] ${msg}`));
  
  log("BARB", "Starting binary arb scan...");
  
  try {
    // Step 1: Fetch active markets from Gamma, sorted by volume
    // We want binary markets: exactly 1 market per event, or we check individual markets
    const markets = await fetchJSON(
      `${GAMMA_API}/markets?limit=200&active=true&closed=false&order=volume24hr&ascending=false`
    );
    
    log("BARB", `Fetched ${markets.length} active markets from Gamma`);
    
    // Step 2: Filter to binary markets with sufficient volume
    const now = new Date();
    const candidates = [];
    
    for (const m of markets) {
      // Skip closed or inactive
      if (m.closed || !m.active) continue;
      
      // Skip markets that already ended
      if (m.endDate && new Date(m.endDate) < now) continue;
      
      // Skip very low volume
      const vol24h = parseFloat(m.volume24hr || 0);
      if (vol24h < MIN_VOLUME_24H) continue;
      
      // Parse outcome prices from Gamma
      let yesMid = 0, noMid = 0;
      try {
        const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        if (!prices || prices.length !== 2) continue; // not a binary market
        yesMid = parseFloat(prices[0]) || 0;
        noMid = parseFloat(prices[1]) || 0;
      } catch (e) { continue; }
      
      // Skip if either side is near 0 or 1 (resolved or near-resolved — no arb possible)
      if (yesMid < 0.02 || yesMid > 0.98 || noMid < 0.02 || noMid > 0.98) continue;
      
      // Parse token IDs
      let yesToken = null, noToken = null;
      try {
        const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        if (!tokens || tokens.length !== 2) continue;
        yesToken = tokens[0];
        noToken = tokens[1];
      } catch (e) { continue; }
      
      const midSum = yesMid + noMid;
      const midDeviation = Math.abs(midSum - 1.0);
      
      // Detect market type for fee calculation
      const mktType = detectMarketType(m.question || '', m.slug || '');
      
      candidates.push({
        question: (m.question || '').slice(0, 80),
        conditionId: m.conditionId,
        slug: m.slug,
        yesToken,
        noToken,
        yesMid,
        noMid,
        midSum,
        midDeviation,
        vol24h,
        endDate: m.endDate,
        mktType,
        hoursToEnd: m.endDate ? ((new Date(m.endDate) - now) / 3600000) : null,
      });
    }
    
    log("BARB", `${candidates.length} binary candidates after filtering (vol >${MIN_VOLUME_24H}, active, not near-resolved)`);
    
    // Step 3: Prioritize which markets to check via CLOB
    // Gamma normalizes mid-prices to exactly 1.0000, so mid-price deviation is useless
    // as a pre-filter. Instead, prioritize by:
    //   1. Crypto binaries (primary strategy focus, always check)
    //   2. Markets resolving in <24h (more price movement = more arb opportunity)
    //   3. Highest volume (more book activity = more momentary imbalances)
    
    const cryptoBinaries = candidates.filter(c => c.mktType === 'CRYPTO_15MIN');
    const soonResolving = candidates.filter(c => 
      c.hoursToEnd !== null && c.hoursToEnd > 0 && c.hoursToEnd < 24 &&
      c.mktType !== 'CRYPTO_15MIN' // don't double-count
    ).sort((a, b) => a.hoursToEnd - b.hoursToEnd);
    
    // Fill remaining slots with highest volume markets
    const checkedIds = new Set([
      ...cryptoBinaries.map(c => c.conditionId),
      ...soonResolving.map(c => c.conditionId),
    ]);
    const highVolume = candidates
      .filter(c => !checkedIds.has(c.conditionId))
      .sort((a, b) => b.vol24h - a.vol24h);
    
    // Allocate slots: crypto first, then soon-resolving, then high-volume
    const maxBookPairs = Math.floor(MAX_BOOK_FETCHES / 2); // 2 fetches per market (YES + NO)
    const toCheck = [
      ...cryptoBinaries,
      ...soonResolving.slice(0, Math.max(5, maxBookPairs - cryptoBinaries.length - 5)),
      ...highVolume.slice(0, Math.max(0, maxBookPairs - cryptoBinaries.length - soonResolving.length)),
    ].slice(0, maxBookPairs);
    
    log("BARB", `Checking ${toCheck.length} markets (${cryptoBinaries.length} crypto, ${Math.min(soonResolving.length, toCheck.length - cryptoBinaries.length)} soon-resolving, rest by volume)`);
    
    const opportunities = [];
    let bookFetches = 0;
    
    for (const c of toCheck) {
      // Fetch YES and NO books
      const yesBook = await getBookPrices(c.yesToken);
      bookFetches++;
      await sleep(CLOB_DELAY_MS);
      
      const noBook = await getBookPrices(c.noToken);
      bookFetches++;
      await sleep(CLOB_DELAY_MS);
      
      if (!yesBook || !noBook) continue;
      
      // === LONG ARB: buy YES + buy NO for < $1.00 ===
      if (yesBook.bestAsk !== null && noBook.bestAsk !== null) {
        const askSum = yesBook.bestAsk + noBook.bestAsk;
        
        // Calculate fees on each leg
        const yesFee = takerFeePerShare(yesBook.bestAsk, c.mktType);
        const noFee = takerFeePerShare(noBook.bestAsk, c.mktType);
        const totalFees = yesFee + noFee;
        
        const effectiveCost = askSum + totalFees;
        const profitPerShare = 1.0 - effectiveCost;
        
        // Check depth (min shares available on both sides)
        const minDepth = Math.min(yesBook.askDepth, noBook.askDepth);
        const minDepthTotal = Math.min(yesBook.askDepthTotal, noBook.askDepthTotal);
        
        if (effectiveCost < EXEC_THRESHOLD && profitPerShare > 0) {
          const maxShares = Math.min(
            minDepthTotal,
            Math.floor(MAX_SPEND_PER_ARB / effectiveCost)
          );
          const totalProfit = maxShares * profitPerShare;
          
          opportunities.push({
            type: "LONG",
            market: c.question,
            conditionId: c.conditionId,
            slug: c.slug,
            yesToken: c.yesToken,
            noToken: c.noToken,
            yesAsk: yesBook.bestAsk,
            noAsk: noBook.bestAsk,
            askSum,
            yesFee: +yesFee.toFixed(6),
            noFee: +noFee.toFixed(6),
            totalFees: +totalFees.toFixed(6),
            effectiveCost: +effectiveCost.toFixed(6),
            profitPerShare: +profitPerShare.toFixed(6),
            profitPct: +((profitPerShare / effectiveCost) * 100).toFixed(2),
            yesDepth: yesBook.askDepthTotal,
            noDepth: noBook.askDepthTotal,
            minDepth: minDepthTotal,
            maxShares,
            totalProfit: +totalProfit.toFixed(4),
            mktType: c.mktType,
            hoursToEnd: c.hoursToEnd,
            vol24h: c.vol24h,
            viable: totalProfit >= MIN_PROFIT_FLAT && maxShares >= MIN_DEPTH_SHARES,
          });
          
          log("BARB", `🎯 LONG ARB: "${c.question.slice(0,50)}" | YES ask ${yesBook.bestAsk} + NO ask ${noBook.bestAsk} = $${askSum.toFixed(4)} | Profit: $${totalProfit.toFixed(2)} (${((profitPerShare/effectiveCost)*100).toFixed(1)}%) | Depth: ${minDepthTotal}`);
        }
      }
      
      // === SHORT ARB: sell YES + sell NO for > $1.00 ===
      // (Only relevant if we hold both sides — rare but worth tracking)
      if (yesBook.bestBid !== null && noBook.bestBid !== null) {
        const bidSum = yesBook.bestBid + noBook.bestBid;
        
        if (bidSum > 1.02) { // 2% profit minimum for short arb
          opportunities.push({
            type: "SHORT",
            market: c.question,
            conditionId: c.conditionId,
            slug: c.slug,
            yesToken: c.yesToken,
            noToken: c.noToken,
            yesBid: yesBook.bestBid,
            noBid: noBook.bestBid,
            bidSum,
            profitPerShare: +(bidSum - 1.0).toFixed(6),
            profitPct: +(((bidSum - 1.0)) * 100).toFixed(2),
            yesDepth: yesBook.bidDepthTotal,
            noDepth: noBook.bidDepthTotal,
            minDepth: Math.min(yesBook.bidDepthTotal, noBook.bidDepthTotal),
            hoursToEnd: c.hoursToEnd,
            vol24h: c.vol24h,
            mktType: c.mktType,
            viable: false, // short arbs need existing positions — flag only
          });
          
          log("BARB", `📊 SHORT ARB (info only): "${c.question.slice(0,50)}" | YES bid ${yesBook.bestBid} + NO bid ${noBook.bestBid} = $${bidSum.toFixed(4)}`);
        }
      }
    }
    
    // Sort by profit
    opportunities.sort((a, b) => b.totalProfit - a.totalProfit);
    
    const results = {
      timestamp: new Date().toISOString(),
      summary: {
        totalMarkets: markets.length,
        binaryCandidates: candidates.length,
        booksChecked: bookFetches / 2, // each market = 2 book fetches
        longArbs: opportunities.filter(o => o.type === "LONG").length,
        shortArbs: opportunities.filter(o => o.type === "SHORT").length,
        viableArbs: opportunities.filter(o => o.viable).length,
      },
      opportunities,
    };
    
    // Write results
    fs.writeFileSync(BINARY_ARB_RESULTS_FILE, JSON.stringify(results, null, 2));
    log("BARB", `✅ Binary arb scan complete — ${results.summary.booksChecked} books checked | Long: ${results.summary.longArbs} | Viable: ${results.summary.viableArbs}`);
    
    // === AUTO-EXECUTION ===
    if (opts.canExecute && results.summary.viableArbs > 0) {
      // Load executed slugs to prevent re-execution
      let executedSlugs;
      try { executedSlugs = new Set(JSON.parse(fs.readFileSync(BINARY_ARB_EXECUTED_FILE, "utf8"))); }
      catch { executedSlugs = new Set(); }
      
      for (const opp of opportunities) {
        if (!opp.viable || opp.type !== "LONG") continue;
        
        const execKey = `${opp.conditionId}_${opp.yesAsk}_${opp.noAsk}`;
        if (executedSlugs.has(opp.conditionId)) {
          log("BARB", `Skipping "${opp.market.slice(0,40)}" — already executed for this condition`);
          continue;
        }
        
        // Check auto-cap budget
        if (opts.checkAutoCapBudget) {
          const budget = opts.checkAutoCapBudget("arb", opp.maxShares * opp.effectiveCost);
          if (!budget.allowed) {
            log("BARB", `Skipping "${opp.market.slice(0,40)}" — auto-cap budget exceeded`);
            break;
          }
        }
        
        // Calculate position size (conservative)
        const shares = Math.min(opp.maxShares, Math.floor(MAX_SPEND_PER_ARB / opp.effectiveCost));
        if (shares < MIN_DEPTH_SHARES) continue;
        
        const spend = (shares * opp.effectiveCost).toFixed(2);
        const profit = (shares * opp.profitPerShare).toFixed(2);
        
        log("BARB", `⚡ AUTO-EXEC: "${opp.market.slice(0,50)}" — ${shares} shares | YES ask $${opp.yesAsk} + NO ask $${opp.noAsk} = $${opp.askSum.toFixed(4)} | Spend: $${spend} | Profit: $${profit}`);
        
        try {
          // Execute via arb endpoint (FOK both legs, auto-unwind on partial fill)
          const legs = [
            { tokenID: opp.yesToken, price: opp.yesAsk, size: shares, side: "BUY" },
            { tokenID: opp.noToken, price: opp.noAsk, size: shares, side: "BUY" },
          ];
          
          if (opts.httpPost) {
            const arbResult = await opts.httpPost("/arb", { legs });
            log("BARB", `Arb result: ${JSON.stringify(arbResult).slice(0, 300)}`);
            
            if (arbResult.status === "ALL_FILLED") {
              // Tag both legs
              if (opts.tagStrategy) {
                opts.tagStrategy(opp.yesToken, 'arb', { event: opp.market, slug: opp.slug, arbType: 'binary-long' });
                opts.tagStrategy(opp.noToken, 'arb', { event: opp.market, slug: opp.slug, arbType: 'binary-long' });
              }
              
              // Notify
              if (opts.sendTelegramAlert) {
                opts.sendTelegramAlert(
                  `✅ <b>BINARY ARB FILLED</b>\n\n` +
                  `<b>Market:</b> ${opp.market}\n` +
                  `<b>YES ask:</b> $${opp.yesAsk} | <b>NO ask:</b> $${opp.noAsk}\n` +
                  `<b>Cost:</b> $${opp.askSum.toFixed(4)}/share (+ $${opp.totalFees.toFixed(4)} fees)\n` +
                  `<b>Shares:</b> ${shares}\n` +
                  `<b>Spend:</b> $${spend}\n` +
                  `<b>Expected profit:</b> $${profit} (${opp.profitPct}%)\n` +
                  `<b>Resolves:</b> ${opp.hoursToEnd ? opp.hoursToEnd.toFixed(1) + 'h' : 'unknown'}`
                );
              }
              
              // Record as executed
              executedSlugs.add(opp.conditionId);
              try { fs.writeFileSync(BINARY_ARB_EXECUTED_FILE, JSON.stringify([...executedSlugs])); } catch {}
              
            } else if (arbResult.status === "PARTIAL_FILL_UNWOUND") {
              if (opts.sendTelegramAlert) {
                opts.sendTelegramAlert(`⚠️ <b>BINARY ARB PARTIAL</b> (unwound)\n${opp.market}\nOne leg didn't fill — position unwound`);
              }
            } else {
              log("BARB", `❌ Arb failed: ${arbResult.status || 'unknown'}`);
            }
          }
        } catch (e) {
          log("BARB", `❌ Execution failed: ${e.message}`);
        }
        
        break; // only execute 1 arb per cycle
      }
    }
    
    return results;
    
  } catch (e) {
    log("BARB", `❌ Binary arb scan failed: ${e.message}`);
    return { error: e.message };
  }
}

module.exports = { runBinaryArbScan, getBookPrices, BINARY_ARB_RESULTS_FILE };
