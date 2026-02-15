#!/usr/bin/env node
/**
 * Crypto Tail-Spread Paper Trading System
 * 
 * Scans daily crypto price markets (BTC, ETH, SOL) for tail buckets (d2+ from center).
 * Records order books, simulates $15/day deployment, tracks P&L at resolution.
 * 
 * Usage:
 *   node crypto-tail-paper-trade.js scan     # Scan and record today's tail buckets
 *   node crypto-tail-paper-trade.js resolve   # Check resolved markets and calculate P&L
 *   node crypto-tail-paper-trade.js status    # Show current paper trade status
 *   node crypto-tail-paper-trade.js history   # Show all historical data
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'paper-trade-data.json');
const DAILY_BUDGET = 15.00; // $15/day deployment
const ASSETS = ['bitcoin', 'ethereum', 'solana'];
const ASSET_BUDGET = { bitcoin: 7.50, ethereum: 4.50, solana: 3.00 }; // Weighted by backtest ROI

function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : require('http');
    client.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`JSON parse error for ${url}: ${data.substring(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { scans: [], trades: [], resolved: [], summary: {} }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/**
 * Determine center bucket index given current price and bucket ranges.
 * Returns the index of the bucket containing the current price.
 */
function findCenterBucket(buckets, currentPrice) {
  for (let i = 0; i < buckets.length; i++) {
    if (currentPrice >= buckets[i].low && currentPrice < buckets[i].high) return i;
    if (buckets[i].isExtreme && buckets[i].side === 'high' && currentPrice >= buckets[i].low) return i;
    if (buckets[i].isExtreme && buckets[i].side === 'low' && currentPrice < buckets[i].high) return i;
  }
  return Math.floor(buckets.length / 2); // fallback
}

/**
 * Parse bucket ranges from market questions
 */
function parseBucket(question) {
  // "Will the price of Bitcoin be between $62,000 and $64,000 on February 16?"
  const betweenMatch = question.match(/between \$([\d,]+(?:\.\d+)?)\s+and\s+\$([\d,]+(?:\.\d+)?)/i);
  if (betweenMatch) {
    return {
      low: parseFloat(betweenMatch[1].replace(/,/g, '')),
      high: parseFloat(betweenMatch[2].replace(/,/g, '')),
      isExtreme: false
    };
  }
  // "Will the price of Bitcoin be less than $62,000?"
  const lessMatch = question.match(/less than \$([\d,]+(?:\.\d+)?)/i);
  if (lessMatch) {
    return {
      low: 0,
      high: parseFloat(lessMatch[1].replace(/,/g, '')),
      isExtreme: true,
      side: 'low'
    };
  }
  // "Will the price of Bitcoin be greater than $80,000?"
  const greaterMatch = question.match(/greater than \$([\d,]+(?:\.\d+)?)/i);
  if (greaterMatch) {
    return {
      low: parseFloat(greaterMatch[1].replace(/,/g, '')),
      high: Infinity,
      isExtreme: true,
      side: 'high'
    };
  }
  return null;
}

/**
 * Get current crypto prices
 */
async function getCurrentPrices() {
  try {
    const data = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd');
    return {
      bitcoin: data.bitcoin?.usd,
      ethereum: data.ethereum?.usd,
      solana: data.solana?.usd
    };
  } catch(e) {
    console.error('Failed to get prices from CoinGecko:', e.message);
    return null;
  }
}

/**
 * Get order book for a token via CLOB API
 */
async function getOrderBook(tokenId) {
  try {
    const book = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    return book;
  } catch(e) {
    return { asks: [], bids: [] };
  }
}

/**
 * SCAN: Find all upcoming daily crypto price markets, identify tail buckets,
 * record order books, and determine paper trade entries.
 */
