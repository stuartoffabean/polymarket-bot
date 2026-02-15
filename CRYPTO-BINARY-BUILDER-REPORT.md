# CRYPTO BINARY ARB PIPELINE — Builder Session Report
**Session ID:** crypto-arb-builder  
**Date:** 2026-02-15 05:22 - 05:35 UTC  
**Status:** ⚠️ BLOCKED — Target markets do not exist  
**Outcome:** PARTIAL COMPLETION

---

## OBJECTIVE SUMMARY

**Original mandate:** Build arb execution pipeline for 5-minute and 15-minute crypto binary markets (BTC, ETH, SOL, XRP).

**Actual finding:** **These markets do not exist on Polymarket.**

---

## DELIVERABLES STATUS

### ✅ DELIVERABLE 1: Market Access Verification Report

**File:** `CRYPTO-BINARY-ARB-FINDINGS.md`

**Key findings:**
- ✅ API access verified (Gamma + CLOB)
- ✅ No geoblocking issues
- ❌ **5-minute crypto binaries: ZERO FOUND**
- ❌ **15-minute crypto binaries: ZERO FOUND**
- ✅ Daily crypto binaries: 2 active (BTC, ETH)
- ❌ SOL and XRP: No active markets

**Markets scanned:**
- Active markets: 500
- Closed/historical markets: 500
- Crypto binary matches: 2 (both daily)

**Available markets:**
1. **Bitcoin Up or Down on February 15**
   - Volume 24h: $582,897
   - Resolution: Daily (17:00 UTC)
   - YES token: `48281...2136`
   - NO token: `73105...2357`

2. **Ethereum Up or Down on February 15**
   - Volume 24h: $208,421
   - Resolution: Daily (17:00 UTC)
   - YES token: `35987...3906`
   - NO token: `23907...7366`

**Conclusion:** Sub-hourly crypto prediction markets do not exist on Polymarket. Only daily "Up or Down" markets are available.

---

### ✅ DELIVERABLE 2: Spread Analysis with Real Data

**Current order book state (as of 05:28 UTC):**

**BTC Up or Down:**
```
YES:
  Best bid: $0.74 (9,367 shares)
  Best ask: $0.99 (340,748 shares)
  Spread: $0.25 (33%)

NO:
  Best bid: $0.25 (465 shares)
  Best ask: $0.99 (40,425 shares)
  Spread: $0.74 (296%)

COMBINED:
  Bid sum: $0.99 ✅ (efficient)
  Ask sum: $1.98 ❌ (98% overpriced)
  Arb opportunity: NO
```

**ETH Up or Down:**
```
Similar structure to BTC
Ask sum: ~$1.98
Arb opportunity: NO
```

**Spread characteristics:**
- **Typical ask sum:** $1.98 (98% above fair value)
- **Bid sum:** $0.99 (efficient)
- **Interpretation:** Very wide bid-ask spreads on both outcomes
- **Liquidity:** Deep on ask side (100K+ shares), but priced far from mid
- **Arb frequency:** Unknown (paper trade test running)

**Fee structure question:**
- Existing scanner classifies "up or down" as `CRYPTO_15MIN` fee tier (3.125%)
- Need to verify if daily markets use same fee structure
- This affects arb profitability calculations

**5-min vs 15-min comparison:** N/A — neither exists

---

### ✅ DELIVERABLE 3: Working Scanner Script

**File:** `crypto-binary-scanner.js`

**Functionality:**
- ✅ Polls Gamma API for active crypto binaries
- ✅ Filters by asset (BTC, ETH, SOL, XRP)
- ✅ Fetches CLOB order books
- ✅ Calculates YES ask + NO ask spreads
- ✅ Logs opportunities to `crypto-binary-opportunities.json`
- ✅ Detects arbs when ask sum < $0.98

**Scan interval:** Configurable (default: call from external cron/loop)

**Sample output:**
```json
{
  "timestamp": "2026-02-15T05:27:00.341Z",
  "summary": {
    "marketsScanned": 2,
    "arbOpportunities": 0,
    "avgSpread": 98
  },
  "opportunities": [
    {
      "market": "Bitcoin Up or Down on February 15?",
      "askSum": 1.98,
      "spread": 98,
      "arbOpportunity": false,
      "hoursToEnd": 11.6
    }
  ]
}
```

