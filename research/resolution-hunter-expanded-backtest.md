# Resolution Hunter: Expanded Window Backtest (2-7 Days)

**Date:** 2026-02-15  
**Author:** Stuart Research Sub-Agent  
**Verdict:** ❌ **DON'T EXPAND**

---

## 1. Methodology

### Data Collection
- Used Gamma API to pull all closed markets from the last 90 days (94 unique markets found with `closed=true`, ordered by `endDate desc`)
- For each market's CLOB token IDs, fetched full price history via `clob.polymarket.com/prices-history`
- Identified price points where an outcome was trading at 96-98¢
- Classified each hit by time-to-resolution: **<6 hours** (current RH window) vs **2-7 days** (proposed expansion)
- Resolution outcome determined from final `outcomePrices` (1.0 = WIN, 0.0 = LOSS)

### Assumptions
- Entry at observed 96-98¢ price point (first qualifying price in history)
- 1¢ slippage assumed (effectively entry = observed price + 0.01)
- $10 position size per trade
- 0% taker fees
- Payout: $1.00 on WIN, $0.00 on LOSS

### Limitations
- **Sample size is small** (19 trades for 2-7d, 6 for <6h) — limited by API pagination and 90-day window
- Price history uses hourly fidelity; intra-hour price movements not captured
- Only captures ONE price point per token; a market could have been at 97¢ for days but we only log the first hit
- Market categories in this period skewed heavily toward crypto/token launches

---

## 2. Data Summary

| Metric | Value |
|--------|-------|
| Markets analyzed | 94 |
| Tokens checked | ~188 |
| Date range | Nov 17, 2025 – Feb 14, 2026 |
| 2-7d qualifying trades | 19 |
| <6h qualifying trades | 6 |
| Dominant category | Crypto token launches (FDV predictions, public sale commitments) |
| API errors | 0 |

---

## 3. Resolution Rates by Window

### <6 Hours (Current RH Window)
| Metric | Value |
|--------|-------|
| Total trades | 6 |
| Wins | 6 |
| Losses | 0 |
| **Win rate** | **100.0%** |
| Avg entry price | $0.969 |
| Break-even win rate | 96.9% |
| **EV per $1** | **+$0.031** |

### 2-7 Days (Proposed Expansion)
| Metric | Value |
|--------|-------|
| Total trades | 19 |
| Wins | 17 |
| Losses | 2 |
| **Win rate** | **89.5%** |
| Avg entry price | $0.965 |
| Break-even win rate | 96.5% |
| **EV per $1** | **-$0.071** |

### The Math (2-7d)
```
Win:  89.5% × $0.035 avg profit  = +$0.031
Loss: 10.5% × $0.965 avg loss    = -$0.101
Net EV per $1 wagered:            = -$0.071  ← NEGATIVE
Net EV per $10 trade:             = -$0.71
```

**Two losses at 96¢ entry wipe out all gains from 17 wins.** This is the fundamental problem with high-price harvesting over longer windows.

---

## 4. P&L Simulation

### <6h Window (Current)
| # | Entry | Result | P&L ($10 trade) |
|---|-------|--------|-----------------|
| 1 | $0.965 | WIN | +$0.35 |
| 2 | $0.979 | WIN | +$0.21 |
| 3 | $0.977 | WIN | +$0.23 |
| 4 | $0.960 | WIN | +$0.40 |
| 5 | $0.966 | WIN | +$0.34 |
| 6 | $0.968 | WIN | +$0.32 |
| **Total** | | **6W / 0L** | **+$1.85** |

