/**
 * market-utils.js — Market Analysis Utilities (CommonJS)
 * 
 * Shared helpers for market analysis. Kelly sizing lives in weather-scanner.js
 * (the canonical implementation). This module provides order book, liquidity,
 * and time horizon utilities.
 */

function calculateSpread(bids, asks) {
  if (!bids?.length || !asks?.length) return null;
  return parseFloat(asks[0].price) - parseFloat(bids[0].price);
}

function midPrice(bids, asks) {
  if (!bids?.length || !asks?.length) return null;
  return (parseFloat(bids[0].price) + parseFloat(asks[0].price)) / 2;
}

function calculateLiquidity(bids, asks, levels = 3) {
  const mid = midPrice(bids, asks) || 0.5;
  const bidLiq = (bids || []).slice(0, levels).reduce((s, o) => s + parseFloat(o.size), 0);
  const askLiq = (asks || []).slice(0, levels).reduce((s, o) => s + parseFloat(o.size), 0);
  return (bidLiq + askLiq) * mid;
}

/**
 * Calculate ask-side depth at or near a target price.
 * Returns total shares available within `tolerance` of targetPrice.
 */
function askDepthAtPrice(asks, targetPrice, tolerance = 0.02) {
  if (!asks?.length) return 0;
  return asks
    .filter(a => Math.abs(parseFloat(a.price) - targetPrice) <= tolerance)
    .reduce((s, a) => s + parseFloat(a.size), 0);
}

function expectedValue(betSize, price, winProbability) {
  const winAmount = betSize * (1 - price) / price;
  return (winAmount * winProbability) - (betSize * (1 - winProbability));
}

function breakevenPrice(entryPrice, feeRate = 0.02) {
  return entryPrice * (1 + feeRate) / (1 - feeRate);
}

function hoursUntilResolution(endDate) {
  return (new Date(endDate) - new Date()) / (1000 * 60 * 60);
}

function timeHorizonCategory(endDate) {
  const hours = hoursUntilResolution(endDate);
  if (hours < 4) return 'express';
  if (hours < 48) return 'short';
  if (hours < 168) return 'medium';
  return 'long';
}

function capitalVelocityScore(expectedReturn, hoursToResolution) {
  return (expectedReturn / hoursToResolution) * (24 * 365);
}

module.exports = {
  calculateSpread,
  midPrice,
  calculateLiquidity,
  askDepthAtPrice,
  expectedValue,
  breakevenPrice,
  hoursUntilResolution,
  timeHorizonCategory,
  capitalVelocityScore,
};
