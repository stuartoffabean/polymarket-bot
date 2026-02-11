use crate::domain::{Side, Signal};
use crate::strategy::{Strategy, StrategyContext};

/// Crypto latency arbitrage: compare Binance spot vs Polymarket crypto markets.
/// When Binance moves but Polymarket hasn't repriced yet, trade the stale price.
pub struct LatencyArbStrategy {
    pub enabled: bool,
    /// Polymarket market ID for the crypto market we're trading
    pub market_id: String,
    /// The token_id for YES outcome
    pub yes_token_id: String,
    /// The token_id for NO outcome
    pub no_token_id: String,
    /// Binance symbol to watch (e.g. "BTCUSDT")
    pub binance_symbol: String,
    /// The threshold price in the Polymarket market (e.g. "Will BTC be above $X?")
    pub threshold_price: f64,
    /// Minimum edge required (fraction past threshold, e.g. 0.02 = 2%)
    pub min_edge_pct: f64,
    /// Max fraction of bankroll per position
    pub max_position_pct: f64,
}

impl LatencyArbStrategy {
    pub fn new(
        market_id: String,
        yes_token_id: String,
        no_token_id: String,
        binance_symbol: String,
        threshold_price: f64,
    ) -> Self {
        Self {
            enabled: true,
            market_id,
            yes_token_id,
            no_token_id,
            binance_symbol,
            threshold_price,
            min_edge_pct: 0.02,
            max_position_pct: 0.05,
        }
    }

    /// Kelly criterion position sizing: f* = (bp - q) / b
    /// where b = odds, p = probability of winning, q = 1-p
    fn kelly_size(&self, confidence: f64, price: f64, bankroll: f64) -> f64 {
        if price <= 0.0 || price >= 1.0 || confidence <= 0.0 {
            return 0.0;
        }
        let b = (1.0 / price) - 1.0; // payout odds
        let p = confidence;
        let q = 1.0 - p;
        let kelly = (b * p - q) / b;
        let kelly = kelly.max(0.0);
        // Cap at max_position_pct of bankroll, and use half-Kelly for safety
        let half_kelly = kelly * 0.5;
        let max_size = bankroll * self.max_position_pct;
        let size = (half_kelly * bankroll).min(max_size);
        size.max(0.0)
    }
}

#[async_trait::async_trait]
impl Strategy for LatencyArbStrategy {
    fn name(&self) -> &str {
        "latency_arb"
    }

    fn enabled(&self) -> bool {
        self.enabled
    }

    async fn evaluate(&self, ctx: &StrategyContext) -> Vec<Signal> {
        let mut signals = Vec::new();

        // Get Binance spot price
        let spot_price = match ctx.binance_prices.get(&self.binance_symbol) {
            Some(&p) => p,
            None => return signals,
        };

        // Get current Polymarket YES price
        let poly_yes_price = match ctx.prices.get(&self.yes_token_id) {
            Some(&p) => p,
            None => return signals,
        };

        // Check if already have a position in this market
        let has_position = ctx
            .positions
            .iter()
            .any(|p| p.market_id == self.market_id && p.size > 0.0);
        if has_position {
            return signals;
        }

        // Strategy logic:
        // If spot is significantly ABOVE threshold → YES should be worth ~1.0
        // If Polymarket YES price is still low → BUY YES
        let edge_above = (spot_price - self.threshold_price) / self.threshold_price;
        let edge_below = (self.threshold_price - spot_price) / self.threshold_price;

        if edge_above > self.min_edge_pct && poly_yes_price < 0.90 {
            // Spot is well above threshold, YES should resolve to 1.0
            let confidence = (0.5 + edge_above * 5.0).min(0.95);
            let size = self.kelly_size(confidence, poly_yes_price, ctx.bankroll);
            if size > 1.0 {
                signals.push(Signal {
                    strategy: self.name().to_string(),
                    market_id: self.market_id.clone(),
                    side: Side::Buy,
                    confidence,
                    price: poly_yes_price,
                    size,
                });
            }
        } else if edge_below > self.min_edge_pct && poly_yes_price > 0.10 {
            // Spot is well below threshold, NO should resolve to 1.0
            let poly_no_price = 1.0 - poly_yes_price;
            let confidence = (0.5 + edge_below * 5.0).min(0.95);
            let size = self.kelly_size(confidence, poly_no_price, ctx.bankroll);
            if size > 1.0 {
                signals.push(Signal {
                    strategy: self.name().to_string(),
                    market_id: self.market_id.clone(),
                    side: Side::Sell, // Selling YES ≈ Buying NO
                    confidence,
                    price: poly_yes_price,
                    size,
                });
            }
        }

        signals
    }
}
