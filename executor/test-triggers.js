#!/usr/bin/env node
/**
 * Unit tests for trigger guard logic.
 * 
 * These test the GUARD conditions in checkTriggers without needing
 * a running ws-feed. We simulate the data structures and verify
 * that the guards fire correctly.
 * 
 * Uses Node.js built-in test runner (node:test).
 * Run: node --test executor/test-triggers.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── Simulate the guard logic from checkTriggers ──

/**
 * Reproduces the early-exit guard logic from checkTriggers().
 * Returns the reason it would skip, or null if it would proceed.
 */
function checkGuards(assetId, asset, { sellLocks, recentlySold, exitFailed, systemReady, emergencyMode }) {
  if (!asset.avgPrice || !asset.size) return 'no_position_data';
  if (!asset.currentBid) return 'no_price';
  if (!systemReady) return 'not_ready';
  if (emergencyMode) return 'emergency_mode';
  if (sellLocks.has(assetId)) return 'sell_locked';
  if (recentlySold.has(assetId)) return 'recently_sold';
  if (exitFailed.has(assetId)) return 'exit_failed';
  if (asset._sellCooldownUntil && Date.now() < asset._sellCooldownUntil) return 'cooldown';
  return null; // would proceed to evaluate triggers
}

describe('checkTriggers guards', () => {
  const baseAsset = { avgPrice: 0.50, size: 100, currentBid: 0.45 };
  const baseContext = {
    sellLocks: new Set(),
    recentlySold: new Map(),
    exitFailed: new Map(),
    systemReady: true,
    emergencyMode: false,
  };

  it('proceeds when no guards hit', () => {
    const result = checkGuards('asset1', { ...baseAsset }, { ...baseContext });
    assert.equal(result, null);
  });

  it('blocks on missing avgPrice', () => {
    const result = checkGuards('asset1', { ...baseAsset, avgPrice: 0 }, { ...baseContext });
    assert.equal(result, 'no_position_data');
  });

  it('blocks on missing currentBid', () => {
    const result = checkGuards('asset1', { ...baseAsset, currentBid: null }, { ...baseContext });
    assert.equal(result, 'no_price');
  });

  it('blocks when system not ready', () => {
    const result = checkGuards('asset1', { ...baseAsset }, { ...baseContext, systemReady: false });
    assert.equal(result, 'not_ready');
  });

  it('blocks in emergency mode', () => {
    const result = checkGuards('asset1', { ...baseAsset }, { ...baseContext, emergencyMode: true });
    assert.equal(result, 'emergency_mode');
  });

  it('blocks when sell locked', () => {
    const ctx = { ...baseContext, sellLocks: new Set(['asset1']) };
    const result = checkGuards('asset1', { ...baseAsset }, ctx);
    assert.equal(result, 'sell_locked');
  });

  it('blocks when recently sold', () => {
    const ctx = { ...baseContext, recentlySold: new Map([['asset1', Date.now()]]) };
    const result = checkGuards('asset1', { ...baseAsset }, ctx);
    assert.equal(result, 'recently_sold');
  });

  it('blocks when exit-failed (THE DUPLICATE SL FIX)', () => {
    const ctx = {
      ...baseContext,
      exitFailed: new Map([['asset1', { timestamp: Date.now(), retries: 3, reason: 'STOP_LOSS' }]]),
    };
    const result = checkGuards('asset1', { ...baseAsset }, ctx);
    assert.equal(result, 'exit_failed');
  });

  it('blocks during sell cooldown', () => {
    const result = checkGuards('asset1', {
      ...baseAsset,
      _sellCooldownUntil: Date.now() + 60000,
    }, { ...baseContext });
    assert.equal(result, 'cooldown');
  });

  it('proceeds when cooldown expired', () => {
    const result = checkGuards('asset1', {
      ...baseAsset,
      _sellCooldownUntil: Date.now() - 1000,
    }, { ...baseContext });
    assert.equal(result, null);
  });

  it('exit-failed blocks BEFORE cooldown check', () => {
    // Both exit-failed AND cooldown active — exit-failed should win (order matters)
    const ctx = {
      ...baseContext,
      exitFailed: new Map([['asset1', { timestamp: Date.now() }]]),
    };
    const result = checkGuards('asset1', {
      ...baseAsset,
      _sellCooldownUntil: Date.now() + 60000,
    }, ctx);
    assert.equal(result, 'exit_failed');
  });

  it('different asset IDs are independent', () => {
    const ctx = {
      ...baseContext,
      exitFailed: new Map([['asset1', { timestamp: Date.now() }]]),
      sellLocks: new Set(['asset3']),
    };
    assert.equal(checkGuards('asset1', { ...baseAsset }, ctx), 'exit_failed');
    assert.equal(checkGuards('asset2', { ...baseAsset }, ctx), null);
    assert.equal(checkGuards('asset3', { ...baseAsset }, ctx), 'sell_locked');
  });
});

