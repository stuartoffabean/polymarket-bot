use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::Serialize;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

use crate::adapters::database::Database;
use crate::adapters::polymarket::PolymarketClient;
use crate::engine::risk::RiskManager;

pub struct AppState {
    pub db: Database,
    pub risk: RiskManager,
    pub poly_client: PolymarketClient,
    pub bankroll: Arc<RwLock<f64>>,
    pub start_time: Instant,
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/status", get(status))
        .route("/api/positions", get(positions))
        .route("/api/trades", get(trades))
        .route("/api/pnl", get(pnl))
        .route("/api/orders", get(orders))
        .route("/api/strategies", get(strategies))
        .route("/api/kill", post(kill))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

#[derive(Serialize)]
struct StatusResponse {
    bankroll: f64,
    pnl_total: f64,
    active_positions: usize,
    uptime_secs: u64,
    trading_active: bool,
}

async fn status(State(state): State<Arc<AppState>>) -> Json<StatusResponse> {
    let bankroll = *state.bankroll.read().await;
    let positions = state.db.get_positions().await.unwrap_or_default();
    let pnl_total = bankroll - 500.0; // starting bankroll
    let uptime = state.start_time.elapsed().as_secs();

    Json(StatusResponse {
        bankroll,
        pnl_total,
        active_positions: positions.len(),
        uptime_secs: uptime,
        trading_active: state.risk.is_active(),
    })
}

async fn positions(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, StatusCode> {
    let positions = state.db.get_positions().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::to_value(positions).unwrap()))
}

async fn trades(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, StatusCode> {
    let trades = state.db.get_recent_trades(100).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::to_value(trades).unwrap()))
}

async fn pnl(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, StatusCode> {
    let history = state.db.get_pnl_history().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::to_value(history).unwrap()))
}

async fn orders(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, StatusCode> {
    let orders = state.db.get_open_orders().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::to_value(orders).unwrap()))
}

#[derive(Serialize)]
struct StrategiesResponse {
    strategies: Vec<StrategyInfo>,
}

#[derive(Serialize)]
struct StrategyInfo {
    name: String,
    enabled: bool,
}

async fn strategies(State(_state): State<Arc<AppState>>) -> Json<StrategiesResponse> {
    Json(StrategiesResponse {
        strategies: vec![
            StrategyInfo { name: "latency_arb".into(), enabled: true },
            StrategyInfo { name: "intra_arb".into(), enabled: true },
        ],
    })
}

async fn kill(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    state.risk.kill();
    let _ = state.poly_client.cancel_all().await;
    Json(serde_json::json!({ "status": "killed", "trading_active": false }))
}
