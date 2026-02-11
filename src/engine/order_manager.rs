use chrono::Utc;
use eyre::Result;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::adapters::database::Database;
use crate::adapters::polymarket::PolymarketClient;
use crate::domain::{Order, OrderStatus, OrderType, Signal, Side, Trade};
use crate::engine::risk::RiskManager;

pub struct OrderManager {
    poly_client: PolymarketClient,
    db: Database,
    risk: RiskManager,
    bankroll: Arc<RwLock<f64>>,
    signal_rx: broadcast::Receiver<Signal>,
}

impl OrderManager {
    pub fn new(
        poly_client: PolymarketClient,
        db: Database,
        risk: RiskManager,
        bankroll: Arc<RwLock<f64>>,
        signal_rx: broadcast::Receiver<Signal>,
    ) -> Self {
        Self {
            poly_client,
            db,
            risk,
            bankroll,
            signal_rx,
        }
    }

    pub async fn run(mut self) -> Result<()> {
        info!("Order manager started");

        loop {
            match self.signal_rx.recv().await {
                Ok(signal) => {
                    if let Err(e) = self.handle_signal(signal).await {
                        error!("Error handling signal: {:?}", e);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!("Order manager lagged by {} signals", n);
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!("Signal channel closed, order manager shutting down");
                    break;
                }
            }
        }

        Ok(())
    }

    async fn handle_signal(&self, signal: Signal) -> Result<()> {
        let current_bankroll = *self.bankroll.read().await;

        // Calculate total exposure from open positions
        let positions = self.db.get_positions().await?;
        let total_exposure: f64 = positions.iter().map(|p| p.size * p.avg_price).sum();

        // Risk check
        if !self.risk.check_signal(&signal, current_bankroll, total_exposure).await? {
            info!(
                "Signal rejected by risk manager: {} {} on {}",
                signal.side, signal.strategy, signal.market_id
            );
            return Ok(());
        }

        info!(
            "Executing signal: {} {} {:.2}@{:.4} on {} (confidence: {:.2}%)",
            signal.strategy,
            signal.side,
            signal.size,
            signal.price,
            signal.market_id,
            signal.confidence * 100.0
        );

        // Determine token_id based on side
        // For now, signal.market_id is used; in practice we'd look up the token
        let token_id = &signal.market_id; // TODO: map market_id to correct token_id

        // Create order record
        let order = Order {
            id: Uuid::new_v4().to_string(),
            market_id: signal.market_id.clone(),
            side: signal.side.clone(),
            token_id: token_id.clone(),
            price: signal.price,
            size: signal.size,
            order_type: OrderType::GTC,
            status: OrderStatus::Pending,
            created_at: Utc::now(),
        };

        self.db.insert_order(&order).await?;

        // Submit to Polymarket
        match self
            .poly_client
            .post_order(
                &order.token_id,
                order.price,
                order.size,
                order.side.clone(),
                OrderType::GTC,
            )
            .await
        {
            Ok(resp) => {
                if resp.success {
                    let remote_id = resp.order_id.unwrap_or_default();
                    info!("Order submitted: {} → remote {}", order.id, remote_id);
                    self.db
                        .update_order_status(&order.id, &OrderStatus::Open)
                        .await?;

                    // Record as trade (simplified — in production, wait for fill confirmation)
                    let trade = Trade {
                        id: Uuid::new_v4().to_string(),
                        order_id: order.id.clone(),
                        market_id: order.market_id.clone(),
                        side: order.side.clone(),
                        price: order.price,
                        size: order.size,
                        fee: order.size * order.price * 0.002, // ~20bps fee estimate
                        timestamp: Utc::now(),
                    };
                    self.db.insert_trade(&trade).await?;
                } else {
                    let msg = resp.error_msg.unwrap_or_default();
                    error!("Order rejected: {}", msg);
                    self.db
                        .update_order_status(&order.id, &OrderStatus::Failed)
                        .await?;
                }
            }
            Err(e) => {
                error!("Order submission failed: {:?}", e);
                self.db
                    .update_order_status(&order.id, &OrderStatus::Failed)
                    .await?;
            }
        }

        Ok(())
    }

    /// Emergency: cancel all open orders
    pub async fn cancel_all(&self) -> Result<()> {
        warn!("CANCELLING ALL ORDERS");
        self.poly_client.cancel_all().await?;

        // Update local DB
        let open_orders = self.db.get_open_orders().await?;
        for order in open_orders {
            self.db
                .update_order_status(&order.id, &OrderStatus::Cancelled)
                .await?;
        }

        Ok(())
    }
}
