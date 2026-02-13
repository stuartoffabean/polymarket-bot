/**
 * crypto-15min-scanner.js — 15-Minute Crypto Market Discovery
 * 
 * Inspired by dr-manhattan's findCryptoHourlyMarket() but built on our working CLOB client.
 * Scans for BTC/ETH binary markets resolving in <1 hour (15-min timeframe).
 * 
 * Strategy: High capital velocity (15min resolution) + exchange price feed signal
 */

import { ClobClient } from '@polymarket/clob-client';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read-only CLOB client (no auth needed for market data)
const clob = new ClobClient('https://clob.polymarket.com', 137);

/**
 * Search for active 15-minute crypto binary markets
 * @param {string} asset - 'BTC', 'ETH', 'SOL'
 * @returns {Promise<Array>}
 */
async function find15MinCryptoMarkets(asset = 'BTC') {
  try {
    // Gamma API: search for crypto markets
    const searchQuery = `${asset} up down`;
    const gammaRes = await fetch(`https://gamma-api.polymarket.com/events?tag=crypto&active=true&limit=100`);
    
    if (!gammaRes.ok) {
      throw new Error(`Gamma API error: ${gammaRes.status}`);
    }

    const events = await gammaRes.json();
    const now = Date.now();
    const oneHourFromNow = now + (60 * 60 * 1000);

    const markets = [];

    for (const event of events) {
      // Filter for markets containing asset name and "Up or Down"
      if (!event.title?.includes(asset) || !event.title?.includes('Up or Down')) {
        continue;
      }

      // Check if resolving within 1 hour
      const endTime = new Date(event.endDate).getTime();
      if (endTime > oneHourFromNow || endTime < now) {
        continue;
      }

      // Get market details from CLOB
      for (const market of event.markets || []) {
        const conditionId = market.conditionId;
        if (!conditionId) continue;

        try {
          const book = await clob.getOrderBook(conditionId);
          
          // Calculate mid prices
          const yesAsset = book.asset_id || book.market;
          const yesBids = book.bids || [];
          const yesAsks = book.asks || [];
          
          const bestBid = yesBids.length > 0 ? parseFloat(yesBids[0].price) : 0;
          const bestAsk = yesAsks.length > 0 ? parseFloat(yesAsks[0].price) : 1;
          const midPrice = (bestBid + bestAsk) / 2;
          const spread = bestAsk - bestBid;

          // Calculate total liquidity (top 3 levels each side)
          const bidLiquidity = yesBids.slice(0, 3).reduce((sum, o) => sum + parseFloat(o.size), 0);
          const askLiquidity = yesAsks.slice(0, 3).reduce((sum, o) => sum + parseFloat(o.size), 0);
          const totalLiquidity = (bidLiquidity + askLiquidity) * midPrice;

          markets.push({
            asset,
            title: event.title,
            slug: event.slug,
            conditionId,
            yesTokenId: yesAsset,
            endDate: event.endDate,
            minutesRemaining: Math.round((endTime - now) / 60000),
            yesPrice: midPrice,
            noPrice: 1 - midPrice,
            bestBid,
            bestAsk,
            spread,
            liquidity: totalLiquidity.toFixed(2),
            volume24h: market.volume24hr || 0
          });

          // Rate limit
          await new Promise(resolve => setTimeout(resolve, 100));

        } catch (bookError) {
          // Skip markets with no order book
          continue;
        }
      }
    }

    return markets.sort((a, b) => a.minutesRemaining - b.minutesRemaining);

  } catch (error) {
    console.error(`[CRYPTO-15MIN] Error scanning ${asset} markets:`, error.message);
    return [];
  }
}

/**
 * Scan all major crypto assets for 15-min markets
 * @returns {Promise<Array>}
 */
export async function scanAll15Min() {
  const assets = ['BTC', 'ETH', 'SOL'];
  const allMarkets = [];

  for (const asset of assets) {
    const markets = await find15MinCryptoMarkets(asset);
    allMarkets.push(...markets);
  }

  return allMarkets;
}

/**
 * Get exchange price for signal generation (stub — needs real exchange feed)
 * @param {string} asset
 * @returns {Promise<number>}
 */
async function getExchangePrice(asset) {
  // TODO: Integrate Binance WebSocket or CoinGecko API
  // For now, return null to indicate no signal
  return null;
}

/**
 * Evaluate 15-min market opportunity with exchange price signal
 * @param {Object} market
 * @returns {Promise<Object>}
 */
export async function evaluateOpportunity(market) {
  const exchangePrice = await getExchangePrice(market.asset);
  
  if (!exchangePrice) {
    return {
      ...market,
      signal: 'NO_FEED',
      action: 'SKIP',
      reason: 'Exchange price feed not available'
    };
  }

  // Signal logic: if exchange price is moving up and YES is cheap, that's a BUY signal
  // (This is a simplified example — real strategy needs momentum indicators)
  
  const edgeThreshold = 0.05; // 5¢ edge required
  const maxSpread = 0.03; // 3¢ max spread

  if (market.spread > maxSpread) {
    return {
      ...market,
      exchangePrice,
      signal: 'SKIP',
      action: 'SKIP',
      reason: 'Spread too wide'
    };
  }

  if (market.liquidity < 100) {
    return {
      ...market,
      exchangePrice,
      signal: 'SKIP',
      action: 'SKIP',
      reason: 'Liquidity too low'
    };
  }

  // For now, just return the market data without a trade signal
  return {
    ...market,
    exchangePrice,
    signal: 'MONITOR',
    action: 'RESEARCH',
    reason: 'Exchange feed integration needed for trade signals'
  };
}

/**
 * CLI
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2] || 'scan';

  if (command === 'scan') {
    console.log('[CRYPTO-15MIN] Scanning for active 15-minute markets...\n');
    const markets = await scanAll15Min();
    
    if (markets.length === 0) {
      console.log('No active 15-minute markets found.');
    } else {
      console.log(`Found ${markets.length} active markets:\n`);
      for (const m of markets) {
        console.log(`${m.asset} | ${m.title}`);
        console.log(`  Resolves in: ${m.minutesRemaining} minutes`);
        console.log(`  YES: ${m.yesPrice.toFixed(3)} (bid: ${m.bestBid.toFixed(3)}, ask: ${m.bestAsk.toFixed(3)})`);
        console.log(`  Spread: ${(m.spread * 100).toFixed(2)}% | Liquidity: $${m.liquidity} | Volume 24h: $${m.volume24h.toFixed(0)}`);
        console.log(`  Slug: ${m.slug}\n`);
      }

      // Write to file
      const outputPath = path.join(__dirname, '..', 'crypto-15min-results.json');
      await fs.writeFile(outputPath, JSON.stringify(markets, null, 2));
      console.log(`Results saved to: crypto-15min-results.json`);
    }
  } else {
    console.log(`
crypto-15min-scanner.js — 15-Minute Crypto Market Discovery

Usage:
  node crypto-15min-scanner.js scan

Output: crypto-15min-results.json
    `);
  }

  process.exit(0);
}
