# POSITION SYNC FIX — 2026-02-12 23:30 UTC

## Problem
Three sources of truth not syncing:
1. **Executor** (`/positions`) — derives positions from trade history
2. **Ws-feed** (`subscribedAssets` map) — tracks positions for price monitoring
3. **TRADING-STATE.json** — Stuart's strategy notes mixed with position data

Result: Sold positions stayed in ws-feed forever, dashboard showed phantom positions.

## Structural Fix

### 1. Executor = Single Source of Truth
All position data (shares, entry price, cost basis) now comes from executor's `/positions` endpoint.

### 2. Ws-feed Syncs After Trades
Added `syncPositions()` call inside `executeSell()` — after every auto-sell, ws-feed refreshes its tracking from executor.

**Change in ws-feed.js:**
```javascript
async function executeSell(assetId, asset, reason) {
  // ... market sell ...
  
  // STRUCTURAL FIX: Sync positions from executor after sell
  log("SYNC", "Post-sell position sync...");
  await syncPositions();
}
```

### 3. Ws-feed Removes Zero-Size Positions
Updated `syncPositions()` to:
- Remove positions not in executor anymore (sold positions)
- Skip positions with size=0
- Remove from `subscribedAssets` so dashboard stops tracking

**Change in ws-feed.js:**
```javascript
async function syncPositions() {
  // Remove sold positions (not in executor anymore)
  const executorAssetIds = new Set(positions.map(p => p.asset_id));
  for (const [assetId, _] of subscribedAssets) {
    if (!executorAssetIds.has(assetId)) {
      subscribedAssets.delete(assetId);
      log("SYNC", `Removed sold position: ${assetId.slice(0,20)}`);
    }
  }
  
  // Skip positions with zero size
  if (pos.size === 0) {
    subscribedAssets.delete(pos.asset_id);
    continue;
  }
}
```

### 4. Dashboard Reads from Executor
Updated `push-snapshot.sh` to read positions from executor `/positions` instead of TRADING-STATE.json.

**Change in push-snapshot.sh:**
```bash
# STRUCTURAL FIX: Read from executor (single source of truth)
EXEC_POSITIONS=$(curl -s localhost:3002/positions 2>/dev/null || echo '{"positions":[]}')

# Derive trades from EXECUTOR, not TRADING-STATE.json
const execPos = execPositions.positions || [];
const trades = execPos.filter(p => p.size > 0).map(p => { ... });
```

### 5. TRADING-STATE.json = Strategy Notes Only
TRADING-STATE.json should now only contain:
- Thesis notes (why we entered)
- Invalidation conditions (when thesis breaks)
- Time stops (when to exit regardless of price)
- Custom stop-loss/take-profit overrides

**NOT position data** — that lives in executor.

## Verification
After deploying fix:
- Ws-feed restarted: tracking reduced from 12 → 6 positions (sold positions auto-removed)
- `pm_status` shows clean position list (no phantom positions)
- Dashboard will now sync with executor truth on next snapshot push

## Pattern Going Forward
```
Executor (trade history) 
  ↓
Ws-feed (syncs every 5min + after each sell)
  ↓
Dashboard (reads from executor + ws-feed prices)

TRADING-STATE.json is read-only for position data.
Stuart writes strategy notes, reads positions from pm_status (which calls executor).
```

## Files Changed
- `/data/workspace/polymarket-bot/executor/ws-feed.js` — added post-sell sync + zero-size cleanup
- `/data/workspace/polymarket-bot/executor/push-snapshot.sh` — read from executor instead of TRADING-STATE.json

## Deployment
```bash
cd /data/workspace/polymarket-bot && pkill -f "node ws-feed.js"
cd /data/workspace/polymarket-bot/executor && \
  TELEGRAM_BOT_TOKEN="..." TELEGRAM_CHAT_ID="8408068072" \
  nohup node ws-feed.js > ../ws-feed.log 2>&1 &
```

---

**Result:** No more three-way desync. Executor is truth. Dashboard reflects reality.
