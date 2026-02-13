#!/usr/bin/env node
/**
 * Fetches complete trade history from Polymarket data-api via proxy
 * and builds trade-history.json with full P&L for closed positions.
 * 
 * Run: node executor/fetch-trade-history.js
 * 
 * Since data-api is 403 from Railway, this needs to be triggered
 * from a context that can reach data-api (e.g., cron with web_fetch,
 * or via the Vercel data-api proxy once deployed).
 * 
 * For now, accepts piped JSON: echo '[...]' | node executor/fetch-trade-history.js
 */

const fs = require('fs');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, '..', 'trade-history.json');

function processActivity(activities) {
  // Group by asset_id
  const positions = {};
  
  for (const t of activities) {
    if (t.type !== 'TRADE') continue;
    const asset = t.asset;
    if (!positions[asset]) {
      positions[asset] = {
        asset_id: asset,
        conditionId: t.conditionId,
        title: t.title || '?',
        outcome: t.outcome || 'Unknown',
        slug: t.slug,
        buys: [],
        sells: [],
        totalBought: 0,
        totalBuyCost: 0,
        totalSold: 0,
        totalSellProceeds: 0,
      };
    }
    
    const qty = parseFloat(t.size);
    const px = parseFloat(t.price);
    const ts = t.timestamp;
    
    if (t.side === 'BUY') {
      positions[asset].totalBought += qty;
      positions[asset].totalBuyCost += qty * px;
      positions[asset].buys.push({ size: qty, price: px, time: ts });
    } else {
      positions[asset].totalSold += qty;
      positions[asset].totalSellProceeds += qty * px;
      positions[asset].sells.push({ size: qty, price: px, time: ts });
    }
  }
  
  const closed = [];
  const open = [];
  let totalRealizedPnl = 0;
  
  for (const p of Object.values(positions)) {
    const remaining = p.totalBought - p.totalSold;
    const avgBuyPrice = p.totalBought > 0 ? p.totalBuyCost / p.totalBought : 0;
    const avgSellPrice = p.totalSold > 0 ? p.totalSellProceeds / p.totalSold : 0;
    
    if (remaining < 0.01) {
      // Closed position
      const pnl = p.totalSellProceeds - p.totalBuyCost;
      totalRealizedPnl += pnl;
      closed.push({
        asset_id: p.asset_id,
        conditionId: p.conditionId,
        title: p.title,
        outcome: p.outcome,
        totalBought: +p.totalBought.toFixed(2),
        totalSold: +p.totalSold.toFixed(2),
        avgBuyPrice: +avgBuyPrice.toFixed(4),
        avgSellPrice: +avgSellPrice.toFixed(4),
        totalCost: +p.totalBuyCost.toFixed(2),
        totalProceeds: +p.totalSellProceeds.toFixed(2),
        realizedPnl: +pnl.toFixed(2),
        realizedPnlPct: p.totalBuyCost > 0 ? +((pnl / p.totalBuyCost) * 100).toFixed(1) : 0,
        firstTrade: Math.min(...p.buys.map(b => b.time), ...p.sells.map(s => s.time)),
        lastTrade: Math.max(...p.buys.map(b => b.time), ...p.sells.map(s => s.time)),
        status: 'CLOSED',
      });
    } else {
      open.push({
        asset_id: p.asset_id,
        conditionId: p.conditionId,
        title: p.title,
        outcome: p.outcome,
        remaining: +remaining.toFixed(2),
        avgBuyPrice: +avgBuyPrice.toFixed(4),
        totalCost: +p.totalBuyCost.toFixed(2),
        partialSellProceeds: +p.totalSellProceeds.toFixed(2),
        status: 'OPEN',
      });
    }
  }
  
  // Sort closed by P&L
  closed.sort((a, b) => a.realizedPnl - b.realizedPnl);
  
  const result = {
    updatedAt: new Date().toISOString(),
    totalRealizedPnl: +totalRealizedPnl.toFixed(2),
    closedCount: closed.length,
    openCount: open.length,
    closed,
    open,
  };
  
  return result;
}

// Read from stdin
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  try {
    const activities = JSON.parse(input);
    const result = processActivity(activities);
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(result, null, 2));
    console.log(`Saved ${result.closedCount} closed, ${result.openCount} open positions`);
    console.log(`Total realized P&L: $${result.totalRealizedPnl.toFixed(2)}`);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
});
