use chrono::Utc;
use eyre::Result;
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
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

/// Binance endpoint rotation: try .us first (US-friendly), then .com
const WS_ENDPOINTS: &[&str] = &[
    "wss://stream.binance.us:9443/stream?streams=",
    "wss://stream.binance.com:9443/stream?streams=",
];

const REST_ENDPOINTS: &[&str] = &[
    "https://api.binance.us/api/v3/ticker/price",
    "https://api.binance.com/api/v3/ticker/price",
];

impl BinanceWsFeed {
    pub fn new(tx: broadcast::Sender<MarketData>, symbols: Vec<String>) -> Self {
        Self { tx, symbols }
    }

    pub async fn run(self) -> Result<()> {
        let mut backoff_ms: u64 = 1000;

        loop {
            // Try WebSocket first, fall back to REST polling
            match self.try_websocket().await {
                Ok(()) => {
                    backoff_ms = 1000;
                }
                Err(e) => {
                    warn!("All WS endpoints failed: {:?}. Falling back to REST polling.", e);
                    match self.rest_poll_loop().await {
                        Ok(()) => { backoff_ms = 1000; }
                        Err(e2) => { error!("REST polling failed: {:?}", e2); }
                    }
                }
            }

            warn!("Reconnecting price feed in {}ms", backoff_ms);
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms * 2).min(30_000);
        }
    }

    async fn try_websocket(&self) -> Result<()> {
        let streams: Vec<String> = self
            .symbols
            .iter()
            .map(|s| format!("{}@ticker", s.to_lowercase()))
            .collect();
        let stream_path = streams.join("/");

        for endpoint in WS_ENDPOINTS {
            let url = format!("{}{}", endpoint, stream_path);
            info!("Trying WS endpoint: {}", endpoint.split('/').nth(2).unwrap_or("unknown"));

            match connect_async(&url).await {
                Ok((ws_stream, _)) => {
                    info!("Connected to price WS for {:?}", self.symbols);
                    let (mut write, mut read) = ws_stream.split();

                    while let Some(msg) = read.next().await {
                        match msg {
                            Ok(Message::Text(text)) => {
                                self.handle_message(&text);
                            }
                            Ok(Message::Ping(data)) => {
                                let _ = write.send(Message::Pong(data)).await;
                            }
                            Ok(Message::Close(_)) => {
                                info!("Price WS closed by server");
                                break;
                            }
                            Err(e) => {
                                error!("Price WS read error: {:?}", e);
                                break;
                            }
                            _ => {}
                        }
                    }
                    return Ok(());
                }
                Err(e) => {
                    warn!("WS endpoint failed: {:?}", e);
                    continue;
                }
            }
        }

        Err(eyre::eyre!("All WebSocket endpoints unreachable"))
    }

    /// Fallback: poll REST API every 2 seconds
    async fn rest_poll_loop(&self) -> Result<()> {
        let client = Client::new();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
        let mut failures = 0u32;

        info!("Starting REST price polling for {:?}", self.symbols);

        loop {
            interval.tick().await;

            let mut got_price = false;
            for endpoint in REST_ENDPOINTS {
                for symbol in &self.symbols {
                    let url = format!("{}?symbol={}", endpoint, symbol.to_uppercase());
                    match client.get(&url).timeout(std::time::Duration::from_secs(5)).send().await {
                        Ok(resp) if resp.status().is_success() => {
                            if let Ok(body) = resp.text().await {
                                self.handle_rest_price(&body);
                                got_price = true;
                            }
                        }
                        _ => continue,
                    }
                }
                if got_price { break; }
            }

            if got_price {
                failures = 0;
            } else {
                failures += 1;
                if failures > 30 {
                    return Err(eyre::eyre!("REST polling failed 30 consecutive times"));
                }
            }
        }
    }

    fn handle_rest_price(&self, text: &str) {
        #[derive(Deserialize)]
        struct PriceTicker {
            symbol: String,
            price: String,
        }

        if let Ok(t) = serde_json::from_str::<PriceTicker>(text) {
            if let Ok(price) = t.price.parse::<f64>() {
                let _ = self.tx.send(MarketData::BinanceTicker {
                    symbol: t.symbol,
                    price,
                    timestamp: Utc::now(),
                });
            }
        }
    }

    fn handle_message(&self, text: &str) {
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
