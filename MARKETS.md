# Target Markets Analysis — Feb 11, 2026

## Strategy 1: Latency Arb (Binance ↔ Polymarket Crypto)

### Bitcoin $150K February
- **Slug**: `will-bitcoin-reach-150k-in-february-2026`
- **YES price**: 0.0025 (0.25%)
- **Liquidity**: $1.24M
- **24h Vol**: $975K
- **Ends**: Mar 1, 2026
- **Token IDs**:
  - YES: `37297213992198847758335843642137412014662841314020423585709724457305615671955`
  - NO: `85285091029101061598102453878417748165438482105623263900746828987387745601127`
- **Edge**: BTC at ~$97K, needs 54% move in 17 days. Price is fair at 0.25%.
  Latency arb only works if BTC makes sudden large moves toward $150K.
  LOW PRIORITY — spread too tight, price too accurate.

### Need to find: BTC monthly/weekly threshold markets
- Short-duration crypto price threshold markets are ideal for latency arb
- 15-min "Up or Down" markets exist but may have low liquidity

## Strategy 2: Intra-Market Arb (Multi-Outcome Sum != $1)

### Fed Rate March 2026 (negRisk market)
- **negRiskMarketID**: `0xfabe717b4c1799d917420cf834a4...`
- **Outcomes**:
  - 50+ bps decrease: YES 0.65¢
  - 25 bps decrease: YES 7.5¢
  - No change: YES 91.5¢
  - 25+ bps increase: YES 0.65¢
- **Sum**: 1.003 (slightly over $1 — NO arb right now)
- **Action**: Monitor. When sum dips below 0.98, buy all outcomes.

### Fed Chair Nomination (negRisk market)
- **negRiskMarketID**: `0x4714f4189125bba4cb9e6f9e8b5757ebd34a5be31379c33a665e4b0ca9738600`
- **24h Vol**: $9.8M (huge!)
- **Top candidates**: Kevin Hassett, Kevin Warsh, Judy Shelton, others
- **Action**: Monitor sum of all candidate YES prices

## Strategy 3: News-Driven Edge (Manual/Semi-Auto)
- US strikes Iran markets: multiple expiry dates
- Putin-Zelenskyy meeting
- These require news monitoring, not pure automation

## Priority
1. Get bot running first
2. Configure latency_arb for BTC markets with tight thresholds
3. Configure intra_arb for Fed rate + Fed chair markets
4. Monitor for opportunities, start with small limit orders
