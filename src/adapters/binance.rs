use chrono::Utc;
use eyre::Result;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

use crate::domain::MarketData;

#[derive(Debug, Deserialize)]
struct BinanceTicker {
    #[serde(rename = "s")]
    symbol: String,
    #[serde(rename = "c")]
    last_price: String,
}

pub struct BinanceWsFeed {
    tx: broadcast::Sender<MarketData>,
    symbols: Vec<String>,
}

impl BinanceWsFeed {
    pub fn new(tx: broadcast::Sender<MarketData>, symbols: Vec<String>) -> Self {
        Self { tx, symbols }
    }

    pub async fn run(self) -> Result<()> {
        let mut backoff_ms: u64 = 1000;

        loop {
            match self.connect_and_listen().await {
                Ok(()) => {
                    info!("Binance WS disconnected cleanly");
                    backoff_ms = 1000;
                }
                Err(e) => {
                    error!("Binance WS error: {:?}", e);
                }
            }

            warn!("Reconnecting Binance WS in {}ms", backoff_ms);
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms * 2).min(30_000);
        }
    }

    async fn connect_and_listen(&self) -> Result<()> {
        let streams: Vec<String> = self
            .symbols
            .iter()
            .map(|s| format!("{}@ticker", s.to_lowercase()))
            .collect();
        let url = format!(
            "wss://stream.binance.com:9443/stream?streams={}",
            streams.join("/")
        );

        let (ws_stream, _) = connect_async(&url).await?;
        let (mut write, mut read) = ws_stream.split();

        info!("Connected to Binance WS for {:?}", self.symbols);

        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    self.handle_message(&text);
                }
                Ok(Message::Ping(data)) => {
                    let _ = write.send(Message::Pong(data)).await;
                }
                Ok(Message::Close(_)) => {
                    info!("Binance WS closed by server");
                    break;
                }
                Err(e) => {
                    error!("Binance WS read error: {:?}", e);
                    break;
                }
                _ => {}
            }
        }

        Ok(())
    }

    fn handle_message(&self, text: &str) {
        // Binance combined stream wraps in {"stream":"...","data":{...}}
        #[derive(Deserialize)]
        struct Combined {
            data: BinanceTicker,
        }

        let ticker = if let Ok(combined) = serde_json::from_str::<Combined>(text) {
            combined.data
        } else if let Ok(t) = serde_json::from_str::<BinanceTicker>(text) {
            t
        } else {
            return;
        };

        if let Ok(price) = ticker.last_price.parse::<f64>() {
            let _ = self.tx.send(MarketData::BinanceTicker {
                symbol: ticker.symbol,
                price,
                timestamp: Utc::now(),
            });
        }
    }
}