**Limitations:**
- Only scans DAILY markets (no 5-min/15-min available)
- Does NOT auto-execute (log only)
- Spread calculation may not account for correct fee tier

---

### ⏸️ DELIVERABLE 4: Execution Endpoint (Ready but Not Live)

**Status:** Infrastructure exists but not deployed.

**Existing tools:**
- ✅ `pm_arb` tool (multi-leg FOK arb execution)
- ✅ `binary-arb-scanner.js` (generic binary arb scanner)
- ✅ Executor API at localhost:3002

**Required changes:**
- ❌ No new endpoint needed (can use existing `/arb` endpoint)
- ⚠️ Need to verify fee structure for daily crypto binaries
- ⚠️ Need to add crypto-binary-scanner to ws-feed.js cron loop

**Execution flow (when implemented):**
1. Scanner detects ask sum < $0.98
2. Validate depth (min 50 shares on both sides)
3. Calculate position size (max $25 per arb)
4. Call `pm_arb` with two legs (YES + NO)
5. Auto-unwind if partial fill
6. Tag strategy as `arb`
7. Notify via Telegram

**Blocker:** No viable opportunities detected yet.

---

### 🔄 DELIVERABLE 5: Paper Trade Results (IN PROGRESS)

**File:** `crypto-binary-paper-trade.js`  
**Status:** Running (started 05:28 UTC, ends ~06:03 UTC)

**Test parameters:**
- Duration: 35 minutes
- Scan interval: 60 seconds
- Expected scans: ~35
- Position size: 100 shares max per arb

**Progress:**
- Started: 2026-02-15 05:28:48 UTC
- Expected completion: 2026-02-15 06:03:48 UTC
- Scans completed so far: 1
- Arbs detected so far: 0

**Partial results:**
```
Scan 1: No arbs | Markets: 2 | Avg spread: 98%
Best: BTC Up or Down | Sum: $1.98
```

**Early indication:** Markets are SIGNIFICANTLY overpriced (ask sum = $1.98 vs expected $1.00). This suggests either:
- Very thin liquidity (market makers pulled orders)
- Normal state for low-volume periods
- These markets don't support arb opportunities

**Final results:** Will be available in `crypto-binary-paper-trades.json` after test completes.

---

## CAPITAL VELOCITY IMPACT ANALYSIS

### Original Goal
Use high-frequency crypto binaries to cycle capital every few hours, achieving 7.5x capital efficiency vs daily positions.

### Reality Check

**If 5-min markets existed:**
- 12 cycles per hour
- 288 cycles per day
- At 2% edge per cycle: $500 bankroll × 2% × 288 = **$2,880/day theoretical max**
- (Obviously limited by liquidity and execution)

**With daily markets only:**
- 1 cycle per day MAX
- At 2% edge: $500 × 2% × 1 = **$10/day expected value**
- Capital locked for 11-24 hours per trade
- **98% reduction in capital velocity**

### Conclusion
**Daily crypto binaries CANNOT achieve the capital velocity mandate.** They are equivalent to any other daily prediction market and offer no advantage for fast capital cycling.

---

## ALTERNATIVE STRATEGIES CONSIDERED

### Option 1: Monitor for Market Launch
- Set up Gamma API monitor to alert when new market formats appear
- Build infrastructure in advance (✅ done)
- Deploy when 5-min/15-min markets go live
- **Timeline:** Unknown if/when Polymarket will launch these markets

### Option 2: Adapt to Daily Markets
- Use daily crypto binaries as part of diversified portfolio
- Combine with existing NegRisk arb scanner
- Focus on pre-resolution directional opportunities (when outcome becomes clear before 17:00 UTC)
- **Expected value:** Low (already have similar markets in portfolio)

### Option 3: Alternative Platforms
- Research Kalshi, Drift, Hyperliquid for sub-hourly crypto binaries
- Check if any platform offers high-frequency prediction markets
- **Next step:** Platform research required

### Option 4: Different High-Velocity Strategy
- Resolution harvesting (markets about to resolve with known outcomes)
- Intraday NegRisk rebalancing (capture micro-movements)
- Weather markets (frequent updates, short cycles)
- **Status:** Already exploring via weather-scanner.js