async function scan() {
  console.log('🔍 CRYPTO TAIL-SPREAD PAPER TRADE SCANNER');
  console.log('=========================================');
  console.log(`Deployment: $${DAILY_BUDGET}/day | Assets: BTC, ETH, SOL`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const prices = await getCurrentPrices();
  if (!prices) {
    console.error('❌ Cannot get current prices. Aborting.');
    return;
  }
  console.log('Current prices:');
  console.log(`  BTC: $${prices.bitcoin?.toLocaleString()}`);
  console.log(`  ETH: $${prices.ethereum?.toLocaleString()}`);
  console.log(`  SOL: $${prices.solana?.toLocaleString()}\n`);

  const data = loadData();
  const scanTime = new Date().toISOString();
  const scanResult = {
    timestamp: scanTime,
    prices,
    markets: {}
  };

  // Find markets for the next 5 resolution dates
  const today = new Date();
  const dates = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + i);
    const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
    const day = d.getUTCDate();
    dates.push({ dateStr: `${month}-${day}`, label: `${month.charAt(0).toUpperCase() + month.slice(1)} ${day}`, date: d.toISOString().split('T')[0] });
  }

  for (const asset of ASSETS) {
    console.log(`\n📊 ${asset.toUpperCase()}`);
    console.log('─'.repeat(60));
    
    let foundMarket = false;
    
    for (const dateInfo of dates) {
      const slug = `${asset}-price-on-${dateInfo.dateStr}`;
      let ev;
      try {
        ev = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
      } catch(e) { continue; }
      
      if (!ev || ev.length === 0) continue;
      
      const event = ev[0];
      const endDate = event.endDate;
      const hoursToResolution = (new Date(endDate) - new Date()) / 3600000;
      
      // Only paper trade markets resolving in 12-48 hours (optimal window)
      // But record ALL for data collection
      console.log(`  📅 ${dateInfo.label} (resolves in ${hoursToResolution.toFixed(1)}h)`);
      
      const markets = event.markets || [];
      const buckets = [];
      
      for (const m of markets) {
        const range = parseBucket(m.question);
        if (!range) continue;
        
        // Get token IDs from CLOB
        let clobMarket;
        try {
          clobMarket = await fetch(`https://clob.polymarket.com/markets/${m.conditionId}`);
        } catch(e) { continue; }
        
        const yesToken = clobMarket.tokens?.find(t => t.outcome === 'Yes');
        const noToken = clobMarket.tokens?.find(t => t.outcome === 'No');
        
        if (!yesToken) continue;
        
        // Get order book
        const book = await getOrderBook(yesToken.token_id);
        const bestAsk = book.asks?.length > 0 ? parseFloat(book.asks[0].price) : null;
        const bestAskSize = book.asks?.length > 0 ? parseFloat(book.asks[0].size) : 0;
        const totalAskDepth = (book.asks || []).reduce((sum, a) => sum + parseFloat(a.size), 0);
        
        // Calculate depth at best ask (total shares available within 0.5¢ of best ask)
        const depthNearBest = (book.asks || [])
          .filter(a => parseFloat(a.price) <= (bestAsk || 0) + 0.005)
          .reduce((sum, a) => sum + parseFloat(a.size), 0);
        
        buckets.push({
          question: m.question,
          conditionId: m.conditionId,
          tokenId: yesToken.token_id,
          range,
          bestAsk,
          bestAskSize,
          depthNearBest,
          totalAskDepth,
          currentPrice: yesToken.price,
          fullBook: {
            asks: (book.asks || []).slice(0, 5).map(a => ({ p: parseFloat(a.price), s: parseFloat(a.size) })),
            bids: (book.bids || []).slice(0, 3).map(b => ({ p: parseFloat(b.price), s: parseFloat(b.size) }))
          }
        });
      }
      
      // Sort buckets by range
      buckets.sort((a, b) => a.range.low - b.range.low);
      
      // Find center bucket
      const currentPrice = prices[asset];
      const centerIdx = findCenterBucket(buckets, currentPrice);
      
      // Mark distance from center
      for (let i = 0; i < buckets.length; i++) {
        buckets[i].distanceFromCenter = Math.abs(i - centerIdx);
        buckets[i].side = i < centerIdx ? 'left' : (i > centerIdx ? 'right' : 'center');
        buckets[i].isTail = buckets[i].distanceFromCenter >= 2;
      }
      
      // Display all buckets with tail markers
      for (const b of buckets) {
        const marker = b.isTail ? '🎯' : (b.distanceFromCenter === 1 ? '  ' : '📍');
        const askStr = b.bestAsk ? `${(b.bestAsk * 100).toFixed(1)}¢` : 'no ask';
        const depthStr = b.depthNearBest > 0 ? `${b.depthNearBest.toFixed(0)} sh` : '-';
        const rangeStr = b.range.isExtreme 
          ? (b.range.side === 'low' ? `<$${b.range.high.toLocaleString()}` : `>$${b.range.low.toLocaleString()}`)
          : `$${b.range.low.toLocaleString()}-${b.range.high.toLocaleString()}`;
        console.log(`    ${marker} d${b.distanceFromCenter}${b.side[0].toUpperCase()} ${rangeStr.padEnd(20)} ask: ${askStr.padEnd(8)} depth: ${depthStr.padEnd(10)} [${b.conditionId.substring(0,10)}]`);
      }
      
      // Determine paper trade entries for tail buckets
      const tailBuckets = buckets.filter(b => b.isTail && b.bestAsk && b.bestAsk <= 0.10);
      const budget = ASSET_BUDGET[asset];
      
      if (tailBuckets.length > 0) {
        const perBucket = budget / tailBuckets.length;
        console.log(`\n    📝 PAPER TRADE: $${budget.toFixed(2)} across ${tailBuckets.length} tail buckets ($${perBucket.toFixed(2)} each)`);
        
        for (const tb of tailBuckets) {
          const shares = Math.floor(perBucket / tb.bestAsk);
          const cost = shares * tb.bestAsk;
          const rangeStr = tb.range.isExtreme 
            ? (tb.range.side === 'low' ? `<$${tb.range.high.toLocaleString()}` : `>$${tb.range.low.toLocaleString()}`)
            : `$${tb.range.low.toLocaleString()}-${tb.range.high.toLocaleString()}`;
          
          tb.paperTrade = {
            shares,
            cost,
            entryPrice: tb.bestAsk,
            entryTime: scanTime
          };
          
          console.log(`      BUY ${shares} sh @ ${(tb.bestAsk * 100).toFixed(1)}¢ = $${cost.toFixed(2)} | ${rangeStr} (d${tb.distanceFromCenter}${tb.side[0].toUpperCase()})`);
        }
      } else {
        console.log(`\n    ⚠️ No tail buckets with asks ≤ 10¢ found`);
      }
      
      // Save to scan result
      const marketKey = `${asset}-${dateInfo.date}`;
      scanResult.markets[marketKey] = {
        asset,
        date: dateInfo.date,
        label: dateInfo.label,
        endDate,
        hoursToResolution,
        currentPrice,
        centerIdx,
        buckets: buckets.map(b => ({
          ...b,
          fullBook: undefined // Don't save full book to keep file size manageable
        })),
        tailBuckets: buckets.filter(b => b.isTail).map(b => ({
          question: b.question,
          conditionId: b.conditionId,
          tokenId: b.tokenId,
          range: b.range,
          distanceFromCenter: b.distanceFromCenter,
          side: b.side,
          bestAsk: b.bestAsk,
          bestAskSize: b.bestAskSize,
          depthNearBest: b.depthNearBest,
          paperTrade: b.paperTrade || null
        }))
      };
      
      foundMarket = true;
      break; // Only scan the nearest resolution date per asset
    }
    
    if (!foundMarket) {
      console.log('  ❌ No active markets found');
    }
  }

  // Save scan
  data.scans.push(scanResult);
  
  // Create/update paper trade entries
  for (const [key, market] of Object.entries(scanResult.markets)) {
    for (const tb of market.tailBuckets) {
      if (tb.paperTrade) {
        const tradeId = `${key}-${tb.conditionId.substring(0, 10)}`;
        // Don't duplicate
        if (!data.trades.find(t => t.id === tradeId)) {
          data.trades.push({
            id: tradeId,
            asset: market.asset,
            date: market.date,
            endDate: market.endDate,
            question: tb.question,
            conditionId: tb.conditionId,
            tokenId: tb.tokenId,
            range: tb.range,
            distanceFromCenter: tb.distanceFromCenter,
            side: tb.side,
            entryPrice: tb.paperTrade.entryPrice,
            shares: tb.paperTrade.shares,
            cost: tb.paperTrade.cost,
            entryTime: scanTime,
            status: 'OPEN',
            resolution: null
          });
        }
      }
    }
  }
  
  saveData(data);
  
  console.log('\n\n✅ Scan complete. Data saved to paper-trade-data.json');
  console.log(`Total open paper trades: ${data.trades.filter(t => t.status === 'OPEN').length}`);
}

