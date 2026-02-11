use eyre::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, warn};

use crate::config::RiskConfig;
use crate::domain::Signal;

#[derive(Clone)]
pub struct RiskManager {
    config: RiskConfig,
    peak_bankroll: Arc<RwLock<f64>>,
    pub trading_active: Arc<AtomicBool>,
}

impl RiskManager {
    pub fn new(config: RiskConfig) -> Self {
        let starting = config.starting_bankroll;
        Self {
            config,
            peak_bankroll: Arc::new(RwLock::new(starting)),
            trading_active: Arc::new(AtomicBool::new(true)),
        }
    }

    /// Update bankroll and check drawdown. Returns false if trading should halt.
    pub async fn update_bankroll(&self, current_bankroll: f64) -> bool {
        let mut peak = self.peak_bankroll.write().await;
        if current_bankroll > *peak {
            *peak = current_bankroll;
        }

        // Kill switch: absolute minimum
        if current_bankroll < self.config.min_bankroll {
            error!(
                "KILL SWITCH: Bankroll ${:.2} below minimum ${:.2}. HALTING ALL TRADING.",
                current_bankroll, self.config.min_bankroll
            );
            self.trading_active.store(false, Ordering::SeqCst);
            return false;
        }

        // Drawdown check
        let drawdown = (*peak - current_bankroll) / *peak;
        if drawdown > self.config.max_drawdown_pct {
            error!(
                "DRAWDOWN HALT: {:.1}% drawdown exceeds {:.1}% limit. Peak: ${:.2}, Current: ${:.2}",
                drawdown * 100.0,
                self.config.max_drawdown_pct * 100.0,
                *peak,
                current_bankroll
            );
            self.trading_active.store(false, Ordering::SeqCst);
            return false;
        }

        true
    }

    /// Check if a signal passes risk checks
    pub async fn check_signal(&self, signal: &Signal, current_bankroll: f64, total_exposure: f64) -> Result<bool> {
        if !self.trading_active.load(Ordering::SeqCst) {
            warn!("Trading halted — rejecting signal for {}", signal.market_id);
            return Ok(false);
        }

        // Bankroll minimum
        if current_bankroll < self.config.min_bankroll {
            warn!("Bankroll ${:.2} below minimum — rejecting", current_bankroll);
            return Ok(false);
        }

        // Position size check
        let max_position = current_bankroll * self.config.max_position_pct;
        if signal.size * signal.price > max_position {
            warn!(
                "Signal size ${:.2} exceeds max position ${:.2} — rejecting",
                signal.size * signal.price,
                max_position
            );
            return Ok(false);
        }

        // Total exposure check
        let new_exposure = total_exposure + (signal.size * signal.price);
        if new_exposure > self.config.max_exposure {
            warn!(
                "Total exposure ${:.2} would exceed max ${:.2} — rejecting",
                new_exposure, self.config.max_exposure
            );
            return Ok(false);
        }

        Ok(true)
    }

    pub fn is_active(&self) -> bool {
        self.trading_active.load(Ordering::SeqCst)
    }

    pub fn kill(&self) {
        error!("MANUAL KILL SWITCH ACTIVATED");
        self.trading_active.store(false, Ordering::SeqCst);
    }

    pub fn resume(&self) {
        warn!("Trading resumed manually");
        self.trading_active.store(true, Ordering::SeqCst);
    }
}
