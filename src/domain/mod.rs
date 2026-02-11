use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

impl std::fmt::Display for Side {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Side::Buy => write!(f, "BUY"),
            Side::Sell => write!(f, "SELL"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum OrderType {
    GTC,
    GTD,
    FOK,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum OrderStatus {
    Pending,
    Open,
    Filled,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Market {
    pub id: String,
    pub question: String,
    pub tokens: Vec<TokenInfo>,
    pub end_date: Option<DateTime<Utc>>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenInfo {
    pub token_id: String,
    pub outcome: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: String,
    pub market_id: String,
    pub side: Side,
    pub token_id: String,
    pub price: f64,
    pub size: f64,
    pub order_type: OrderType,
    pub status: OrderStatus,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub market_id: String,
    pub token_id: String,
    pub side: Side,
    pub size: f64,
    pub avg_price: f64,
    pub current_price: f64,
    pub pnl: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub id: String,
    pub order_id: String,
    pub market_id: String,
    pub side: Side,
    pub price: f64,
    pub size: f64,
    pub fee: f64,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signal {
    pub strategy: String,
    pub market_id: String,
    pub side: Side,
    pub confidence: f64,
    pub price: f64,
    pub size: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookLevel {
    pub price: f64,
    pub size: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBook {
    pub bids: Vec<BookLevel>,
    pub asks: Vec<BookLevel>,
    pub timestamp: DateTime<Utc>,
}

impl OrderBook {
    pub fn midpoint(&self) -> Option<f64> {
        let best_bid = self.bids.first().map(|l| l.price)?;
        let best_ask = self.asks.first().map(|l| l.price)?;
        Some((best_bid + best_ask) / 2.0)
    }

    pub fn spread(&self) -> Option<f64> {
        let best_bid = self.bids.first().map(|l| l.price)?;
        let best_ask = self.asks.first().map(|l| l.price)?;
        Some(best_ask - best_bid)
    }
}

/// Normalized market data event from any feed
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MarketData {
    PolymarketPrice {
        market_id: String,
        token_id: String,
        price: f64,
        timestamp: DateTime<Utc>,
    },
    PolymarketOrderBook {
        market_id: String,
        token_id: String,
        book: OrderBook,
    },
    BinanceTicker {
        symbol: String,
        price: f64,
        timestamp: DateTime<Utc>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PnlSnapshot {
    pub timestamp: DateTime<Utc>,
    pub bankroll: f64,
    pub pnl_total: f64,
}
