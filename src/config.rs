use eyre::{Result, WrapErr};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub private_key: String,
    pub polymarket_api_key: String,
    pub polymarket_secret: String,
    pub polymarket_passphrase: String,
    pub risk: RiskConfig,
    pub db_path: String,
    pub dashboard_port: u16,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RiskConfig {
    pub max_position_pct: f64,
    pub max_drawdown_pct: f64,
    pub min_bankroll: f64,
    pub starting_bankroll: f64,
    pub max_exposure: f64,
}

impl Default for RiskConfig {
    fn default() -> Self {
        Self {
            max_position_pct: 0.05,
            max_drawdown_pct: 0.30,
            min_bankroll: 350.0,
            starting_bankroll: 500.0,
            max_exposure: 100.0,
        }
    }
}

impl Config {
    pub fn load() -> Result<Self> {
        dotenvy::dotenv().ok();

        let private_key =
            std::env::var("PRIVATE_KEY").wrap_err("PRIVATE_KEY not set")?;
        let polymarket_api_key =
            std::env::var("POLYMARKET_API_KEY").wrap_err("POLYMARKET_API_KEY not set")?;
        let polymarket_secret =
            std::env::var("POLYMARKET_SECRET").wrap_err("POLYMARKET_SECRET not set")?;
        let polymarket_passphrase =
            std::env::var("POLYMARKET_PASSPHRASE").wrap_err("POLYMARKET_PASSPHRASE not set")?;
        let db_path =
            std::env::var("DB_PATH").unwrap_or_else(|_| "bot.db".to_string());
        let dashboard_port: u16 = std::env::var("DASHBOARD_PORT")
            .unwrap_or_else(|_| "3001".to_string())
            .parse()
            .unwrap_or(3001);

        let risk = RiskConfig {
            max_position_pct: env_f64("MAX_POSITION_PCT", 0.05),
            max_drawdown_pct: env_f64("MAX_DRAWDOWN_PCT", 0.30),
            min_bankroll: env_f64("MIN_BANKROLL", 350.0),
            starting_bankroll: env_f64("STARTING_BANKROLL", 500.0),
            max_exposure: env_f64("MAX_EXPOSURE", 100.0),
        };

        Ok(Config {
            private_key,
            polymarket_api_key,
            polymarket_secret,
            polymarket_passphrase,
            risk,
            db_path,
            dashboard_port,
        })
    }
}

fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
