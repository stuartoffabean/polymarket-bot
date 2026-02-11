use crate::domain::{Side, Signal};
use crate::strategy::{Strategy, StrategyContext};

/// Intra-market arbitrage: if sum of all outcome YES prices < $1,
/// buy all outcomes for guaranteed profit.
pub struct IntraArbStrategy {
    pub enabled: bool,
    /// Markets to monitor: (market_id, vec of token_ids for each outcome)
    pub markets: Vec<(String, Vec<String>)>,
    /// Minimum profit margin to act (e.g., 0.02 = 2 cents per dollar)
    pub min_margin: f64,
    pub max_position_pct: f64,
}

impl IntraArbStrategy {
    pub fn new(markets: Vec<(String, Vec<String>)>) -> Self {
        Self {
            enabled: true,
            markets,
            min_margin: 0.02,
            max_position_pct: 0.05,
        }
    }
}

#[async_trait::async_trait]
impl Strategy for IntraArbStrategy {
    fn name(&self) -> &str {
        "intra_arb"
    }

    fn enabled(&self) -> bool {
        self.enabled
    }

    async fn evaluate(&self, ctx: &StrategyContext) -> Vec<Signal> {
        let mut signals = Vec::new();

        for (market_id, token_ids) in &self.markets {
            // Get prices for all outcomes
            let prices: Vec<(String, f64)> = token_ids
                .iter()
                .filter_map(|tid| {
                    ctx.prices.get(tid).map(|&p| (tid.clone(), p))
                })
                .collect();

            // Need prices for all outcomes
            if prices.len() != token_ids.len() {
                continue;
            }

            let total: f64 = prices.iter().map(|(_, p)| p).sum();

            // If sum of YES prices < 1.0 - margin, there's an arb
            if total < 1.0 - self.min_margin {
                let profit_per_dollar = 1.0 - total;
                let max_size = ctx.bankroll * self.max_position_pct;
                // Size in terms of "sets" — buy $size of each outcome
                let size = max_size.min(ctx.bankroll * 0.10); // conservative

                for (token_id, price) in &prices {
                    signals.push(Signal {
                        strategy: self.name().to_string(),
                        market_id: market_id.clone(),
                        side: Side::Buy,
                        confidence: profit_per_dollar.min(1.0),
                        price: *price,
                        size: size * price, // dollar amount for this leg
                    });
                }

                tracing::info!(
                    "Intra-arb found: market={}, total={:.4}, profit={:.4}",
                    market_id,
                    total,
                    profit_per_dollar
                );
            }
        }

        signals
    }
}