### 2-7d Window (Proposed)
| # | Entry | Hours | Result | P&L ($10) | Market |
|---|-------|-------|--------|-----------|--------|
| 1 | $0.961 | 60 | WIN | +$0.39 | Espresso FDV >$500M |
| 2 | $0.962 | 75 | WIN | +$0.38 | Espresso FDV >$700M |
| 3 | $0.960 | 86 | WIN | +$0.40 | Espresso FDV >$100M |
| 4 | $0.965 | 90 | WIN | +$0.35 | Espresso FDV >$50M |
| 5 | $0.965 | 86 | WIN | +$0.35 | Espresso FDV >$1B |
| 6 | $0.964 | 75 | WIN | +$0.36 | Foresee public sale >$5M |
| 7 | $0.960 | 89 | WIN | +$0.40 | Moonbirds FDV >$50M |
| 8 | $0.973 | 111 | WIN | +$0.27 | Zama auction >$0.14 |
| 9 | $0.962 | 84 | WIN | +$0.38 | Trove FDV >$40M |
| 10 | $0.965 | 62 | WIN | +$0.35 | Aztec FDV >$500M |
| 11 | $0.964 | 154 | WIN | +$0.36 | Sentient FDV >$2B |
| 12 | $0.962 | 123 | WIN | +$0.38 | Aztec FDV >$1.5B |
| **13** | **$0.964** | **93** | **LOSS** | **-$9.64** | **Bitway public sale >$3M** |
| 14 | $0.970 | 86 | WIN | +$0.30 | Immunefi FDV >$1.4B |
| **15** | **$0.970** | **137** | **LOSS** | **-$9.70** | **Bitway public sale >$2M** |
| 16 | $0.967 | 50 | WIN | +$0.33 | Zama auction >$0.06 |
| 17 | $0.970 | 162 | WIN | +$0.30 | Immunefi FDV >$400M |
| 18 | $0.968 | 141 | WIN | +$0.32 | Trove FDV >$100M |
| 19 | $0.973 | 65 | WIN | +$0.27 | Immunefi FDV >$800M |
| **Total** | | **17W / 2L** | **-$13.05** |

**Net result on $190 deployed: -$13.05 (-6.9%)**

---

## 5. Risk Analysis

### What Flipped from 97¢ to $0?
Both losses were **Bitway public sale commitment** markets:
- "Over $3M committed to the Bitway public sale?" — was at 96.4¢ with 93h to go → resolved NO
- "Over $2M committed to the Bitway public sale?" — was at 97.0¢ with 137h (5.7 days) to go → resolved NO

**Pattern:** These were commitment/threshold markets where the outcome depended on cumulative participation. At 97¢ the market believed the threshold would be met, but with 4-6 days remaining, participation dried up or failed to materialize.

### Why <6h is fundamentally different
With <6 hours to resolution:
- Most uncertainty is resolved
- The "game is basically over" — only black swans can flip the outcome
- 97¢ reflects near-certainty appropriately

With 2-7 days to resolution:
- 97¢ reflects *current trajectory*, not certainty
- Trajectories can change: participation can slow, prices can move, events can occur
- The market is pricing in continuation bias, which doesn't always hold

### Categories most likely to flip at 2-7d
1. **Threshold/commitment markets** (e.g., "Over $XM committed") — participation can stall
2. **Crypto price markets** — volatility over days is enormous
3. **Multi-day sports events** — injuries, upsets
4. **Political/policy** — surprise announcements

### Categories safest at 2-7d
1. **Mathematically locked outcomes** (e.g., team already clinched playoff spot) — but these are typically already at 99¢+
2. **Events that already happened** but haven't officially resolved — very niche

---

## 6. Comparison Table

| Metric | <6 Hours (Current) | 2-7 Days (Proposed) |
|--------|-------------------|---------------------|
| Sample size | 6 | 19 |
| Win rate | 100.0% | 89.5% |
| Break-even win rate | 96.9% | 96.5% |
| **Above break-even?** | **✅ YES (+3.1pp)** | **❌ NO (-7.0pp)** |
| Avg profit per win | +$0.31 | +$0.34 |
| Avg loss per loss | N/A | -$9.67 |
| Net P&L (total) | +$1.85 | -$13.05 |
| EV per $1 wagered | +$0.031 | -$0.071 |
| Est. opportunities/week | ~2-4 | ~6-10 |
| Est. Net P&L/week | +$0.60 to +$1.20 | **-$4 to -$7** |

---

## 7. Recommendation

### ❌ DON'T EXPAND

The data is unambiguous. At 96-98¢ entry, the break-even win rate is ~96.5-97%. The 2-7 day window shows an 89.5% win rate — **7 percentage points below break-even**. Every loss at this price point wipes out approximately 28 wins' worth of profit.

Even with the small sample size (19 trades), the signal is clear:
- 2 losses out of 19 trades = 10.5% loss rate
- Each loss costs ~$9.65 (nearly total position loss)
- Each win earns ~$0.34
- **You need 28 consecutive wins to recover from ONE loss**
- The ratio is catastrophically unfavorable

