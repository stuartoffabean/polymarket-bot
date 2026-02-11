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
use tokio::sync::{broadcast, RwLock};
use tracing::info;

use crate::adapters::binance::BinanceWsFeed;
use crate::adapters::database::Database;
use crate::adapters::polymarket::PolymarketClient;
use crate::adapters::polymarket_ws::PolymarketWsFeed;
use crate::config::Config;
use crate::domain::{MarketData, Signal};
use crate::engine::order_manager::OrderManager;
use crate::engine::risk::RiskManager;
use crate::feeds::FeedAggregator;
use crate::strategy::latency_arb::LatencyArbStrategy;
use crate::strategy::intra_arb::IntraArbStrategy;

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "polymarket_bot=info,tower_http=info".into()),
        )
        .init();

    info!("🎰 Polymarket Bot starting up...");

    let config = Config::load()?;
    info!("Config loaded. Starting bankroll: ${:.2}", config.risk.starting_bankroll);

    // Database
    let db = Database::new(&config.db_path).await?;
    info!("Database initialized at {}", config.db_path);

    // Shared state
    let bankroll = Arc::new(RwLock::new(config.risk.starting_bankroll));
    let risk = RiskManager::new(config.risk.clone());
    let config = Arc::new(config);

    // Polymarket REST client
    let poly_client = PolymarketClient::new(config.clone())?;

    // Broadcast channels
    let (market_tx, market_rx) = broadcast::channel::<MarketData>(1024);
    let (signal_tx, signal_rx) = broadcast::channel::<Signal>(256);

    // --- Market data feeds ---
    // TODO: Configure actual market IDs from environment/config
    let poly_ws = PolymarketWsFeed::new(market_tx.clone(), vec![]);
    let binance_ws = BinanceWsFeed::new(market_tx.clone(), vec!["btcusdt".into()]);

    // --- Strategies ---
    let strategies: Vec<Box<dyn strategy::Strategy>> = vec![
        Box::new(LatencyArbStrategy::new(
            "placeholder_market".into(),
            "placeholder_yes_token".into(),
            "placeholder_no_token".into(),
            "BTCUSDT".into(),
            100_000.0, // placeholder threshold
        )),
        Box::new(IntraArbStrategy::new(vec![])),
    ];

    // --- Feed aggregator (drives strategies) ---
    let aggregator = FeedAggregator::new(market_rx, signal_tx.clone(), strategies, bankroll.clone());

    // --- Order manager ---
    let order_manager = OrderManager::new(
        poly_client.clone(),
        db.clone(),
        risk.clone(),
        bankroll.clone(),
        signal_rx,
    );

    // --- Dashboard API ---
    let app_state = Arc::new(api::AppState {
        db: db.clone(),
        risk: risk.clone(),
        poly_client: poly_client.clone(),
        bankroll: bankroll.clone(),
        start_time: Instant::now(),
    });
    let app = api::router(app_state);
    let port = config.dashboard_port;
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    info!("Dashboard API running on http://0.0.0.0:{}", port);

    // --- Spawn everything ---
    tokio::spawn(async move { poly_ws.run().await });
    tokio::spawn(async move { binance_ws.run().await });
    tokio::spawn(async move { aggregator.run().await });
    tokio::spawn(async move { order_manager.run().await });

    // PnL snapshot task
    let snapshot_db = db.clone();
    let snapshot_bankroll = bankroll.clone();
    let snapshot_risk = risk.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
        loop {
            interval.tick().await;
            let br = *snapshot_bankroll.read().await;
            snapshot_risk.update_bankroll(br).await;
            let _ = snapshot_db.record_pnl_snapshot(br, br - 500.0).await;
        }
    });

    // Serve API + graceful shutdown
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("🛑 Bot shutting down gracefully");
    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to install CTRL+C signal handler");
    info!("Shutdown signal received");
}
