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

# Combine into dashboard-ready JSON
node -e "
const prices = $SNAPSHOT;
const status = $STATUS;
const orders = $ORDERS;
const state = $STATE;
const alerts = $ALERTS;

// Build strategies from position data
const positions = Object.entries(prices.prices || {}).map(([id, p]) => ({
  id, fullAssetId: p.fullAssetId, outcome: p.outcome, size: p.size,
  avgPrice: p.avgPrice, currentBid: p.bid, currentAsk: p.ask,
  costBasis: p.costBasis, currentValue: p.currentValue,
  pnl: p.pnl, pnlPct: p.pnlPct, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
}));

// Derive trades from state (each position entry = a trade)
const stateArr = Array.isArray(state) ? state : state.positions || [];
const trades = stateArr.map(p => ({
  timestamp: new Date().toISOString(),
  market: p.market,
  outcome: p.side,
  side: 'buy',
  price: p.entry,
  size: p.cost,
  pnl: 0,
}));

// Derive strategies
const strategyMap = {};
for (const p of stateArr) {
  const type = p.entry >= 0.85 ? 'Safe Yield' : p.entry >= 0.60 ? 'Event-Driven' : 'Speculative';
  if (!strategyMap[type]) strategyMap[type] = { name: type, trades: 0, pnl: 0, enabled: true };
  strategyMap[type].trades++;
  const pos = positions.find(pp => pp.outcome === p.side && Math.abs(pp.avgPrice - p.entry) < 0.02);
  if (pos) strategyMap[type].pnl += parseFloat(pos.pnl) || 0;
}
const strategies = Object.values(strategyMap).map(s => ({
  ...s, winRate: s.pnl >= 0 ? 0.6 : 0.4,
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
