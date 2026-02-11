use base64::Engine;
use chrono::Utc;
use eyre::{Result, WrapErr};
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::sync::Arc;

use crate::config::Config;
use crate::domain::{BookLevel, OrderBook, OrderType, Side};

const BASE_URL: &str = "https://clob.polymarket.com";

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct PolymarketClient {
    client: Client,
    config: Arc<Config>,
}

#[derive(Debug, Serialize)]
struct OrderRequest {
    #[serde(rename = "tokenID")]
    token_id: String,
    price: f64,
    size: f64,
    side: String,
    #[serde(rename = "orderType")]
    order_type: String,
    #[serde(rename = "feeRateBps", skip_serializing_if = "Option::is_none")]
    fee_rate_bps: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct OrderResponse {
    pub success: bool,
    #[serde(rename = "orderID")]
    pub order_id: Option<String>,
    #[serde(rename = "errorMsg")]
    pub error_msg: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PriceResponse {
    pub price: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MidpointResponse {
    pub mid: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OrderBookResponse {
    pub bids: Option<Vec<OrderBookLevel>>,
    pub asks: Option<Vec<OrderBookLevel>>,
}

#[derive(Debug, Deserialize)]
struct OrderBookLevel {
    pub price: String,
    pub size: String,
}

#[derive(Debug, Deserialize)]
pub struct OpenOrder {
    pub id: String,
    #[serde(rename = "tokenID")]
    pub token_id: String,
    pub price: String,
    pub size: String,
    pub side: String,
}

impl PolymarketClient {
    pub fn new(config: Arc<Config>) -> Result<Self> {
        let client = Client::builder()
            .pool_max_idle_per_host(5)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .wrap_err("Failed to build HTTP client")?;

        Ok(Self { client, config })
    }

    fn sign(&self, timestamp: &str, method: &str, path: &str, body: &str) -> Result<String> {
        let message = format!("{}{}{}{}", timestamp, method, path, body);
        let secret_bytes = base64::engine::general_purpose::STANDARD
            .decode(&self.config.polymarket_secret)
            .wrap_err("Failed to decode API secret")?;
        let mut mac = HmacSha256::new_from_slice(&secret_bytes)
            .wrap_err("Invalid HMAC key")?;
        mac.update(message.as_bytes());
        let result = mac.finalize();
        Ok(base64::engine::general_purpose::STANDARD.encode(result.into_bytes()))
    }

    fn auth_headers(
        &self,
        method: &str,
        path: &str,
        body: &str,
    ) -> Result<Vec<(String, String)>> {
        let timestamp = Utc::now().timestamp().to_string();
        let signature = self.sign(&timestamp, method, path, body)?;

        Ok(vec![
            ("POLY-ADDRESS".into(), self.config.private_key.clone()),
            ("POLY-SIGNATURE".into(), signature),
            ("POLY-TIMESTAMP".into(), timestamp),
            ("POLY-API-KEY".into(), self.config.polymarket_api_key.clone()),
            (
                "POLY-PASSPHRASE".into(),
                self.config.polymarket_passphrase.clone(),
            ),
        ])
    }

    pub async fn get_price(&self, token_id: &str) -> Result<f64> {
        let path = format!("/price?token_id={}", token_id);
        let url = format!("{}{}", BASE_URL, path);

        let resp: PriceResponse = self
            .client
            .get(&url)
            .send()
            .await
            .wrap_err("get_price request failed")?
            .json()
            .await
            .wrap_err("get_price parse failed")?;

        resp.price
            .ok_or_else(|| eyre::eyre!("No price returned"))
            .and_then(|p| p.parse::<f64>().map_err(|e| eyre::eyre!(e)))
    }

    pub async fn get_midpoint(&self, token_id: &str) -> Result<f64> {
        let path = format!("/midpoint?token_id={}", token_id);
        let url = format!("{}{}", BASE_URL, path);

        let resp: MidpointResponse = self
            .client
            .get(&url)
            .send()
            .await
            .wrap_err("get_midpoint request failed")?
            .json()
            .await
            .wrap_err("get_midpoint parse failed")?;

        resp.mid
            .ok_or_else(|| eyre::eyre!("No midpoint returned"))
            .and_then(|p| p.parse::<f64>().map_err(|e| eyre::eyre!(e)))
    }

    pub async fn get_orderbook(&self, token_id: &str) -> Result<OrderBook> {
        let path = format!("/book?token_id={}", token_id);
        let url = format!("{}{}", BASE_URL, path);

        let resp: OrderBookResponse = self
            .client
            .get(&url)
            .send()
            .await
            .wrap_err("get_orderbook request failed")?
            .json()
            .await
            .wrap_err("get_orderbook parse failed")?;

        let parse_levels = |levels: Option<Vec<OrderBookLevel>>| -> Vec<BookLevel> {
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

        Ok(OrderBook {
            bids: parse_levels(resp.bids),
            asks: parse_levels(resp.asks),
            timestamp: Utc::now(),
        })
    }

    pub async fn post_order(
        &self,
        token_id: &str,
        price: f64,
        size: f64,
        side: Side,
        order_type: OrderType,
    ) -> Result<OrderResponse> {
        let path = "/order";
        let side_str = match side {
            Side::Buy => "BUY",
            Side::Sell => "SELL",
        };
        let ot_str = match order_type {
            OrderType::GTC => "GTC",
            OrderType::GTD => "GTD",
            OrderType::FOK => "FOK",
        };

        let req = OrderRequest {
            token_id: token_id.to_string(),
            price,
            size,
            side: side_str.to_string(),
            order_type: ot_str.to_string(),
            fee_rate_bps: None,
        };

        let body = serde_json::to_string(&req)?;
        let headers = self.auth_headers("POST", path, &body)?;
        let url = format!("{}{}", BASE_URL, path);

        let mut builder = self.client.post(&url).body(body.clone()).header("Content-Type", "application/json");
        for (k, v) in headers {
            builder = builder.header(&k, &v);
        }

        let resp: OrderResponse = builder
            .send()
            .await
            .wrap_err("post_order request failed")?
            .json()
            .await
            .wrap_err("post_order parse failed")?;

        Ok(resp)
    }

    pub async fn cancel_order(&self, order_id: &str) -> Result<bool> {
        let path = "/order";
        let body = serde_json::json!({ "orderID": order_id }).to_string();
        let headers = self.auth_headers("DELETE", path, &body)?;
        let url = format!("{}{}", BASE_URL, path);

        let mut builder = self.client.delete(&url).body(body).header("Content-Type", "application/json");
        for (k, v) in headers {
            builder = builder.header(&k, &v);
        }

        let status = builder.send().await.wrap_err("cancel_order failed")?.status();
        Ok(status.is_success())
    }

    pub async fn cancel_all(&self) -> Result<bool> {
        let path = "/cancel-all";
        let body = "";
        let headers = self.auth_headers("DELETE", path, body)?;
        let url = format!("{}{}", BASE_URL, path);

        let mut builder = self.client.delete(&url).header("Content-Type", "application/json");
        for (k, v) in headers {
            builder = builder.header(&k, &v);
        }

        let status = builder.send().await.wrap_err("cancel_all failed")?.status();
        Ok(status.is_success())
    }

    pub async fn get_open_orders(&self) -> Result<Vec<OpenOrder>> {
        let path = "/orders";
        let headers = self.auth_headers("GET", path, "")?;
        let url = format!("{}{}", BASE_URL, path);

        let mut builder = self.client.get(&url);
        for (k, v) in headers {
            builder = builder.header(&k, &v);
        }

        let orders: Vec<OpenOrder> = builder
            .send()
            .await
            .wrap_err("get_open_orders failed")?
            .json()
            .await
            .wrap_err("get_open_orders parse failed")?;

        Ok(orders)
    }
}
