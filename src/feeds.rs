use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};

use crate::domain::{MarketData, OrderBook, Signal};
use crate::strategy::{Strategy, StrategyContext};

/// Aggregates market data and drives strategy evaluation
pub struct FeedAggregator {
    market_rx: broadcast::Receiver<MarketData>,
    signal_tx: broadcast::Sender<Signal>,
    strategies: Vec<Box<dyn Strategy>>,
    bankroll: Arc<RwLock<f64>>,
    prices: Arc<RwLock<HashMap<String, f64>>>,
    orderbooks: Arc<RwLock<HashMap<String, OrderBook>>>,
    binance_prices: Arc<RwLock<HashMap<String, f64>>>,
}

impl FeedAggregator {
    pub fn new(
        market_rx: broadcast::Receiver<MarketData>,
        signal_tx: broadcast::Sender<Signal>,
        strategies: Vec<Box<dyn Strategy>>,
        bankroll: Arc<RwLock<f64>>,
    ) -> Self {
        Self {
            market_rx,
            signal_tx,
            strategies,
            bankroll,
            prices: Arc::new(RwLock::new(HashMap::new())),
            orderbooks: Arc::new(RwLock::new(HashMap::new())),
            binance_prices: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn run(mut self) {
        info!("Feed aggregator started with {} strategies", self.strategies.len());

        loop {
            match self.market_rx.recv().await {
                Ok(event) => {
                    self.update_state(&event).await;
                    self.run_strategies(&event).await;
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!("Feed aggregator lagged by {} events", n);
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!("Market data channel closed, feed aggregator shutting down");
                    break;
                }
            }
        }
    }

    async fn update_state(&self, event: &MarketData) {
        match event {
            MarketData::PolymarketPrice { token_id, price, .. } => {
                self.prices.write().await.insert(token_id.clone(), *price);
            }
            MarketData::PolymarketOrderBook { token_id, book, .. } => {
                self.orderbooks.write().await.insert(token_id.clone(), book.clone());
            }
            MarketData::BinanceTicker { symbol, price, .. } => {
                self.binance_prices.write().await.insert(symbol.clone(), *price);
            }
        }
    }

    async fn run_strategies(&self, event: &MarketData) {
        let ctx = StrategyContext {
            bankroll: *self.bankroll.read().await,
            positions: Vec::new(), // TODO: load from DB
            prices: self.prices.read().await.clone(),
            orderbooks: self.orderbooks.read().await.clone(),
            binance_prices: self.binance_prices.read().await.clone(),
            latest_event: Some(event.clone()),
        };

        for strategy in &self.strategies {
            if !strategy.enabled() {
                continue;
            }

            let signals = strategy.evaluate(&ctx).await;
            for signal in signals {
                info!(
                    "Signal from {}: {} {} {:.2}@{:.4} (conf: {:.1}%)",
                    signal.strategy, signal.side, signal.market_id,
                    signal.size, signal.price, signal.confidence * 100.0
                );
                let _ = self.signal_tx.send(signal);
            }
        }
    }
}
