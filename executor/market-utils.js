/**
 * market-utils.js — Market Analysis Utilities
 * 
 * Helper functions for market analysis (inspired by dr-manhattan's MarketUtils)
 * Built on our existing CLOB client infrastructure.
 */

/**
 * Calculate bid-ask spread
 * @param {Array} bids - Order book bids
 * @param {Array} asks - Order book asks
 * @returns {number|null} Spread as decimal (e.g., 0.02 = 2¢)
 */
export function calculateSpread(bids, asks) {
  if (!bids?.length || !asks?.length) return null;
  
  const bestBid = parseFloat(bids[0].price);
  const bestAsk = parseFloat(asks[0].price);
  
  return bestAsk - bestBid;
}

/**
 * Calculate mid price
 * @param {Array} bids
 * @param {Array} asks
 * @returns {number|null}
 */
export function midPrice(bids, asks) {
  if (!bids?.length || !asks?.length) return null;
  
  const bestBid = parseFloat(bids[0].price);
  const bestAsk = parseFloat(asks[0].price);
  
  return (bestBid + bestAsk) / 2;
}

/**
 * Calculate total liquidity in top N levels
 * @param {Array} bids
 * @param {Array} asks
 * @param {number} levels - Number of price levels to sum (default: 3)
 * @param {number} midPriceValue - Mid price for USD conversion
 * @returns {number} Total liquidity in USD
 */
export function calculateLiquidity(bids, asks, levels = 3, midPriceValue = null) {
  const mid = midPriceValue || midPrice(bids, asks) || 0.5;
  
  const bidLiquidity = (bids || []).slice(0, levels)
    .reduce((sum, order) => sum + parseFloat(order.size), 0);
  
  const askLiquidity = (asks || []).slice(0, levels)
    .reduce((sum, order) => sum + parseFloat(order.size), 0);
  
  return (bidLiquidity + askLiquidity) * mid;
}

/**
 * Check if market is binary (2 outcomes summing to 1)
 * @param {Array} outcomes - Array of {outcome, price}
 * @returns {boolean}
 */
export function isBinary(outcomes) {
  if (!outcomes || outcomes.length !== 2) return false;
  
  const sum = outcomes.reduce((s, o) => s + (o.price || 0), 0);
  return Math.abs(sum - 1.0) < 0.05; // Allow 5¢ deviation for spreads
}

/**
 * Calculate implied probability from price
 * @param {number} price - Market price (0-1)
 * @returns {number} Percentage (0-100)
 */
export function impliedProbability(price) {
  return price * 100;
}

/**
 * Calculate Kelly criterion bet size
 * @param {number} edgePercent - Your edge in decimal (e.g., 0.05 = 5%)
 * @param {number} price - Current market price
 * @param {number} bankroll - Total bankroll
 * @returns {number} Recommended bet size in dollars
 */
export function kellyCriterion(edgePercent, price, bankroll) {
  // Kelly formula: f = (bp - q) / b
  // where b = odds, p = win probability, q = lose probability
  
  const winProb = price + edgePercent;
  const loseProb = 1 - winProb;
  const odds = (1 / price) - 1;
  
  const kellyFraction = (odds * winProb - loseProb) / odds;
  
  // Use 1/4 Kelly for safety
  const fractionalKelly = kellyFraction * 0.25;
  
  return Math.max(0, fractionalKelly * bankroll);
}

/**
 * Calculate expected value of a bet
 * @param {number} betSize - Bet size in dollars
 * @param {number} price - Entry price
 * @param {number} winProbability - True win probability (0-1)
 * @returns {number} Expected value in dollars
 */
export function expectedValue(betSize, price, winProbability) {
  const winAmount = betSize * (1 - price) / price;
  const loseAmount = betSize;
  
  return (winAmount * winProbability) - (loseAmount * (1 - winProbability));
}

/**
 * Calculate breakeven price given entry price and fees
 * @param {number} entryPrice - Entry price
 * @param {number} feeRate - Total fee rate (e.g., 0.02 = 2%)
 * @returns {number} Breakeven exit price
 */
export function breakevenPrice(entryPrice, feeRate = 0.02) {
  // Account for fees on both entry and exit
  return entryPrice * (1 + feeRate) / (1 - feeRate);
}

/**
 * Time until resolution in hours
 * @param {string} endDate - ISO date string
 * @returns {number} Hours until resolution
 */
export function hoursUntilResolution(endDate) {
  const now = new Date();
  const end = new Date(endDate);
  return (end - now) / (1000 * 60 * 60);
}

/**
 * Categorize market by time horizon
 * @param {string} endDate
 * @returns {string} 'express' | 'short' | 'medium' | 'long'
 */
export function timeHorizonCategory(endDate) {
  const hours = hoursUntilResolution(endDate);
  
  if (hours < 4) return 'express'; // <4h (including 15-min markets)
  if (hours < 48) return 'short'; // <2 days
  if (hours < 168) return 'medium'; // <1 week
  return 'long'; // >1 week
}

/**
 * Calculate capital velocity score (higher is better for small bankrolls)
 * @param {number} expectedReturn - Expected return in decimal (e.g., 0.15 = 15%)
 * @param {number} hoursToResolution
 * @returns {number} Annualized return rate
 */
export function capitalVelocityScore(expectedReturn, hoursToResolution) {
  const hoursPerYear = 24 * 365;
  return (expectedReturn / hoursToResolution) * hoursPerYear;
}

export default {
  calculateSpread,
  midPrice,
  calculateLiquidity,
  isBinary,
  impliedProbability,
  kellyCriterion,
  expectedValue,
  breakevenPrice,
  hoursUntilResolution,
  timeHorizonCategory,
  capitalVelocityScore
};