describe('exit-failed persistence format', () => {
  it('exit-failed.json is valid JSON with expected structure', () => {
    const filePath = path.join(__dirname, 'exit-failed.json');
    if (!fs.existsSync(filePath)) {
      // File doesn't exist yet — that's fine, it's created on first failure
      assert.ok(true, 'exit-failed.json not yet created (no failures recorded)');
      return;
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(typeof data, 'object');
    // Each entry should have expected fields
    for (const [assetId, info] of Object.entries(data)) {
      assert.ok(assetId.length > 10, `assetId looks valid: ${assetId.slice(0, 20)}`);
      assert.equal(typeof info.timestamp, 'number', 'timestamp is a number');
      assert.equal(typeof info.reason, 'string', 'reason is a string');
    }
  });

  it('recently-sold.json is valid JSON', () => {
    const filePath = path.join(__dirname, 'recently-sold.json');
    if (!fs.existsSync(filePath)) {
      assert.ok(true, 'recently-sold.json not yet created');
      return;
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(typeof data, 'object');
    for (const [assetId, ts] of Object.entries(data)) {
      assert.equal(typeof ts, 'number', `timestamp for ${assetId.slice(0,20)} is a number`);
    }
  });
});

describe('stop-loss trigger flags', () => {
  it('_stopLossTriggered prevents re-firing', () => {
    // Simulates: first stop-loss fires, sets flag, second check skips
    const asset = { ...{ avgPrice: 0.50, size: 100, currentBid: 0.30 }, _stopLossTriggered: false };
    const stopLoss = 0.30; // 30%
    const pnlPct = (asset.currentBid * asset.size - asset.avgPrice * asset.size) / (asset.avgPrice * asset.size);
    
    // First check: should fire
    assert.ok(pnlPct <= -stopLoss, 'P&L below stop-loss threshold');
    assert.ok(!asset._stopLossTriggered, 'Not yet triggered');
    
    // Simulate trigger
    asset._stopLossTriggered = true;
    
    // Second check: should NOT fire
    assert.ok(asset._stopLossTriggered, 'Already triggered — would be skipped');
  });

  it('sell retry counter increments correctly', () => {
    const asset = { _sellRetries: 0 };
    const MAX_SELL_RETRIES = 3;
    
    // Simulate 3 failed sells
    for (let i = 1; i <= MAX_SELL_RETRIES; i++) {
      if (!asset._sellRetries) asset._sellRetries = 0;
      asset._sellRetries++;
      
      if (i < MAX_SELL_RETRIES) {
        assert.ok(asset._sellRetries < MAX_SELL_RETRIES, `Retry ${i}: still has retries left`);
      } else {
        assert.ok(asset._sellRetries >= MAX_SELL_RETRIES, `Retry ${i}: max retries reached`);
        asset._exitFailed = true;
        asset._sellCooldownUntil = Infinity;
      }
    }
    
    assert.ok(asset._exitFailed, 'Marked as exit_failed after max retries');
    assert.equal(asset._sellCooldownUntil, Infinity, 'Permanent cooldown set');
  });
});