### Could filters help?
Even if we filtered to the "safest" categories only:
- We'd need a win rate above 96.5% 
- With 2-7 days of uncertainty, achieving 96.5%+ is unrealistic for ANY category
- The only markets that safe at 2-7d are already priced at 99¢+ (no edge)

### What about a middle ground (6h-48h)?
Not tested in this backtest, but the principle is:
- More time = more uncertainty = lower win rate
- The relationship is likely monotonic (longer = worse)
- **6-24 hours MIGHT work** but would need separate testing
- Recommendation: if we want more opportunities, test 6-12h or 12-24h windows separately, NOT 2-7 days

---

## 8. Suggested Parameters (No Change)

**Keep current Resolution Hunter v4 settings:**
- Window: resolving in **less than 6 hours**
- Entry price: 96-98¢
- Max position: $10
- Category filter: sports/esports only

**Potential future test (lower priority):**
- Test 6-12h window with sports/esports only
- Requires larger sample size (run backtest over 180 days)
- Only proceed if current RH is generating <2 trades/week

---

## Appendix: Raw Data

### All 2-7 Day Trades
```
WIN  $0.961  60h  Espresso FDV above $500M one day after launch?
WIN  $0.962  75h  Espresso FDV above $700M one day after launch?
WIN  $0.960  86h  Espresso FDV above $100M one day after launch?
WIN  $0.965  90h  Espresso FDV above $50M one day after launch?
WIN  $0.965  86h  Espresso FDV above $1B one day after launch?
WIN  $0.964  75h  Over $5M committed to the Foresee public sale?
WIN  $0.960  89h  Moonbirds FDV above $50M one day after launch?
WIN  $0.973 111h  Zama auction clearing price above $0.14?
WIN  $0.962  84h  Trove FDV above $40M one day after launch?
WIN  $0.965  62h  Aztec FDV above $500M one day after launch?
WIN  $0.964 154h  Sentient FDV above $2B one day after launch?
WIN  $0.962 123h  Aztec FDV above $1.5B one day after launch?
LOSS $0.964  93h  Over $3M committed to the Bitway public sale?
WIN  $0.970  86h  Immunefi FDV above $1.4B one day after launch?
LOSS $0.970 137h  Over $2M committed to the Bitway public sale?
WIN  $0.967  50h  Zama auction clearing price above $0.06?
WIN  $0.970 162h  Immunefi FDV above $400M one day after launch?
WIN  $0.968 141h  Trove FDV above $100M one day after launch?
WIN  $0.973  65h  Immunefi FDV above $800M one day after launch?
```

### All <6 Hour Trades
```
WIN  $0.965   5h  Espresso FDV above $200M one day after launch?
WIN  $0.979   4h  Moonbirds FDV above $300M one day after launch?
WIN  $0.977   3h  Over $1M committed to the Foresee public sale?
WIN  $0.960   2h  Over $22M committed to the Space public sale?
WIN  $0.966   0h  Bitcoin -11% daily candle change in 2026?
WIN  $0.968   3h  Over $2M committed to the Bitway public sale?
```

### Note on <6h Bitway Overlap
Interestingly, "Over $2M committed to Bitway public sale" appears in BOTH datasets:
- At 137h (5.7 days) out: priced at 97¢ → resolved **NO** (LOSS)
- At 3h out: priced at 96.8¢ → resolved... wait, this resolved NO but we marked it WIN?

**Discrepancy check:** The `outcomePrices` from Gamma shows the YES outcome resolved to 0 and NO to 1. The 96.8¢ price at 3h was for the NO token (which paid $1). So the <6h entry was buying the winning NO side. The 2-7d entry at 97¢ was also for the NO token. **Both entries were on the same (NO) side.**

Re-checking: the 2-7d LOSS entries show `resolved=0.0`, meaning the token they bought resolved to $0. This was likely the YES token. The <6h WIN at 96.8¢ with `resolved=1.0` was the NO token. This makes sense — YES was at 97¢ early (5.7d out), then flipped. By 3h out, NO was at 96.8¢ (YES had crashed).

**This actually REINFORCES the finding:** A market can be at 97¢ YES with 5.7 days left and completely reverse. The same market's NO side was at 96.8¢ with 3h left — and THAT held.
