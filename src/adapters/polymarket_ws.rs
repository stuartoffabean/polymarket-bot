use chrono::Utc;
use eyre::Result;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

use crate::domain::{BookLevel, MarketData, OrderBook};

const WS_URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

#[derive(Debug, Deserialize)]
struct WsMessage {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    market: Option<String>,
    asset_id: Option<String>,
    price: Option<String>,
    bids: Option<Vec<WsLevel>>,
    asks: Option<Vec<WsLevel>>,
}

#[derive(Debug, Deserialize)]
struct WsLevel {
    price: String,
    size: String,
}

pub struct PolymarketWsFeed {
    tx: broadcast::Sender<MarketData>,
    market_ids: Vec<String>,
}

impl PolymarketWsFeed {
    pub fn new(tx: broadcast::Sender<MarketData>, market_ids: Vec<String>) -> Self {
        Self { tx, market_ids }
    }

    pub async fn run(self) -> Result<()> {
        let mut backoff_ms: u64 = 1000;

        loop {
            match self.connect_and_listen().await {
                Ok(()) => {
                    info!("Polymarket WS disconnected cleanly");
                    backoff_ms = 1000;
                }
                Err(e) => {
                    error!("Polymarket WS error: {:?}", e);
                }
            }

            warn!("Reconnecting Polymarket WS in {}ms", backoff_ms);
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms * 2).min(30_000);
        }
    }

    async fn connect_and_listen(&self) -> Result<()> {
        let (ws_stream, _) = connect_async(WS_URL).await?;
        let (mut write, mut read) = ws_stream.split();

        info!("Connected to Polymarket WS");

        // Subscribe to markets
        for market_id in &self.market_ids {
            let sub = serde_json::json!({
                "type": "subscribe",
                "market": market_id,
                "channel": "market"
            });
            write.send(Message::Text(sub.to_string().into())).await?;
        }

        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if let Err(e) = self.handle_message(&text) {
                        warn!("Failed to parse Polymarket WS message: {:?}", e);
                    }
                }
                Ok(Message::Ping(data)) => {
                    let _ = write.send(Message::Pong(data)).await;
                }
                Ok(Message::Close(_)) => {
                    info!("Polymarket WS closed by server");
                    break;
                }
                Err(e) => {
                    error!("Polymarket WS read error: {:?}", e);
                    break;
                }
                _ => {}
            }
        }

        Ok(())
    }

    fn handle_message(&self, text: &str) -> Result<()> {
        let msg: WsMessage = serde_json::from_str(text)?;

        let market_id = msg.market.unwrap_or_default();
        let asset_id = msg.asset_id.unwrap_or_default();

        match msg.msg_type.as_deref() {
            Some("price") => {
                if let Some(price_str) = msg.price {
                    if let Ok(price) = price_str.parse::<f64>() {
                        let _ = self.tx.send(MarketData::PolymarketPrice {
                            market_id,
                            token_id: asset_id,
                            price,
                            timestamp: Utc::now(),
                        });
                    }
                }
            }
            Some("book") => {
                let parse_levels = |levels: Option<Vec<WsLevel>>| -> Vec<BookLevel> {
                    levels
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|l| {
                            Some(BookLevel {
                                price: l.price.parse().ok()?,
                                size: l.size.parse().ok()?,
                            })
                        })
                        .collect()
                };

                let book = OrderBook {
                    bids: parse_levels(msg.bids),
                    asks: parse_levels(msg.asks),
                    timestamp: Utc::now(),
                };

                let _ = self.tx.send(MarketData::PolymarketOrderBook {
                    market_id,
                    token_id: asset_id,
                    book,
                });
            }
            _ => {}
        }

        Ok(())
    }
}
