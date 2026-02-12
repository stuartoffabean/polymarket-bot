#!/bin/bash
# Push live snapshot to GitHub for dashboard consumption
# Run via cron every 15 minutes

cd /data/workspace/polymarket-bot

# Generate snapshot from live feed
SNAPSHOT=$(curl -s localhost:3003/prices 2>/dev/null)
STATUS=$(curl -s localhost:3003/status 2>/dev/null)
ORDERS=$(curl -s localhost:3002/orders 2>/dev/null)

if [ -z "$SNAPSHOT" ]; then
  echo "Feed not responding, skipping"
  exit 1
fi

# Read trading state for trade history
STATE=$(cat TRADING-STATE.json 2>/dev/null || echo "[]")
ALERTS=$(curl -s localhost:3003/alerts 2>/dev/null || echo '{"alerts":[]}')
WSPROXY=$(curl -s https://polymarket-dashboard-ws-production.up.railway.app/prices 2>/dev/null || echo '{"prices":{}}')

# Combine into dashboard-ready JSON
node -e "
const prices = $SNAPSHOT;
const status = $STATUS;
const orders = $ORDERS;
const state = $STATE;
const alerts = $ALERTS;
const wsProxy = $WSPROXY;
const livePriceCache = wsProxy.prices || {};

// Build strategies from position data
const positions = Object.entries(prices.prices || {}).map(([id, p]) => ({
  id, fullAssetId: p.fullAssetId, outcome: p.outcome, size: p.size,
  avgPrice: p.avgPrice, currentBid: p.bid, currentAsk: p.ask,
  costBasis: p.costBasis, currentValue: p.currentValue,
  pnl: p.pnl, pnlPct: p.pnlPct, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
}));

// Derive trades from state (each position entry = a trade)
const stateArr = Array.isArray(state) ? state : state.positions || [];
// Match by tokenId prefix (positions use truncated IDs)
const trades = stateArr.map(p => {
  const livePos = positions.find(pp => {
    if (!p.tokenId || !pp.fullAssetId) return false;
    return p.tokenId.startsWith(pp.fullAssetId) || pp.fullAssetId.startsWith(p.tokenId.slice(0,20));
  });
  // Also try WS proxy for real-time price
  const wsPrice = livePriceCache[p.tokenId];
  const currentBid = livePos?.currentBid || wsPrice?.bid || null;
  const pnl = currentBid && p.entry && p.shares ? (currentBid - p.entry) * p.shares : 0;
  return {
    timestamp: new Date().toISOString(),
    market: p.market,
    outcome: p.side,
    side: 'buy',
    price: p.entry,
    size: p.cost,
    shares: p.shares,
    currentPrice: currentBid,
    pnl: parseFloat(pnl.toFixed(2)),
    pnlPct: p.cost > 0 ? ((pnl / p.cost) * 100).toFixed(1) + '%' : null,
    tokenId: p.tokenId,
  };
});

// Derive strategies from computed trades
const strategyMap = {};
for (const t of trades) {
  const type = t.price >= 0.85 ? 'Safe Yield' : t.price >= 0.60 ? 'Event-Driven' : 'Speculative';
  if (!strategyMap[type]) strategyMap[type] = { name: type, trades: 0, pnl: 0, wins: 0, enabled: true };
  strategyMap[type].trades++;
  strategyMap[type].pnl += t.pnl || 0;
  if (t.pnl > 0) strategyMap[type].wins++;
}
const strategies = Object.values(strategyMap).map(s => ({
  ...s, winRate: s.trades > 0 ? s.wins / s.trades : 0,
}));

// Recent activity from alerts
const activity = (alerts.alerts || []).slice(-20).map(a => ({
  time: a.timestamp,
  type: a.type,
  message: a.message || a.type,
  outcome: a.outcome,
}));

const snapshot = {
  timestamp: new Date().toISOString(),
  portfolio: status.portfolio,
  risk: status.risk,
  infrastructure: status.infrastructure,
  positions,
  orders: (orders.orders || []).map(o => ({
    id: o.id, order_id: o.order_id, asset_id: o.asset_id,
    side: o.side, price: o.price, original_size: o.original_size,
    size_matched: o.size_matched, status: o.status,
  })),
  trades,
  strategies,
  activity,
  circuitBreakerTripped: prices.circuitBreakerTripped,
  survivalMode: prices.survivalMode,
  emergencyMode: prices.emergencyMode,
};
require('fs').writeFileSync('live-snapshot.json', JSON.stringify(snapshot, null, 2));
console.log('Snapshot written: ' + snapshot.positions.length + ' positions, ' + snapshot.orders.length + ' orders, ' + snapshot.trades.length + ' trades, ' + snapshot.strategies.length + ' strategies');
"

# Push to GitHub
git add live-snapshot.json pnl-history.json TRADING-STATE.json 2>/dev/null
git commit -m "📊 Live snapshot $(date -u +%H:%M)" --allow-empty 2>/dev/null
git push origin main 2>/dev/null

echo "Pushed to GitHub"
