pub mod latency_arb;
pub mod intra_arb;

use std::collections::HashMap;
use crate::domain::{MarketData, OrderBook, Position, Signal};

/// Context passed to strategies for evaluation
#[derive(Debug, Clone)]
pub struct StrategyContext {
    pub bankroll: f64,
    pub positions: Vec<Position>,
    pub prices: HashMap<String, f64>,           // token_id -> price
    pub orderbooks: HashMap<String, OrderBook>,  // token_id -> orderbook
    pub binance_prices: HashMap<String, f64>,    // symbol -> price
    pub latest_event: Option<MarketData>,
}

impl StrategyContext {
    pub fn new(bankroll: f64) -> Self {
        Self {
            bankroll,
            positions: Vec::new(),
            prices: HashMap::new(),
            orderbooks: HashMap::new(),
            binance_prices: HashMap::new(),
            latest_event: None,
        }
    }
}

#[async_trait::async_trait]
pub trait Strategy: Send + Sync {
    fn name(&self) -> &str;
    async fn evaluate(&self, ctx: &StrategyContext) -> Vec<Signal>;
    fn enabled(&self) -> bool;
}