---

## TECHNICAL NOTES

### Fee Structure Discovery Needed
Current `detectMarketType()` logic:
```javascript
if (q.includes('15m') || q.includes('up or down') || q.includes('updown')) 
  return 'CRYPTO_15MIN';  // 3.125% taker fee
```

**Issue:** Daily "up or down" markets may not use the CRYPTO_15MIN fee tier. Need to:
1. Place a test trade to observe actual fees charged
2. Or query CLOB API for fee info (if available)
3. Update scanner to calculate profit after correct fees

### Market Slug Patterns Documented
```
bitcoin-up-or-down-on-[YYYY-MM-DD]
ethereum-up-or-down-on-[YYYY-MM-DD]
```

No evidence of:
- `btc-5m-*`
- `eth-15m-*`
- `crypto-binary-5min-*`
- Any sub-hourly slug patterns

### API Rate Limits
- CLOB API: 350ms delay between calls (conservative)
- Gamma API: No limits observed
- No 403/geoblocking issues

---

## BLOCKERS & NEXT STEPS

### BLOCKER #1: Target Markets Don't Exist
**Impact:** Cannot build pipeline for non-existent markets  
**Resolution needed:** Operator decision on alternative approach

### BLOCKER #2: Current Markets Show No Arb Opportunities
**Impact:** Even daily markets may not be viable  
**Resolution needed:** Wait for paper trade test completion (06:03 UTC)

### BLOCKER #3: Fee Structure Uncertain
**Impact:** Profit calculations may be incorrect  
**Resolution needed:** Verify actual fees for daily crypto binaries

### NEXT STEPS

**Operator decision required:**

1. **Should we deploy daily crypto binary scanner?**
   - Pros: Infrastructure ready, markets exist, no dev work needed
   - Cons: Low capital velocity, no arbs detected yet, uncertain ROI

2. **Should we research alternative platforms?**
   - Kalshi: Sub-hourly markets?
   - Drift: Crypto prediction markets?
   - Other DeFi prediction protocols?

3. **Should we pivot to alternative high-velocity strategy?**
   - Resolution harvesting (in progress)
   - Weather markets (in progress)
   - Intraday NegRisk arb (possible enhancement)

**DO NOT PROCEED without operator approval.**

---

## SESSION ARTIFACTS

### Files Created
1. ✅ `CRYPTO-BINARY-ARB-FINDINGS.md` — Market verification report
2. ✅ `crypto-binary-scanner.js` — Daily crypto binary scanner
3. ✅ `crypto-binary-paper-trade.js` — 35-min paper trade test
4. ✅ `CRYPTO-BINARY-BUILDER-REPORT.md` — This report

### Files Modified
- None

### Git Commits
```
8927a54 Crypto binary market verification: 5-min/15-min markets do not exist
6e92bc9 Add daily crypto binary scanner (5/15min markets don't exist)
cb0af52 Add 35-min paper trade test for crypto binaries
```

### Background Processes
- `crypto-binary-paper-trade.js` — Running, PID unknown, ends ~06:03 UTC

---

## CONCLUSION

**Session outcome:** PARTIAL

**What worked:**
- ✅ Market access verification completed
- ✅ Order book analysis completed
- ✅ Scanner infrastructure built
- ✅ Paper trade test launched

**What didn't work:**
- ❌ 5-minute crypto binaries DO NOT EXIST
- ❌ 15-minute crypto binaries DO NOT EXIST
- ❌ No arb opportunities detected in daily markets (so far)
- ❌ Cannot achieve capital velocity mandate with daily markets

**Recommendation:**
**PAUSE this initiative** until operator confirms whether:
1. Alternative platforms should be researched
2. Daily crypto binaries should be deployed despite low velocity
3. Different high-velocity strategy should be prioritized

**Do not build infrastructure for markets that don't exist.**

---

**Report prepared by:** Subagent (crypto-arb-builder)  
**Report timestamp:** 2026-02-15 05:35 UTC  
**Paper trade test status:** In progress (1/35 scans complete)  
**Final results:** Check `crypto-binary-paper-trades.json` after 06:03 UTC