/**
 * RESOLVE: Check which markets have resolved and calculate P&L
 */
async function resolve() {
  console.log('📊 CHECKING RESOLUTIONS');
  console.log('========================\n');
  
  const data = loadData();
  const openTrades = data.trades.filter(t => t.status === 'OPEN');
  
  if (openTrades.length === 0) {
    console.log('No open trades to check.');
    return;
  }
  
  console.log(`Checking ${openTrades.length} open paper trades...\n`);
  
  for (const trade of openTrades) {
    const now = new Date();
    const end = new Date(trade.endDate);
    
    if (now < end) {
      const hoursLeft = (end - now) / 3600000;
      console.log(`⏳ ${trade.question} — ${hoursLeft.toFixed(1)}h remaining`);
      continue;
    }
    
    // Market should be resolved — check via CLOB
    try {
      const market = await fetch(`https://clob.polymarket.com/markets/${trade.conditionId}`);
      const yesToken = market.tokens?.find(t => t.outcome === 'Yes');
      
      if (yesToken?.winner) {
        trade.status = 'WON';
        trade.payout = trade.shares * 1.00;
        trade.profit = trade.payout - trade.cost;
        trade.profitPct = ((trade.profit / trade.cost) * 100).toFixed(1);
        console.log(`✅ WON: ${trade.question}`);
        console.log(`   ${trade.shares} sh @ ${(trade.entryPrice*100).toFixed(1)}¢ → $${trade.payout.toFixed(2)} payout | +$${trade.profit.toFixed(2)} (+${trade.profitPct}%)`);
      } else if (market.closed) {
        trade.status = 'LOST';
        trade.payout = 0;
        trade.profit = -trade.cost;
        trade.profitPct = '-100';
        console.log(`❌ LOST: ${trade.question}`);
        console.log(`   ${trade.shares} sh @ ${(trade.entryPrice*100).toFixed(1)}¢ → $0 | -$${trade.cost.toFixed(2)}`);
      } else {
        console.log(`⏳ ${trade.question} — past end date but not yet resolved on-chain`);
      }
    } catch(e) {
      console.log(`⚠️ Error checking ${trade.conditionId}: ${e.message}`);
    }
  }
  
  saveData(data);
  printSummary(data);
}

