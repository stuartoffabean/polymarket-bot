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

---

## 2026-02-15 — RPC Single-Point-of-Failure Fix (Infrastructure)

### What Happened
After the duplicate-sell fix (commit 7341b09), the system restarted cleanly — the grace period worked, no false sells fired. But the system got stuck in warmup and could never become operational. The executor kept crashing and restarting (28+ times) because it couldn't fetch the cash balance.

### Root Cause: Your Fix Didn't Cover This
Your duplicate-sell fix (fill verification, cooldown guard, unfilled order cancellation) was **correct and solid** — that logic is good. The warmup stall was a separate, pre-existing infrastructure bug.

The `/balance` endpoint in `executor/index.js` used a **single hardcoded RPC** (`https://polygon-rpc.com`) with zero fallback:

```js
// BEFORE (broken)
const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com");
```

When that one provider went down, every `fetchCashBalance()` call from ws-feed returned `$0.00`, and `checkSystemReady()` refused to exit warmup (lines 926-936 in ws-feed.js) because it correctly treats `$0` cash as suspicious.

The 2-minute timeout at line 930 *should* have eventually let the system proceed, but the executor itself kept crashing and restarting — each restart reset the warmup timer back to zero. So the timeout never got a chance to fire.

**Irony:** You already had fallback RPC logic in `autoRedeem()` with 3 providers and a retry loop. But the `/balance` endpoint and the portfolio fallback function never got the same treatment.

### What Was Fixed
1. **Shared RPC fallback helper** (`getPolygonProvider()`) at the top of `executor/index.js` — cycles through 4 Polygon RPC providers (`polygon-rpc.com`, `publicnode.com`, `ankr.com`, `1rpc.io/matic`) with connectivity verification before returning
2. **`/balance` endpoint** now uses `getPolygonProvider()` instead of hardcoded single RPC
3. **Portfolio fallback** (the `chain+cache` path) also uses `getPolygonProvider()`
4. **`autoRedeem()`** consolidated to use the same shared helper instead of its own local RPC list

### Why This Matters
- If the primary RPC is down, the system now automatically tries 3 alternatives before failing
- Cash balance fetches succeed even during provider outages → warmup completes → system becomes operational
- All on-chain RPC usage in the executor is now centralized in one place — no more scattered hardcoded URLs to forget about

### Rule Change
**INFRA-001**: Every on-chain RPC call must use a fallback provider list, never a single hardcoded URL. When adding new RPC-dependent code, use `getPolygonProvider()`.

---

## 2026-02-16 — Phantom Sell Fix (Crime 101 Incident)

### What Happened
Crime 101 position: cron auto-bought 75 shares @ 49¢, price dropped to 35.8¢ in 60 seconds, stop-loss fired. The sell was logged as `SELL_EXECUTED` and the position was removed from tracking — but 45 shares were still on-chain. This is the "phantom sell" bug.

### Root Causes Found (2 bugs)

**Bug 1 — Executor `/market-sell`: ledger writes could crash the response.**
After the CLOB order was submitted and filled, the executor ran `logExit()` and `positionLedger.recordExit()` — both do disk I/O — *without* try/catch. If either threw (disk error, JSON parse failure, etc.), the HTTP response was never sent back to ws-feed. ws-feed's `httpPost` would see a broken connection, treat it as a network error, and **retry the sell** — but the original order already went through on-chain. This is how you get a phantom sell: the CLOB fills the order, the response never reaches ws-feed, ws-feed retries, the second attempt either fails (shares already sold) or sells more.

The same bug existed in the generic `/order` endpoint and in the WAL (write-ahead log): `resolveIntent(walId, "filled", ...)` was called BEFORE checking the CLOB's `status` field, so the audit trail always logged "filled" even for unfilled orders.

**Bug 2 — No post-sell verification.**
ws-feed blindly trusted the executor's `fillStatus: "filled"` response and immediately removed the position from tracking + blocked re-sync for 2 hours via `recentlySold`. If the CLOB returned "matched" but the fill didn't actually settle (which Polymarket's CLOB is known to do), the position became invisible to the bot while still existing on-chain.

### What Was Fixed

1. **Ledger writes wrapped in try/catch** — `logExit()`, `positionLedger.recordExit()`, `invalidateTradeCache()` in `/market-sell` are now inside try/catch. If they throw, the error is logged but the HTTP response (with correct `fillStatus`) is always sent back to ws-feed. Same fix applied to `/order` endpoint.

2. **WAL `resolveIntent` moved after fill check** — both `/market-sell` and `/order` now check the CLOB's actual `status` field before logging the intent resolution. No more premature "filled" entries in the audit trail.

3. **Phantom sell detection** — after ws-feed receives a "filled" sell response and removes the position, a 15-second delayed verification fires. It queries the executor's `/positions` endpoint (which uses the Polymarket data API as ground truth). If the position still exists on-chain with > 0.1 shares:
   - Clears the `recentlySold` entry
   - Re-adds the position to tracking with stop-loss reset
   - Sets a 1-minute cooldown before allowing re-triggers
   - Fires a `PHANTOM_SELL` Telegram alert

### Rule Changes
**EXEC-001**: Every HTTP endpoint that submits orders to the CLOB must have all post-order I/O (ledger writes, cache invalidation) in try/catch blocks. The HTTP response to the caller must ALWAYS be sent, regardless of logging failures.

**EXEC-002**: Never trust CLOB fill status alone. Always verify on-chain state after a "filled" sell before considering a position fully closed.

---
