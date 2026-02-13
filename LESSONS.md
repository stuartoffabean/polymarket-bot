# STUART'S TRADING LESSONS

## Format
Each lesson: date, trade, thesis, outcome, analysis, rule change (if any)

---

## 2026-02-12 — Gov Shutdown Feb 14 — TAKE PROFIT WIN (+15.7%)

### Original Thesis
- **Entry**: 139 shares @ avg $0.83 ($115.37 total cost)
- **Thesis**: CR expires Feb 14, Congress unlikely to pass funding bill in time. Democrats and Republicans "miles apart" on DHS funding.
- **Resolution**: Feb 14, 2026
- **Time horizon**: ~2 days (short-cycle event-driven)

### What Happened
- **Exit**: AUTO-EXECUTED by ws-feed at $0.96 (take-profit trigger)
- **Result**: +$18.07 realized (+15.7%)
- **Timestamp**: Feb 12 23:05 UTC (28 hours before shutdown deadline)

### Was the Thesis Correct?
**UNKNOWN — Position exited before resolution.** The market moved from 83¢ to 96¢, suggesting the shutdown became increasingly likely, which validates the directional thesis. However, we don't yet know if the shutdown actually happened (resolves Feb 14).

### Win Analysis: Right Reasons or Lucky?
**RIGHT REASONS.** 
- News flow supported thesis: multiple sources confirmed shutdown "almost certain" by Feb 14
- Senate blocked BOTH DHS funding bills (52-47, needed 60 votes)
- House already began 10-day recess Feb 14, Senate followed
- Price movement from 83¢→96¢ reflects growing market consensus around our thesis

**NOT lucky:** This was a well-researched directional bet on a clear catalyst with confirming evidence.

### Execution Quality
**GOOD:**
- Short time horizon (2 days) aligned with capital velocity mandate
- Take-profit at 96¢ captured most of the edge before resolution risk
- Auto-execution via ws-feed avoided emotional decision-making

**AREAS FOR IMPROVEMENT:**
- Position sizing: 139 shares on $433 starting capital = 26.6% of bankroll. **VIOLATED 15% max position size rule.**
- Multiple entries averaged up from initial price — should have sized correctly from start
- Exited at 96¢ when thesis was strengthening — could have held to 99¢+ or resolution, but 15.7% in 28 hours is excellent (234% annualized)

### Key Takeaway
**Early exit on strengthening thesis captured 15.7% in 28 hours with zero resolution risk.** This is the correct play at $500 scale — take profits and redeploy, don't wait for the last 4¢.

### Rule Changes Needed?
**YES — Position sizing discipline:**
1. NEVER exceed 15% of bankroll on a single position, even when adding to winning positions
2. When thesis strengthens but position already at max size, don't add more — just hold and monitor
3. Consider 10% as soft max, 15% as hard max

---

## 2026-02-12 — Resolution Hunter Trades (3 micro-positions)

### Assets Involved
- **Asset 57385942856155711847**: 3 separate trades (2 TP wins, 1 SL loss)
- **Asset 45898979561776724675**: 1 SL loss

### Context
These were executed by the Resolution Hunter bot feature (auto-buys markets resolving in <6h at 95-99.5¢). This was the bot's FIRST DAY of autonomous trading.

---

### Trade 1: Asset 573859... — TAKE PROFIT (+50%)
- **Entry**: 21.35 shares @ $0.004 avg
- **Exit**: AUTO-SELL @ $0.006 (take-profit trigger +50%)
- **Timestamp**: Feb 12 23:10 UTC
- **Result**: ~$0.04 profit

**Analysis**: Bot correctly identified a near-resolution market, bought at extreme discount, captured 50% gain in minutes/hours. **CORRECT EXECUTION.**

---

### Trade 2: Asset 573859... — STOP LOSS (-50%)
- **Entry**: 21.35 shares @ $0.004 avg  
- **Exit**: AUTO-SELL @ $0.002 (stop-loss trigger -50%)
- **Timestamp**: Feb 12 23:28 UTC (18 minutes after TP win)
- **Result**: ~$0.04 loss

**Analysis**: Same asset, different batch. Price whipsawed from $0.006 down to $0.002. This is a **liquidity/volatility issue** on micro-cap markets resolving soon. The 50% stop-loss trigger is correct, but entering illiquid markets creates this risk.

**Lesson**: Resolution Hunter should avoid markets with <$500 liquidity or >10% spread.

---

### Trade 3: Asset 573859... — TAKE PROFIT (+76.5%)
- **Entry**: 18.65 shares @ $0.0017 avg
- **Exit**: AUTO-SELL @ $0.003 (take-profit trigger +76.5%)
- **Timestamp**: Feb 12 23:30 UTC
- **Result**: ~$0.03 profit

**Analysis**: Third entry on same asset, even lower price. Captured 76.5% gain. **CORRECT EXECUTION.** But combined with the stop-loss, this asset netted only ~$0.03 across 3 trades — high effort, low return.

---

### Trade 4: Asset 458989... — STOP LOSS (-32.3%)
- **Entry**: 40 shares @ $0.031 avg ($1.24 cost)
- **Exit**: AUTO-SELL @ $0.021 (stop-loss trigger -32.3%)
- **Timestamp**: Feb 12 23:50 UTC
- **Result**: -$0.40 loss

**Analysis**: Resolution Hunter bought a <6h resolving market at 3.1¢, expecting it to resolve YES. It dropped to 2.1¢ and triggered stop-loss. **Thesis incorrect** — either the outcome was mispriced in the opposite direction, or the market was too illiquid.