/**
 * STATUS: Show current paper trade portfolio
 */
async function status() {
  const data = loadData();
  
  console.log('📋 PAPER TRADE STATUS');
  console.log('=====================\n');
  
  const open = data.trades.filter(t => t.status === 'OPEN');
  const won = data.trades.filter(t => t.status === 'WON');
  const lost = data.trades.filter(t => t.status === 'LOST');
  
  console.log(`Open trades: ${open.length}`);
  console.log(`Resolved: ${won.length + lost.length} (${won.length} won, ${lost.length} lost)`);
  
  if (open.length > 0) {
    console.log('\n--- OPEN POSITIONS ---');
    for (const t of open) {
      const hoursLeft = (new Date(t.endDate) - new Date()) / 3600000;
      const rangeStr = t.range?.isExtreme 
        ? (t.range.side === 'low' ? `<$${t.range.high}` : `>$${t.range.low}`)
        : `$${t.range?.low}-${t.range?.high}`;
      console.log(`  ${t.asset.toUpperCase()} ${rangeStr} (d${t.distanceFromCenter}${t.side[0].toUpperCase()}) | ${t.shares}sh @ ${(t.entryPrice*100).toFixed(1)}¢ = $${t.cost.toFixed(2)} | ${hoursLeft.toFixed(0)}h left`);
    }
  }
  
  printSummary(data);
}

