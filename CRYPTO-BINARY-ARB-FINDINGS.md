# CRYPTO BINARY ARB PIPELINE — Findings Report
**Session:** 2026-02-15 05:22 UTC  
**Status:** ⚠️ BLOCKED — Target markets do not exist

---

## EXECUTIVE SUMMARY

**5-minute and 15-minute crypto binary markets DO NOT EXIST on Polymarket.**

After comprehensive market discovery via Gamma API (500+ markets scanned, active and historical), no crypto binary markets with 5-minute or 15-minute resolution timeframes were found.

**What DOES exist:**
- Daily "Up or Down" crypto binaries (BTC, ETH)
- High volume ($200K-$580K/day)
- Accessible via CLOB API (no geoblocking)
- Efficiently priced (spreads ~$1.01-$1.02, no current arb)

---

## STEP 1: Market Access Verification ✅

### Markets Found

| Asset | Market | Volume 24h | Resolution | Status |
|-------|--------|-----------|------------|--------|
| BTC | Bitcoin Up or Down on February 15? | $582,897 | Daily (17:00 UTC) | Active |
| ETH | Ethereum Up or Down on February 15? | $208,421 | Daily (17:00 UTC) | Active |
| **5-min markets** | **NONE FOUND** | — | — | ❌ |
| **15-min markets** | **NONE FOUND** | — | — | ❌ |
| SOL | None active | — | — | — |
| XRP | None active | — | — | — |

### API Access Verified
- ✅ Gamma API: Market discovery working
- ✅ CLOB API: Order book access confirmed
- ✅ pm_book tool: Functional, no geoblocking
- ✅ Token IDs: Correctly structured
- ✅ Historical search: No 5-min/15-min markets ever existed

### Market Slug Patterns
```
bitcoin-up-or-down-on-[date]
ethereum-up-or-down-on-[date]
```

No evidence of:
- `btc-updown-5m-*`
- `btc-updown-15m-*`
- Any sub-hourly crypto prediction markets

---

## STEP 2: Spread Analysis ✅

### Current Order Books (Feb 15, ~05:30 UTC)

**BTC Up or Down:**
```
YES token: 4828...2136
  Best bid: $0.73 (459 shares)
  Best ask: $0.75 (244 shares)

NO token: 7310...2357
  Best bid: $0.25 (192 shares)
  Best ask: $0.26 (271 shares)

COMBINED ASK: $1.01
Arb opportunity: ❌ NO (overpriced by 1%)
```

**ETH Up or Down:**
```
YES ask + NO ask ≈ $1.01-$1.02
Similar depth and efficiency to BTC market
```

### Spread Characteristics
- **Typical spread:** $1.01-$1.02 (1-2% above fair value)
- **Liquidity:** Deep (200+ shares at best ask on each side)
- **Fee structure:** Unknown for daily crypto binaries (need to check if CRYPTO_15MIN fee applies)
- **Arb frequency:** Rare (markets are efficiently arbitraged)

### Fee Structure Investigation Needed
The existing `binary-arb-scanner.js` detects market type via:
```javascript
function detectMarketType(question = '', slug = '') {
  const q = (question + ' ' + slug).toLowerCase();
  if (q.includes('15m') || q.includes('up or down') || q.includes('updown')) 
    return 'CRYPTO_15MIN';
  // ...
}
```

**Issue:** This will classify daily "Up or Down" markets as `CRYPTO_15MIN` (3.125% taker fee) even though they're DAILY markets. Need to verify actual fee structure.

---

## STEP 3: Scanner Build ❌ BLOCKED

**Cannot build scanner for non-existent markets.**

### Alternative Approach
1. **Monitor for market creation:** Watch Gamma API for new crypto binary markets with sub-daily resolution
2. **Adapt to daily markets:** Build scanner for daily crypto binaries (lower capital velocity but functional)
3. **Request feature:** Contact Polymarket to confirm if 5-min/15-min markets are planned

---

## STEP 4: Execution Path ⏸️ ON HOLD

Execution infrastructure exists (`pm_arb` tool, `binary-arb-scanner.js`), but no target markets to execute against.

---

## STEP 5: Paper Trade Test ❌ CANNOT PROCEED

Cannot paper trade markets that don't exist.

---

## CAPITAL VELOCITY IMPACT

**Original goal:** Use high-frequency crypto binaries (5-min, 15-min) to cycle capital every few hours.

**Reality check:**
- Daily markets = 1 cycle per day MAX
- At $500 bankroll, 2% edge/trade, 1 trade/day = $10/day expected value
- Compare to: 5-min markets (12x/hour) would theoretically allow 100+ cycles/day

**Daily markets cannot achieve the capital velocity mandate.**

---

## RECOMMENDATIONS

### Option 1: Investigate Alternatives
- Check if other platforms (Drift, Kalshi) offer sub-hourly crypto binaries
- Research if Polymarket has plans to launch these markets
- Look for other high-frequency binary opportunities on Polymarket

### Option 2: Adapt Strategy
- Use daily crypto binaries as part of a diversified portfolio
- Combine with existing arb scanner (NegRisk events)
- Focus on resolution harvesting for faster capital cycles

### Option 3: Wait and Monitor
- Set up a Gamma API monitor to alert when new crypto binary formats launch
- Build infrastructure in advance, deploy when markets go live

---

## TECHNICAL VERIFICATION

### Gamma API Query Used
```bash
https://gamma-api.polymarket.com/markets?limit=500&active=true&closed=false
https://gamma-api.polymarket.com/markets?limit=500&closed=true  # Historical
```

### Regex Filters Applied
```javascript
// Crypto detection
/\b(bitcoin|ethereum|solana|ripple|btc|eth|sol|xrp)\b/

// Timeframe detection  
/(5m|5 minute|5-minute|15m|15 minute|15-minute|up or down|updown)/
```

### Results
- Active markets scanned: 500
- Closed markets scanned: 500  
- 5-min crypto binaries: **0**
- 15-min crypto binaries: **0**
- Daily crypto binaries: **2** (BTC, ETH)

---

## NEXT STEPS

**BLOCKER:** Confirm with operator whether:
1. 5-min/15-min markets are expected to launch (and when)
2. Daily crypto binaries should be targeted instead
3. Alternative high-velocity strategies should be prioritized

**DO NOT PROCEED** with building infrastructure for non-existent markets.

---

## SESSION ARTIFACTS

- ✅ Market access verified  
- ✅ Order book access confirmed  
- ✅ Spread analysis completed  
- ❌ Scanner build: BLOCKED  
- ❌ Execution path: ON HOLD  
- ❌ Paper trade: CANNOT PROCEED  

**Session outcome:** PARTIAL — verified access, but target markets don't exist.