**Lesson**: 3.1¢ for a "near-certain YES" is suspiciously low. Resolution Hunter should skip markets where the "obvious" outcome is priced <5¢ — it's usually mispriced for a reason (illiquidity, ambiguous resolution criteria, or we're wrong).

---

### Resolution Hunter Summary (Day 1)
- **Trades**: 4 executions across 2 assets
- **Wins**: 2 take-profits (+50%, +76.5%)
- **Losses**: 2 stop-losses (-50%, -32.3%)
- **Net P&L**: ~-$0.37 (roughly breakeven after fees)
- **Time**: All trades within 45 minutes (23:05–23:50 UTC)

### Meta-Analysis: Was Resolution Hunter a Good Idea?
**MIXED.**

**What Worked:**
- Auto-execution on take-profit and stop-loss worked perfectly
- Identified genuinely mispriced near-resolution opportunities
- Captured 50%+ gains on 2 trades

**What Failed:**
- Illiquid markets create whipsaw risk (Trade 2)
- Suspiciously low prices (<5¢) are red flags, not opportunities (Trade 4)
- Net result after 4 trades: basically breakeven, but high cognitive load to review

**Capital Scale Issue:**
At $500 total capital, trading $0.10–$1.24 positions is not worth the execution risk and cognitive overhead. These trades are ONLY worth it at $5K+ scale where you can size them at $10–50 each.

### Rule Changes for Resolution Hunter
1. **PAUSE Resolution Hunter until capital >$2,000**
2. When re-enabled:
   - Min liquidity: $500 per market
   - Max spread: 5%
   - Skip any outcome priced <5¢ (if it's "obvious," it shouldn't be that cheap)
   - Min position size: $10 (makes wins/losses meaningful)

---

## PATTERN ANALYSIS ACROSS ALL LESSONS

### Pattern 1: Position Sizing Violations
- Gov Shutdown: 26.6% of bankroll (should be max 15%)
- Resolution Hunter: Too small (<1% each) to matter

**Root Cause**: No pre-trade position size calculator. Just eyeballing it.

**Proposed Rule**: 
**AGENTS.md addition:**
> Before entering ANY trade, calculate position size as:
> - Target allocation: 8-12% of current bankroll (default 10%)
> - Hard max: 15%
> - Hard min: 3% (below this, wait for better opportunity or larger bankroll)
> - If adding to existing position, check TOTAL position size including new shares

### Pattern 2: Early Exit on Strengthening Thesis
- Gov Shutdown exited at 96¢ when thesis was getting stronger (news confirmed shutdown likely)

**Is this good or bad?**
**GOOD at $500 scale.** 
- 15.7% in 28 hours = 234% annualized
- Final 4¢ (96→100) is only 4.2% more gain but adds binary resolution risk
- Capital velocity mandate says: take profit, redeploy

**At $5K+ scale:** Different decision. Might hold to 99¢ or resolution.

**No rule change needed.** This was correct execution.

### Pattern 3: Illiquid Markets Are Traps
- Resolution Hunter trades on micro-cap markets whipsawed despite correct thesis

**Proposed Rule:**
**AGENTS.md addition:**
> Min liquidity threshold for all trades:
> - Standard positions: $1,000 liquidity (bid+ask depth)
> - Resolution Hunter: $500 liquidity
> - Never trade markets with >10% bid-ask spread

### Pattern 4: Suspiciously Cheap "Obvious" Outcomes
- Resolution Hunter bought 3.1¢ "near-certain YES" that dropped to 2.1¢

**Heuristic**: If a market is resolving in <6 hours and the "correct" outcome is priced <5¢, **we're probably wrong or it's illiquid.**

**Proposed Rule:**
**AGENTS.md addition (Resolution Hunter section):**
> Skip any near-resolution market where the "obvious" outcome is priced <5¢. If it's that obvious, it should be 90¢+, not 3¢.

---

## RULE CHANGES FOR WEEKLY REVIEW

**Propose adding to AGENTS.md:**

### 1. Position Sizing Calculator (CRITICAL)
```
Before entering ANY trade:
1. Fetch live balance via pm_status
2. Calculate position size:
   - Target: 10% of current bankroll
   - Min: 3% (below this, skip trade)
   - Max: 15% (hard stop)
3. If adding to existing position: check TOTAL size including new shares
4. Document in trade notes: "Position size: X% of $Y bankroll"
```

### 2. Liquidity Minimums
```
Min liquidity thresholds:
- Standard trades: $1,000 combined bid+ask depth
- Resolution Hunter: $500 combined bid+ask depth  
- Max spread: 10% (skip if wider)
```

### 3. Resolution Hunter Pause & Refinements
```
Resolution Hunter: PAUSED until capital >$2,000
When re-enabled:
- Min position size: $10 (makes trades meaningful)
- Skip outcomes priced <5¢ (illiquid or we're wrong)
- Max 3 trades per 15-min cycle (not unlimited)
```

### 4. Capital Velocity Over Perfection
```
At sub-$1K scale: take profits at 80-90% of max value when thesis is intact.
- Waiting for the last 10-20% adds resolution risk
- Faster capital redeployment compounds better than holding for perfect exits
- Annualized return matters more than per-trade return
```

---

**FLAG FOR WEEKLY REVIEW:**
- Gov Shutdown position sizing violation (26.6% vs 15% max)
- Resolution Hunter needs pause until $2K+ capital
- Need pre-trade position size calculator (script or bot feature)
- All 4 pattern-based rule changes above

---

**Next Learner Session:**
Check if Gov Shutdown actually resolved YES (validates thesis fully) and if Bangladesh BNP Election resolves (currently at 99.5¢ bid, likely YES).