function printSummary(data) {
  const won = data.trades.filter(t => t.status === 'WON');
  const lost = data.trades.filter(t => t.status === 'LOST');
  const resolved = [...won, ...lost];
  
  if (resolved.length === 0) {
    console.log('\nNo resolved trades yet.');
    return;
  }
  
  const totalCost = resolved.reduce((s, t) => s + t.cost, 0);
  const totalPayout = resolved.reduce((s, t) => s + (t.payout || 0), 0);
  const totalProfit = totalPayout - totalCost;
  const winRate = (won.length / resolved.length * 100).toFixed(1);
  
  // Per-asset breakdown
  const byAsset = {};
  for (const t of resolved) {
    if (!byAsset[t.asset]) byAsset[t.asset] = { won: 0, lost: 0, cost: 0, payout: 0 };
    byAsset[t.asset][t.status === 'WON' ? 'won' : 'lost']++;
    byAsset[t.asset].cost += t.cost;
    byAsset[t.asset].payout += (t.payout || 0);
  }
  
  // Per-day breakdown
  const byDate = {};
  for (const t of resolved) {
    if (!byDate[t.date]) byDate[t.date] = { cost: 0, payout: 0, won: 0, lost: 0 };
    byDate[t.date][t.status === 'WON' ? 'won' : 'lost']++;
    byDate[t.date].cost += t.cost;
    byDate[t.date].payout += (t.payout || 0);
  }
  
  console.log('\n\n📈 PAPER TRADE SUMMARY');
  console.log('======================');
  console.log(`Total resolved: ${resolved.length} trades`);
  console.log(`Win rate: ${winRate}% (${won.length}W / ${lost.length}L)`);
  console.log(`Total cost: $${totalCost.toFixed(2)}`);
  console.log(`Total payout: $${totalPayout.toFixed(2)}`);
  console.log(`Net P&L: ${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)} (${((totalProfit/totalCost)*100).toFixed(1)}% ROI)`);
  
  console.log('\nPer-Asset:');
  for (const [asset, stats] of Object.entries(byAsset)) {
    const profit = stats.payout - stats.cost;
    console.log(`  ${asset.toUpperCase()}: ${stats.won}W/${stats.lost}L | cost $${stats.cost.toFixed(2)} → payout $${stats.payout.toFixed(2)} | ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
  }
  
  console.log('\nPer-Day:');
  for (const [date, stats] of Object.entries(byDate).sort()) {
    const profit = stats.payout - stats.cost;
    console.log(`  ${date}: ${stats.won}W/${stats.lost}L | cost $${stats.cost.toFixed(2)} → ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
  }
  
  // Target check: 15 market-days minimum
  const marketDays = Object.keys(byDate).length * 3; // approximate (3 assets per day)
  console.log(`\n📊 Market-days completed: ${resolved.length} trades / target: 15+ market-days`);
  if (resolved.length >= 15) {
    console.log('✅ MINIMUM DATA THRESHOLD MET — ready for go/no-go decision');
  } else {
    console.log(`⏳ Need ${15 - resolved.length} more resolved trades before go/no-go`);
  }
}

/**
 * HISTORY: Show all scans and trades
 */
function history() {
  const data = loadData();
  console.log('📚 FULL HISTORY');
  console.log('================\n');
  console.log(`Total scans: ${data.scans.length}`);
  console.log(`Total trades: ${data.trades.length}`);
  
  for (const t of data.trades) {
    const statusIcon = t.status === 'WON' ? '✅' : (t.status === 'LOST' ? '❌' : '⏳');
    const profitStr = t.profit !== null && t.profit !== undefined ? ` | ${t.profit >= 0 ? '+' : ''}$${t.profit.toFixed(2)}` : '';
    console.log(`  ${statusIcon} [${t.date}] ${t.asset.toUpperCase()} d${t.distanceFromCenter}${t.side[0].toUpperCase()} | ${t.shares}sh @ ${(t.entryPrice*100).toFixed(1)}¢ = $${t.cost.toFixed(2)}${profitStr}`);
  }
}

// CLI
const cmd = process.argv[2] || 'scan';
switch(cmd) {
  case 'scan': scan().catch(console.error); break;
  case 'resolve': resolve().catch(console.error); break;
  case 'status': status().catch(console.error); break;
  case 'history': history().catch(console.error); break;
  default: console.log('Usage: node crypto-tail-paper-trade.js [scan|resolve|status|history]');
}
