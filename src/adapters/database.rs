use chrono::Utc;
use eyre::Result;
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};

use crate::domain::{Order, OrderStatus, PnlSnapshot, Position, Side, Trade};

#[derive(Clone)]
pub struct Database {
    pub pool: SqlitePool,
}

impl Database {
    pub async fn new(db_path: &str) -> Result<Self> {
        let url = format!("sqlite:{}?mode=rwc", db_path);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await?;

        let db = Self { pool };
        db.run_migrations().await?;
        Ok(db)
    }

    async fn run_migrations(&self) -> Result<()> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS trades (
                id TEXT PRIMARY KEY,
                order_id TEXT NOT NULL,
                market_id TEXT NOT NULL,
                side TEXT NOT NULL,
                price REAL NOT NULL,
                size REAL NOT NULL,
                fee REAL NOT NULL DEFAULT 0.0,
                timestamp TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS positions (
                market_id TEXT NOT NULL,
                token_id TEXT NOT NULL,
                side TEXT NOT NULL,
                size REAL NOT NULL,
                avg_price REAL NOT NULL,
                current_price REAL NOT NULL DEFAULT 0.0,
                pnl REAL NOT NULL DEFAULT 0.0,
                PRIMARY KEY (market_id, token_id)
            );

            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                market_id TEXT NOT NULL,
                side TEXT NOT NULL,
                token_id TEXT NOT NULL,
                price REAL NOT NULL,
                size REAL NOT NULL,
                order_type TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pnl_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                bankroll REAL NOT NULL,
                pnl_total REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    // --- Trades ---

    pub async fn insert_trade(&self, trade: &Trade) -> Result<()> {
        let side = trade.side.to_string();
        let ts = trade.timestamp.to_rfc3339();
        sqlx::query(
            "INSERT INTO trades (id, order_id, market_id, side, price, size, fee, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&trade.id)
        .bind(&trade.order_id)
        .bind(&trade.market_id)
        .bind(&side)
        .bind(trade.price)
        .bind(trade.size)
        .bind(trade.fee)
        .bind(&ts)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_recent_trades(&self, limit: i64) -> Result<Vec<Trade>> {
        let rows = sqlx::query_as::<_, TradeRow>(
            "SELECT id, order_id, market_id, side, price, size, fee, timestamp FROM trades ORDER BY timestamp DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(|r| r.into()).collect())
    }

    // --- Positions ---

    pub async fn upsert_position(&self, pos: &Position) -> Result<()> {
        let side = pos.side.to_string();
        sqlx::query(
            "INSERT INTO positions (market_id, token_id, side, size, avg_price, current_price, pnl)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(market_id, token_id) DO UPDATE SET
                side = excluded.side,
                size = excluded.size,
                avg_price = excluded.avg_price,
                current_price = excluded.current_price,
                pnl = excluded.pnl",
        )
        .bind(&pos.market_id)
        .bind(&pos.token_id)
        .bind(&side)
        .bind(pos.size)
        .bind(pos.avg_price)
        .bind(pos.current_price)
        .bind(pos.pnl)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_positions(&self) -> Result<Vec<Position>> {
        let rows = sqlx::query_as::<_, PositionRow>(
            "SELECT market_id, token_id, side, size, avg_price, current_price, pnl FROM positions WHERE size > 0",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into()).collect())
    }

    pub async fn delete_position(&self, market_id: &str, token_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM positions WHERE market_id = ? AND token_id = ?")
            .bind(market_id)
            .bind(token_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // --- Orders ---

    pub async fn insert_order(&self, order: &Order) -> Result<()> {
        let side = order.side.to_string();
        let status = format!("{:?}", order.status);
        let ot = format!("{:?}", order.order_type);
        let ts = order.created_at.to_rfc3339();
        sqlx::query(
            "INSERT INTO orders (id, market_id, side, token_id, price, size, order_type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&order.id)
        .bind(&order.market_id)
        .bind(&side)
        .bind(&order.token_id)
        .bind(order.price)
        .bind(order.size)
        .bind(&ot)
        .bind(&status)
        .bind(&ts)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_order_status(&self, order_id: &str, status: &OrderStatus) -> Result<()> {
        let s = format!("{:?}", status);
        sqlx::query("UPDATE orders SET status = ? WHERE id = ?")
            .bind(&s)
            .bind(order_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get_open_orders(&self) -> Result<Vec<Order>> {
        let rows = sqlx::query_as::<_, OrderRow>(
            "SELECT id, market_id, side, token_id, price, size, order_type, status, created_at FROM orders WHERE status IN ('Pending', 'Open')",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into()).collect())
    }

    // --- PnL ---

    pub async fn record_pnl_snapshot(&self, bankroll: f64, pnl_total: f64) -> Result<()> {
        let ts = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO pnl_snapshots (timestamp, bankroll, pnl_total) VALUES (?, ?, ?)")
            .bind(&ts)
            .bind(bankroll)
            .bind(pnl_total)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get_pnl_history(&self) -> Result<Vec<PnlSnapshot>> {
        let rows = sqlx::query_as::<_, PnlRow>(
            "SELECT timestamp, bankroll, pnl_total FROM pnl_snapshots ORDER BY timestamp ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                Some(PnlSnapshot {
                    timestamp: chrono::DateTime::parse_from_rfc3339(&r.timestamp)
                        .ok()?
                        .with_timezone(&Utc),
                    bankroll: r.bankroll,
                    pnl_total: r.pnl_total,
                })
            })
            .collect())
    }

    // --- Config KV ---

    pub async fn set_config(&self, key: &str, value: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_config(&self, key: &str) -> Result<Option<String>> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT value FROM config WHERE key = ?")
                .bind(key)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.0))
    }
}

// --- Row types for sqlx ---

#[derive(sqlx::FromRow)]
struct TradeRow {
    id: String,
    order_id: String,
    market_id: String,
    side: String,
    price: f64,
    size: f64,
    fee: f64,
    timestamp: String,
}

impl From<TradeRow> for Trade {
    fn from(r: TradeRow) -> Self {
        Trade {
            id: r.id,
            order_id: r.order_id,
            market_id: r.market_id,
            side: if r.side == "BUY" { Side::Buy } else { Side::Sell },
            price: r.price,
            size: r.size,
            fee: r.fee,
            timestamp: chrono::DateTime::parse_from_rfc3339(&r.timestamp)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
        }
    }
}

#[derive(sqlx::FromRow)]
struct PositionRow {
    market_id: String,
    token_id: String,
    side: String,
    size: f64,
    avg_price: f64,
    current_price: f64,
    pnl: f64,
}

impl From<PositionRow> for Position {
    fn from(r: PositionRow) -> Self {
        Position {
            market_id: r.market_id,
            token_id: r.token_id,
            side: if r.side == "BUY" { Side::Buy } else { Side::Sell },
            size: r.size,
            avg_price: r.avg_price,
            current_price: r.current_price,
            pnl: r.pnl,
        }
    }
}

#[derive(sqlx::FromRow)]
struct OrderRow {
    id: String,
    market_id: String,
    side: String,
    token_id: String,
    price: f64,
    size: f64,
    order_type: String,
    status: String,
    created_at: String,
}

impl From<OrderRow> for Order {
    fn from(r: OrderRow) -> Self {
        use crate::domain::{OrderType, OrderStatus};
        Order {
            id: r.id,
            market_id: r.market_id,
            side: if r.side == "BUY" { Side::Buy } else { Side::Sell },
            token_id: r.token_id,
            price: r.price,
            size: r.size,
            order_type: match r.order_type.as_str() {
                "GTD" => OrderType::GTD,
                "FOK" => OrderType::FOK,
                _ => OrderType::GTC,
            },
            status: match r.status.as_str() {
                "Open" => OrderStatus::Open,
                "Filled" => OrderStatus::Filled,
                "Cancelled" => OrderStatus::Cancelled,
                "Failed" => OrderStatus::Failed,
                _ => OrderStatus::Pending,
            },
            created_at: chrono::DateTime::parse_from_rfc3339(&r.created_at)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
        }
    }
}

#[derive(sqlx::FromRow)]
struct PnlRow {
    timestamp: String,
    bankroll: f64,
    pnl_total: f64,
}
