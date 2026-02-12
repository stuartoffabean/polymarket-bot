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

# Combine into dashboard-ready JSON
node -e "
const prices = $SNAPSHOT;
const status = $STATUS;
const orders = $ORDERS;
const snapshot = {
  timestamp: new Date().toISOString(),
  portfolio: status.portfolio,
  risk: status.risk,
  infrastructure: status.infrastructure,
  positions: Object.entries(prices.prices || {}).map(([id, p]) => ({
    id: id,
    fullAssetId: p.fullAssetId,
    outcome: p.outcome,
    size: p.size,
    avgPrice: p.avgPrice,
    currentBid: p.bid,
    currentAsk: p.ask,
    costBasis: p.costBasis,
    currentValue: p.currentValue,
    pnl: p.pnl,
    pnlPct: p.pnlPct,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
  })),
  orders: orders.orders || [],
  circuitBreakerTripped: prices.circuitBreakerTripped,
  survivalMode: prices.survivalMode,
  emergencyMode: prices.emergencyMode,
};
require('fs').writeFileSync('live-snapshot.json', JSON.stringify(snapshot, null, 2));
console.log('Snapshot written: ' + snapshot.positions.length + ' positions');
"

# Push to GitHub
git add live-snapshot.json pnl-history.json TRADING-STATE.json 2>/dev/null
git commit -m "📊 Live snapshot $(date -u +%H:%M)" --allow-empty 2>/dev/null
git push origin main 2>/dev/null

echo "Pushed to GitHub"
