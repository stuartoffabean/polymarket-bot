mod adapters;
mod api;
mod config;
mod domain;
mod engine;
mod feeds;
mod strategy;

use eyre::Result;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tracing::info;

use crate::adapters::database::Database;
use crate::adapters::polymarket::PolymarketClient;
use crate::config::Config;
use crate::engine::risk::RiskManager;

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("polymarket_bot=info,tower_http=info"))
        .init();

    let config = Config::load()?;
    let db = Database::new(&config.db_path).await?;
    let risk = RiskManager::new(config.risk.clone());
    let config = Arc::new(config);
    let poly_client = PolymarketClient::new(config.clone())?;
    let bankroll = Arc::new(RwLock::new(config.risk.starting_bankroll));

    let app_state = Arc::new(api::AppState {
        db,
        risk,
        poly_client,
        bankroll,
        start_time: Instant::now(),
    });

    let app = api::router(app_state);
    let port = config.dashboard_port;
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    info!("Dashboard server running on http://0.0.0.0:{}", port);

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await?;

    Ok(())
}
