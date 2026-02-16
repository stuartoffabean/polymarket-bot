#!/usr/bin/env node
/**
 * backtest-weather.js — Validate weather v2 paper trades against actual orderbook history
 * 
 * For each resolved paper trade:
 * 1. Pull historical orderbook at trade timestamp
 * 2. Check what we'd actually fill at (not just mid price)
 * 3. Compare paper P&L vs realistic P&L with slippage
 * 4. Generate validation report
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const PAPER_FILE = path.join(__dirname, 'weather-v2-paper.json');
const REPORT_FILE = path.join(__dirname, 'weather-v2-backtest.json');

function httpGet(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getOrderbookHistory(assetId, timestampMs, windowMs = 60000) {
  const startTs = timestampMs - windowMs;
  const endTs = timestampMs + windowMs;
  const url = `https://clob.polymarket.com/orderbook-history?asset_id=${encodeURIComponent(assetId)}&startTs=${startTs}&endTs=${endTs}&limit=5&offset=0`;
  
  try {
    const resp = await httpGet(url);
    const parsed = JSON.parse(resp.data);
    return parsed.data || [];
  } catch (e) {
    console.error(`  ⚠️ Failed to fetch orderbook for ${assetId.slice(0, 20)}:`, e.message);
    return [];
  }
}

function simulateFill(book, side, size) {
  // Walk the book to simulate a fill
  // BUY → walk asks (ascending price), SELL → walk bids (descending price)
  const levels = side === 'BUY' 
    ? (book.asks || []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price))
    : (book.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
  
  let remaining = size;
  let totalCost = 0;
  let filled = 0;

  for (const level of levels) {
    const price = parseFloat(level.price);
    const available = parseFloat(level.size);
    const take = Math.min(remaining, available);
    
    totalCost += take * price;
    filled += take;
    remaining -= take;
    
    if (remaining <= 0) break;
  }

  return {
    filled,
    avgPrice: filled > 0 ? totalCost / filled : null,
    totalCost,
    fullyFilled: remaining <= 0,
    slippage: null, // calculated later vs paper price
  };
}

async function run() {
  console.log('📊 Weather V2 Backtest — Validating paper trades against orderbook history\n');
  
  const paper = JSON.parse(fs.readFileSync(PAPER_FILE, 'utf8'));
  const trades = paper.paperTrades || [];
  
  const resolved = trades.filter(t => t.resolution);
  const unresolved = trades.filter(t => !t.resolution);
  
  console.log(`Total paper trades: ${trades.length}`);
  console.log(`Resolved: ${resolved.length} | Unresolved: ${unresolved.length}\n`);

  const results = [];
  let wins = 0, losses = 0;
  let totalPaperPnl = 0, totalRealPnl = 0;
  let fetchErrors = 0;

  // Default position size for simulation ($10 per trade)
  const SIM_CAPITAL_PER_TRADE = 10;

  for (let i = 0; i < resolved.length; i++) {
    const trade = resolved[i];
    const ts = new Date(trade.timestamp).getTime();
    const tokenId = trade.action === 'BUY_YES' ? trade.yesToken : trade.noToken;
    
    process.stdout.write(`[${i + 1}/${resolved.length}] ${trade.city} ${trade.bucket}${trade.unit} ${trade.action}...`);

    // Rate limit: 200ms between requests
    if (i > 0) await new Promise(r => setTimeout(r, 200));

    const snapshots = await getOrderbookHistory(tokenId, ts, 300000); // 5 min window
    
    if (snapshots.length === 0) {
      fetchErrors++;
      console.log(' ⚠️ no orderbook data');
      results.push({ ...trade, backtest: { status: 'NO_DATA' } });
      continue;
    }

    // Use closest snapshot to trade time
    const closest = snapshots.reduce((best, s) => {
      const diff = Math.abs(parseInt(s.timestamp) - ts);
      return diff < best.diff ? { snap: s, diff } : best;
    }, { snap: snapshots[0], diff: Infinity });

    const book = closest.snap;
    const side = trade.action === 'BUY_YES' ? 'BUY' : 'BUY'; // both are buying (YES or NO token)
    
    // Calculate how many shares $10 would buy at paper price
    const paperShares = Math.floor(SIM_CAPITAL_PER_TRADE / trade.marketPrice);
    
    // Simulate fill on actual orderbook
    const fill = simulateFill(book, 'BUY', paperShares);
    
    // P&L calculation
    const won = trade.resolution === 'WIN';
    const paperPnl = won ? (1 - trade.marketPrice) * paperShares : -trade.marketPrice * paperShares;
    const realPnl = fill.filled > 0 
      ? (won ? (1 - fill.avgPrice) * fill.filled : -fill.avgPrice * fill.filled)
      : 0;

    totalPaperPnl += paperPnl;
    totalRealPnl += realPnl;
    if (won) wins++; else losses++;

    const slippage = fill.avgPrice ? ((fill.avgPrice - trade.marketPrice) / trade.marketPrice * 100).toFixed(1) : 'N/A';
    
    console.log(` ${won ? '✅' : '❌'} paper: $${paperPnl.toFixed(2)} | real: $${realPnl.toFixed(2)} | slip: ${slippage}%`);

    results.push({
      city: trade.city,
      date: trade.date,
      bucket: trade.bucket,
      unit: trade.unit,
      action: trade.action,
      resolution: trade.resolution,
      marketPrice: trade.marketPrice,
      forecastProb: trade.forecastProb,
      edge: trade.edge,
      actualTemp: trade.actualTemp,
      backtest: {
        status: 'OK',
        bookLevels: (book.asks || []).length + (book.bids || []).length,
        paperShares,
        paperAvgPrice: trade.marketPrice,
        realAvgPrice: fill.avgPrice,
        realFilled: fill.filled,
        fullyFilled: fill.fullyFilled,
        slippagePct: slippage,
        paperPnl: parseFloat(paperPnl.toFixed(4)),
        realPnl: parseFloat(realPnl.toFixed(4)),
      }
    });
  }

  // Summary
  const summary = {
    timestamp: new Date().toISOString(),
    simCapitalPerTrade: SIM_CAPITAL_PER_TRADE,
    totalResolved: resolved.length,
    wins,
    losses,
    winRate: resolved.length > 0 ? (wins / resolved.length * 100).toFixed(1) + '%' : 'N/A',
    totalPaperPnl: parseFloat(totalPaperPnl.toFixed(2)),
    totalRealPnl: parseFloat(totalRealPnl.toFixed(2)),
    slippageImpact: parseFloat((totalPaperPnl - totalRealPnl).toFixed(2)),
    fetchErrors,
    unresolved: unresolved.length,
  };

  console.log('\n═══════════════════════════════════════');
  console.log('📊 BACKTEST SUMMARY');
  console.log('═══════════════════════════════════════');
  console.log(`Win rate: ${summary.winRate} (${wins}W / ${losses}L)`);
  console.log(`Paper P&L: $${summary.totalPaperPnl} ($${SIM_CAPITAL_PER_TRADE}/trade)`);
  console.log(`Real P&L (with slippage): $${summary.totalRealPnl}`);
  console.log(`Slippage impact: $${summary.slippageImpact}`);
  console.log(`Fetch errors: ${fetchErrors}`);
  console.log(`Unresolved (pending): ${unresolved.length}`);
  console.log('═══════════════════════════════════════\n');

  const report = { summary, trades: results };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`💾 Full report saved to ${REPORT_FILE}`);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
