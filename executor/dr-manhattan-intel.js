/**
 * dr-manhattan-intel.js — Cross-Platform Market Intelligence Module
 * 
 * Uses @alango/dr-manhattan for:
 * - 15-minute crypto market discovery
 * - Cross-platform price comparison (Kalshi, Limitless)
 * - Market research and opportunity scanning
 * 
 * Does NOT replace executor/ws-feed — this is a complementary research tool.
 */

import { Polymarket, Kalshi, MarketUtils } from '@alango/dr-manhattan';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read-only instances (no auth required for market data)
const polymarket = new Polymarket();
const kalshi = new Kalshi({ demo: true }); // Read-only mode

/**
 * Find active 15-minute crypto binary markets
 * @param {string} asset - 'BTC' or 'ETH'
 * @param {string} direction - 'higher' or 'lower'
 * @returns {Promise<Object|null>}
 */
export async function findCryptoHourlyMarket(asset, direction) {
  try {
    const market = await polymarket.findCryptoHourlyMarket(asset, direction);
    if (!market) return null;

    return {
      slug: market.slug,
      question: market.question,
      tokenId: market.outcomes?.[0]?.tokenId || market.outcomes?.[1]?.tokenId,
      yesPrice: market.outcomes?.find(o => o.outcome === 'Yes')?.price,
      noPrice: market.outcomes?.find(o => o.outcome === 'No')?.price,
      endDate: market.endDate,
      volume: market.volume,
      liquidity: market.liquidity,
      spread: MarketUtils.spread(market),
      isBinary: MarketUtils.isBinary(market)
    };
  } catch (error) {
    console.error(`[DR-MANHATTAN] Error finding ${asset} ${direction} market:`, error.message);
    return null;
  }
}

/**
 * Scan for active 15-minute crypto markets (BTC/ETH, both directions)
 * @returns {Promise<Array>}
 */
export async function scanCrypto15Min() {
  const results = [];
  
  for (const asset of ['BTC', 'ETH']) {
    for (const direction of ['higher', 'lower']) {
      const market = await findCryptoHourlyMarket(asset, direction);
      if (market) {
        results.push({ asset, direction, ...market });
      }
      // Rate limit: 100ms between requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}

/**
 * Search Polymarket markets by keyword (uses dr-manhattan's helper)
 * @param {string} keyword
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function searchMarkets(keyword, limit = 10) {
  try {
    const markets = await polymarket.searchMarkets(keyword);
    return markets.slice(0, limit).map(m => ({
      slug: m.slug,
      question: m.question,
      volume: m.volume,
      liquidity: m.liquidity,
      endDate: m.endDate,
      binary: MarketUtils.isBinary(m),
      spread: MarketUtils.spread(m),
      outcomes: m.outcomes?.map(o => ({
        outcome: o.outcome,
        price: o.price,
        tokenId: o.tokenId
      }))
    }));
  } catch (error) {
    console.error(`[DR-MANHATTAN] searchMarkets error:`, error.message);
    return [];
  }
}

/**
 * Compare a Polymarket market with Kalshi (if matching market exists)
 * Uses dr-manhattan's unified API to fetch from both platforms
 * @param {string} polymarketSlug
 * @returns {Promise<Object>}
 */
export async function compareWithKalshi(polymarketSlug) {
  try {
    const polyMarket = await polymarket.fetchMarket(polymarketSlug);
    
    // Search Kalshi for similar markets (keyword-based)
    const searchTerms = polyMarket.question.split(' ').slice(0, 3).join(' ');
    const kalshiMarkets = await kalshi.fetchMarkets({ search: searchTerms, limit: 5 });

    return {
      polymarket: {
        slug: polyMarket.slug,
        question: polyMarket.question,
        yesPrice: polyMarket.outcomes?.find(o => o.outcome === 'Yes')?.price,
        noPrice: polyMarket.outcomes?.find(o => o.outcome === 'No')?.price,
        volume: polyMarket.volume
      },
      kalshi: kalshiMarkets.map(k => ({
        marketId: k.marketId,
        question: k.question,
        yesPrice: k.outcomes?.find(o => o.outcome === 'Yes')?.price,
        noPrice: k.outcomes?.find(o => o.outcome === 'No')?.price,
        volume: k.volume
      }))
    };
  } catch (error) {
    console.error(`[DR-MANHATTAN] compareWithKalshi error:`, error.message);
    return { error: error.message };
  }
}

/**
 * Fetch high-volume tradeable markets
 * @param {number} minVolume
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function findTradeableMarkets(minVolume = 10000, limit = 20) {
  try {
    const markets = await polymarket.fetchMarkets({ limit: 100 });
    
    return markets
      .filter(m => m.volume >= minVolume && MarketUtils.isBinary(m))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, limit)
      .map(m => ({
        slug: m.slug,
        question: m.question,
        volume: m.volume,
        liquidity: m.liquidity,
        yesPrice: m.outcomes?.find(o => o.outcome === 'Yes')?.price,
        noPrice: m.outcomes?.find(o => o.outcome === 'No')?.price,
        spread: MarketUtils.spread(m),
        endDate: m.endDate
      }));
  } catch (error) {
    console.error(`[DR-MANHATTAN] findTradeableMarkets error:`, error.message);
    return [];
  }
}

/**
 * CLI for testing dr-manhattan integration
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];

  switch (command) {
    case 'crypto15':
      console.log('[DR-MANHATTAN] Scanning 15-min crypto markets...');
      const crypto = await scanCrypto15Min();
      console.log(JSON.stringify(crypto, null, 2));
      break;

    case 'search':
      const keyword = process.argv[3];
      if (!keyword) {
        console.error('Usage: node dr-manhattan-intel.js search <keyword>');
        process.exit(1);
      }
      console.log(`[DR-MANHATTAN] Searching for: ${keyword}`);
      const results = await searchMarkets(keyword, 5);
      console.log(JSON.stringify(results, null, 2));
      break;

    case 'tradeable':
      console.log('[DR-MANHATTAN] Finding high-volume tradeable markets...');
      const tradeable = await findTradeableMarkets(50000, 10);
      console.log(JSON.stringify(tradeable, null, 2));
      break;

    case 'compare':
      const slug = process.argv[3];
      if (!slug) {
        console.error('Usage: node dr-manhattan-intel.js compare <polymarket-slug>');
        process.exit(1);
      }
      console.log(`[DR-MANHATTAN] Comparing with Kalshi: ${slug}`);
      const comparison = await compareWithKalshi(slug);
      console.log(JSON.stringify(comparison, null, 2));
      break;

    default:
      console.log(`
dr-manhattan-intel.js — Market Intelligence CLI

Commands:
  crypto15                  Scan active 15-min BTC/ETH markets
  search <keyword>          Search Polymarket by keyword
  tradeable                 Find high-volume tradeable markets
  compare <slug>            Compare Polymarket market with Kalshi

Examples:
  node dr-manhattan-intel.js crypto15
  node dr-manhattan-intel.js search "bitcoin 100k"
  node dr-manhattan-intel.js tradeable
  node dr-manhattan-intel.js compare will-trump-win-2024
      `);
  }

  process.exit(0);
}
