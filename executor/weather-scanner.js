#!/usr/bin/env node
/**
 * Weather Forecast Arbitrage Scanner v2.0
 * 
 * MAJOR UPGRADES from v1.0:
 *   1. 31-member GFS ensemble forecasts (not assumed normal distribution)
 *   2. Temperature laddering signals (neobrother's $20K strategy)
 *   3. Quarter-Kelly position sizing with ensemble confidence
 *   4. Sum-to-100 structural edge detection
 *   5. Expanded market parser (handles more question formats)
 *   6. Forecast update timing awareness (GFS 00/06/12/18 UTC)
 *   7. Ensemble-derived probability distribution
 * 
 * Inspired by suislanchez/polymarket-kalshi-weather-bot architecture
 * but implemented natively in our Node.js bot infrastructure.
 * 
 * Strategy insights from neobrother ($20K+) and Hans323 ($1.1M):
 *   - neobrother: "Grid Trader" — buys YES across 4-6 adjacent temp buckets at 2-15¢
 *   - Hans323: "Black Swan Hunter" — massive bets on low-prob outcomes at 2-8¢
 *   - Key: One winning bucket at 800%+ covers all losing ladders
 * 
 * Data sources (FREE, no API key):
 *   - Open-Meteo Ensemble API (31-member GFS) — worldwide
 *   - NOAA Weather API (api.weather.gov) — US cities, deterministic
 * 
 * Usage: node executor/weather-scanner.js
 * Output: weather-results.json
 */

const { writeFileSync, readFileSync, existsSync } = require('fs');
const { join } = require('path');

const OUTPUT_FILE = join(__dirname, '..', 'weather-results.json');
const GAMMA_API = 'https://gamma-api.polymarket.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'stuart-weather-bot/2.0', ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  // Signal thresholds
  MIN_EDGE: 0.05,              // 5% minimum edge for signal
  MIN_EDGE_LADDER: 0.03,      // 3% minimum for ladder entries (lower because diversified)
  MIN_VOLUME_24H: 200,         // Minimum 24h volume
  MIN_LIQUIDITY: 100,          // Minimum liquidity
  
  // Position sizing (Quarter-Kelly)
  KELLY_FRACTION: 0.25,        // Quarter-Kelly for safety
  MAX_TRADE_SIZE: 10,          // $10 max per single trade (at $500 bankroll)
  MAX_BANKROLL_PCT: 0.05,      // 5% max bankroll per trade
  MAX_LADDER_TOTAL: 25,        // $25 max total across a ladder
  BANKROLL: 500,               // Current bankroll estimate
  
  // Ensemble
  ENSEMBLE_MIN_CONFIDENCE: 0.3, // Minimum confidence score to trade
  
  // Structural
  SUM_DEVIATION_THRESHOLD: 0.05, // Flag if buckets sum deviates >5% from 1.00
};

// ── City Configuration ───────────────────────────────────────────────────────

const CITIES = {
  // US cities — NOAA grid + Open-Meteo, temperature in Fahrenheit
  'new york city': { 
    noaa: 'OKX/33,35', lat: 40.7128, lon: -74.0060, unit: 'F',
    polyAliases: ['nyc', 'new york city', 'new york'],
  },
  'chicago': { 
    noaa: 'LOT/76,73', lat: 41.8781, lon: -87.6298, unit: 'F',
    polyAliases: ['chicago'],
  },
  'atlanta': { 
    noaa: 'FFC/51,87', lat: 33.7490, lon: -84.3880, unit: 'F',
    polyAliases: ['atlanta'],
  },
  'dallas': { 
    noaa: 'FWD/89,104', lat: 32.7767, lon: -96.7970, unit: 'F',
    polyAliases: ['dallas'],
  },
  'seattle': { 
    noaa: 'SEW/125,68', lat: 47.6062, lon: -122.3321, unit: 'F',
    polyAliases: ['seattle'],
  },
  'miami': { 
    noaa: 'MFL/110,50', lat: 25.7617, lon: -80.1918, unit: 'F',
    polyAliases: ['miami'],
  },
  // International — Open-Meteo only, temperature in Celsius
  'seoul': { lat: 37.5665, lon: 126.9780, unit: 'C', polyAliases: ['seoul'] },
  'london': { lat: 51.5074, lon: -0.1278, unit: 'C', polyAliases: ['london'] },
  'buenos aires': { lat: -34.6037, lon: -58.3816, unit: 'C', polyAliases: ['buenos aires'] },
  'wellington': { lat: -41.2866, lon: 174.7756, unit: 'C', polyAliases: ['wellington'] },
  'ankara': { lat: 39.9334, lon: 32.8597, unit: 'C', polyAliases: ['ankara'] },
  'toronto': { lat: 43.6532, lon: -79.3832, unit: 'C', polyAliases: ['toronto'] },
};

// ── City-Calibrated Ensemble Spread ──────────────────────────────────────────
// Typical ensemble std dev for each city in February (°F for US, °C for intl).
// Used to normalize confidence: a 3°F spread in Miami is alarming, but normal in Chicago.
// Values derived from historical GFS ensemble spread for winter months.
const CITY_TYPICAL_SPREAD = {
  'new york city': 5.0,  // F, high variability in winter
  'chicago':       7.0,  // F, highest variability — lake effect + arctic air
  'atlanta':       4.0,  // F, moderate
  'dallas':        5.0,  // F, frontal passages cause big swings
  'seattle':       3.0,  // F, marine influence keeps spread low
  'miami':         2.0,  // F, tropical = very stable
  'seoul':         3.5,  // C, continental but consistent
  'london':        2.5,  // C, maritime = stable
  'buenos aires':  2.5,  // C, summer = stable
  'wellington':    2.0,  // C, maritime
  'ankara':        4.0,  // C, continental = higher spread
  'toronto':       5.0,  // C, high variability like Chicago
};

// ── Ensemble Forecast Fetching ───────────────────────────────────────────────

/**
 * Fetch 31-member GFS ensemble from Open-Meteo
 * This is the single biggest upgrade: real probability distribution, not assumed normal.
 * Each ensemble member is a separate model run with slightly different initial conditions.
 * The spread of the 31 members gives us the actual forecast uncertainty.
 */
async function getEnsembleForecast(city, config) {
  const tempUnit = config.unit === 'F' ? 'fahrenheit' : 'celsius';
  
  // Use the ENSEMBLE API endpoint (different from regular forecast!)
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${config.lat}&longitude=${config.lon}&hourly=temperature_2m&models=gfs_seamless&forecast_days=3&temperature_unit=${tempUnit}`;
  
  const data = await fetchJSON(url);
  const hourly = data.hourly || {};
  const times = hourly.time || [];
  
  // Find all ensemble member columns (temperature_2m_member00 through temperature_2m_member30)
  const memberKeys = Object.keys(hourly).filter(k => k.startsWith('temperature_2m'));
  
  if (memberKeys.length === 0) {
    console.log(`  [ENSEMBLE] No ensemble data for ${city}, falling back to deterministic`);
    return null;
  }
  
  console.log(`  [ENSEMBLE] ${city}: ${memberKeys.length} ensemble members`);
  
  // Group by date, extract daily high for each member
  const dailyEnsemble = {};
  
  for (let i = 0; i < times.length; i++) {
    const date = times[i].split('T')[0];
    if (!dailyEnsemble[date]) {
      dailyEnsemble[date] = {
        memberHighs: {},  // memberKey -> max temp for that day
        allHourlyByMember: {},
      };
    }
    
    for (const key of memberKeys) {
      const temp = hourly[key]?.[i];
      if (temp == null) continue;
      
      if (!dailyEnsemble[date].memberHighs[key] || temp > dailyEnsemble[date].memberHighs[key]) {
        dailyEnsemble[date].memberHighs[key] = temp;
      }
    }
  }
  
  // Convert to array of daily highs per member
  const result = {};
  for (const [date, data] of Object.entries(dailyEnsemble)) {
    const highs = Object.values(data.memberHighs);
    if (highs.length === 0) continue;
    
    const mean = highs.reduce((s, t) => s + t, 0) / highs.length;
    const variance = highs.reduce((s, t) => s + (t - mean) ** 2, 0) / highs.length;
    const stdDev = Math.sqrt(variance);
    
    result[date] = {
      ensembleHighs: highs.sort((a, b) => a - b),  // Sorted for percentile calculation
      mean: +mean.toFixed(1),
      median: highs[Math.floor(highs.length / 2)],
      min: Math.min(...highs),
      max: Math.max(...highs),
      stdDev: +stdDev.toFixed(2),
      confidence: Math.max(0, Math.min(1, 1 - (stdDev / (CITY_TYPICAL_SPREAD[city] || 10)))),  // Relative to city's typical spread
      memberCount: highs.length,
    };
  }
  
  return result;
}

/**
 * Fallback: deterministic Open-Meteo forecast (same as v1.0)
 */
async function getDeterministicForecast(city, config) {
  const unit = config.unit === 'F' ? 'fahrenheit' : 'celsius';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${config.lat}&longitude=${config.lon}&hourly=temperature_2m&temperature_unit=${unit}&forecast_days=3&timezone=auto`;
  const data = await fetchJSON(url);
  
  const times = data.hourly?.time || [];
  const temps = data.hourly?.temperature_2m || [];
  
  const dailyHighs = {};
  for (let i = 0; i < times.length; i++) {
    const date = times[i].split('T')[0];
    if (!dailyHighs[date] || temps[i] > dailyHighs[date].mean) {
      dailyHighs[date] = { mean: temps[i], hour: times[i] };
    }
  }
  
  // Wrap in ensemble-like format with assumed normal distribution
  const result = {};
  for (const [date, data] of Object.entries(dailyHighs)) {
    const sigma = config.unit === 'F' ? 3.0 : 1.5;  // Assumed uncertainty
    // Generate synthetic ensemble from normal distribution
    const syntheticHighs = [];
    for (let i = 0; i < 31; i++) {
      // Box-Muller transform for normal random
      const u1 = Math.random(), u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      syntheticHighs.push(+(data.mean + z * sigma).toFixed(1));
    }
    syntheticHighs.sort((a, b) => a - b);
    
    result[date] = {
      ensembleHighs: syntheticHighs,
      mean: data.mean,
      median: syntheticHighs[15],
      min: Math.min(...syntheticHighs),
      max: Math.max(...syntheticHighs),
      stdDev: sigma,
      confidence: 0.5,  // Low confidence for synthetic ensemble
      memberCount: 31,
      synthetic: true,
    };
  }
  
  return result;
}

/**
 * NOAA deterministic (US only) — used as secondary reference
 */
async function getNOAAForecast(config) {
  if (!config.noaa) return null;
  try {
    const url = `https://api.weather.gov/gridpoints/${config.noaa}/forecast/hourly`;
    const data = await fetchJSON(url);
    const periods = data.properties?.periods || [];
    
    const dailyHighs = {};
    for (const p of periods) {
      const date = p.startTime.split('T')[0];
      const temp = p.temperature;
      if (!dailyHighs[date] || temp > dailyHighs[date]) {
        dailyHighs[date] = temp;
      }
    }
    return dailyHighs;
  } catch (e) {
    return null;
  }
}

// ── Ensemble Probability Calculation ─────────────────────────────────────────

/**
 * Calculate probability using ACTUAL ensemble members (not assumed distribution).
 * This is the core advantage over v1.0: real data, not an assumed bell curve.
 * 
 * For 31 ensemble members, probability = (count matching) / 31
 */
function ensembleProbability(parsed, ensembleData) {
  const highs = ensembleData.ensembleHighs;
  if (!highs || highs.length === 0) return null;
  
  const n = highs.length;
  let matching = 0;
  
  // Polymarket resolves on the integer value recorded by the weather station.
  // No rounding buffer — use exact integer boundaries.
  // Ensemble members are continuous (e.g., 22.7°C), so we round each to nearest
  // integer to match how weather stations report, then check the bucket.
  const roundedHighs = highs.map(t => Math.round(t));
  
  switch (parsed.type) {
    case 'range': {
      // P(low <= rounded_temp <= high)
      matching = roundedHighs.filter(t => t >= parsed.low && t <= parsed.high).length;
      break;
    }
    case 'exact': {
      // P(rounded_temp == value)
      matching = roundedHighs.filter(t => t === parsed.low).length;
      break;
    }
    case 'at_or_below': {
      matching = roundedHighs.filter(t => t <= parsed.high).length;
      break;
    }
    case 'at_or_above': {
      matching = roundedHighs.filter(t => t >= parsed.low).length;
      break;
    }
    default:
      return null;
  }
  
  return matching / n;
}

// ── Polymarket Weather Market Parsing (EXPANDED) ─────────────────────────────

function parseWeatherMarket(question) {
  const q = question.toLowerCase();
  
  // Must be about temperature
  if (!q.includes('temperature') && !q.includes('temp')) return null;
  
  // Extract city
  let city = null;
  for (const [name, config] of Object.entries(CITIES)) {
    if (config.polyAliases.some(alias => q.includes(alias))) {
      city = name;
      break;
    }
  }
  if (!city) return null;

  // Extract date — handle multiple formats
  const monthNames = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
  
  let date = null;
  
  // Format 1: "february 13, 2026" or "february 13"
  const dateMatch1 = q.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if (dateMatch1) {
    const month = monthNames[dateMatch1[1].toLowerCase()];
    const day = dateMatch1[2].padStart(2, '0');
    const year = dateMatch1[3] || '2026';
    date = `${year}-${month}-${day}`;
  }
  
  // Format 2: "2026-02-13" (ISO format in slug)
  if (!date) {
    const dateMatch2 = q.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch2) date = `${dateMatch2[1]}-${dateMatch2[2]}-${dateMatch2[3]}`;
  }
  
  if (!date) return null;

  const unit = CITIES[city].unit;
  let type = null, low = null, high = null;

  // "between X-Y°F" / "between X-Y°C" / "between X–Y°F"
  const rangeMatch = q.match(/between\s+(-?\d+)\s*[–-]\s*(-?\d+)\s*°?\s*[fc°]/i);
  if (rangeMatch) {
    type = 'range';
    low = parseInt(rangeMatch[1]);
    high = parseInt(rangeMatch[2]);
  }

  // "X°F or below" / "X°C or below" / "X°F or less"
  if (!type) {
    const belowMatch = q.match(/(-?\d+)\s*°?\s*[fc°]?\s+or\s+(?:below|less|lower)/i);
    if (belowMatch) { type = 'at_or_below'; high = parseInt(belowMatch[1]); }
  }

  // "X°F or higher" / "X°C or higher" / "X°F or more" / "X°F or above"
  if (!type) {
    const aboveMatch = q.match(/(-?\d+)\s*°?\s*[fc°]?\s+or\s+(?:higher|more|above|greater)/i);
    if (aboveMatch) { type = 'at_or_above'; low = parseInt(aboveMatch[1]); }
  }

  // "be X°F on" / "be X°C on" (exact value)
  if (!type) {
    const exactMatch = q.match(/be\s+(-?\d+)\s*°\s*[fc°]\s+on/i);
    if (exactMatch) { type = 'exact'; low = parseInt(exactMatch[1]); high = parseInt(exactMatch[1]); }
  }
  
  // "be X°C on" (exact, alternative pattern)
  if (!type) {
    const exactMatch2 = q.match(/(?:highest|lowest)\s+temperature.*?be\s+(-?\d+)\s*°\s*[fc°]/i);
    if (exactMatch2) { type = 'exact'; low = parseInt(exactMatch2[1]); high = parseInt(exactMatch2[1]); }
  }

  // "above X°F" / "over X°F" / "exceed X°F"
  if (!type) {
    const overMatch = q.match(/(?:above|over|exceed|exceeds)\s+(-?\d+)\s*°?\s*[fc°]/i);
    if (overMatch) { type = 'at_or_above'; low = parseInt(overMatch[1]); }
  }

  // "below X°F" / "under X°F"
  if (!type) {
    const underMatch = q.match(/(?:below|under)\s+(-?\d+)\s*°?\s*[fc°]/i);
    if (underMatch) { type = 'at_or_below'; high = parseInt(underMatch[1]); }
  }

  // "neg X" patterns for negative temperatures: "neg 3c" = -3°C
  if (!type) {
    const negMatch = q.match(/neg\s*(\d+)\s*[fc°]/i);
    if (negMatch) {
      const val = -parseInt(negMatch[1]);
      if (q.includes('or below') || q.includes('or less')) { type = 'at_or_below'; high = val; }
      else if (q.includes('or higher') || q.includes('or above')) { type = 'at_or_above'; low = val; }
      else { type = 'exact'; low = val; high = val; }
    }
  }

  if (!type) return null;

  return { city, date, type, low, high, unit };
}

// ── Kelly Criterion Sizing ───────────────────────────────────────────────────

/**
 * Quarter-Kelly position sizing
 * Adapted from suislanchez bot: kelly = (edge × confidence) / (1 - market_price) × bankroll × 0.25
 * 
 * @param {number} edge - Our edge (forecastProb - marketPrice)
 * @param {number} confidence - Ensemble confidence (0-1)
 * @param {number} marketPrice - Current market YES price
 * @param {number} bankroll - Current bankroll
 * @returns {number} Suggested position size in dollars
 */
function kellySize(edge, confidence, marketPrice, bankroll = CONFIG.BANKROLL) {
  if (edge <= 0 || marketPrice <= 0 || marketPrice >= 1) return 0;
  
  // Kelly fraction = (edge * confidence) / (1 - marketPrice)
  const kelly = (edge * confidence) / (1 - marketPrice);
  
  // Apply quarter-Kelly
  const adjustedKelly = kelly * CONFIG.KELLY_FRACTION;
  
  // Calculate dollar amount
  let size = adjustedKelly * bankroll;
  
  // Apply caps
  size = Math.min(size, CONFIG.MAX_TRADE_SIZE);
  size = Math.min(size, bankroll * CONFIG.MAX_BANKROLL_PCT);
  size = Math.max(size, 0);
  
  return +size.toFixed(2);
}

// ── Temperature Laddering (neobrother's strategy) ────────────────────────────

/**
 * Generate ladder signals across adjacent temperature buckets.
 * 
 * Instead of betting on one bucket, buy YES across 3-5 adjacent buckets
 * weighted by ensemble probability. The cheap ones (2-8¢) provide massive
 * upside if the forecast is slightly off.
 * 
 * @param {Array} marketsForCity - All parsed markets for a city+date
 * @param {Object} ensembleData - Ensemble forecast data
 * @param {string} unit - 'F' or 'C'
 * @returns {Object} Ladder signal with constituent legs
 */
function generateLadder(marketsForCity, ensembleData, unit) {
  // Only ladder range/exact markets (not "or above"/"or below")
  const rangeMkts = marketsForCity.filter(m => m.type === 'range' || m.type === 'exact');
  if (rangeMkts.length < 3) return null;
  
  // Sort by bucket midpoint
  rangeMkts.sort((a, b) => {
    const midA = a.type === 'range' ? (a.low + a.high) / 2 : a.low;
    const midB = b.type === 'range' ? (b.low + b.high) / 2 : b.low;
    return midA - midB;
  });
  
  // Calculate ensemble probability for each bucket
  const bucketData = rangeMkts.map(m => {
    const prob = ensembleProbability(m, ensembleData);
    return {
      ...m,
      forecastProb: prob,
      edge: prob != null ? prob - m.yesPrice : null,
    };
  });
  
  // Find the peak probability bucket
  let peakIdx = 0;
  let peakProb = 0;
  for (let i = 0; i < bucketData.length; i++) {
    if (bucketData[i].forecastProb > peakProb) {
      peakProb = bucketData[i].forecastProb;
      peakIdx = i;
    }
  }
  
  // Build ladder: peak ± 2 adjacent buckets (5 total max)
  const ladderStart = Math.max(0, peakIdx - 2);
  const ladderEnd = Math.min(bucketData.length - 1, peakIdx + 2);
  
  const legs = [];
  let totalCost = 0;
  
  for (let i = ladderStart; i <= ladderEnd; i++) {
    const b = bucketData[i];
    if (b.forecastProb == null || b.forecastProb < 0.01) continue;
    if (b.edge == null || b.edge < CONFIG.MIN_EDGE_LADDER) continue;
    if (b.yesPrice > 0.50) continue;  // Only buy cheap buckets (neobrother's key insight)
    
    // Size proportional to probability, but also consider value
    const size = kellySize(b.edge, ensembleData.confidence, b.yesPrice);
    if (size < 0.50) continue;  // Skip tiny positions
    
    const cappedSize = Math.min(size, CONFIG.MAX_LADDER_TOTAL / 5);
    totalCost += cappedSize;
    
    if (totalCost > CONFIG.MAX_LADDER_TOTAL) break;
    
    legs.push({
      bucket: b.type === 'range' ? `${b.low}-${b.high}` : `${b.low}`,
      question: b.question,
      slug: b.slug,
      conditionId: b.conditionId,
      yesTokenId: b.yesTokenId,
      noTokenId: b.noTokenId,
      forecastProb: +(b.forecastProb).toFixed(4),
      marketPrice: b.yesPrice,
      edge: +(b.edge).toFixed(4),
      suggestedSize: cappedSize,
      potentialReturn: +((1 / b.yesPrice - 1) * cappedSize).toFixed(2),
      isPeak: i === peakIdx,
    });
  }
  
  if (legs.length < 2) return null;
  
  const totalPotentialReturn = legs.reduce((s, l) => s + l.potentialReturn, 0);
  
  return {
    type: 'LADDER',
    city: marketsForCity[0].city,
    date: marketsForCity[0].date,
    unit,
    legs,
    totalCost: +totalCost.toFixed(2),
    totalPotentialReturn: +totalPotentialReturn.toFixed(2),
    returnRatio: +(totalPotentialReturn / totalCost).toFixed(1),
    ensembleMean: ensembleData.mean,
    ensembleStdDev: ensembleData.stdDev,
    confidence: ensembleData.confidence,
  };
}

// ── Sum-to-100 Structural Check ──────────────────────────────────────────────

/**
 * Check if all buckets for a city+date sum to ~100%.
 * If significantly over (e.g., 110%), the entire market is overpriced → structural edge.
 * If under (e.g., 90%), underpriced → buy cheaply across buckets.
 */
function checkSumTo100(marketsForCity) {
  const rangeMkts = marketsForCity.filter(m => m.type === 'range' || m.type === 'exact');
  if (rangeMkts.length < 3) return null;
  
  // Check for complete coverage (should have "or below" and "or higher" endpoints too)
  const allMkts = marketsForCity;
  const totalYesPrice = allMkts.reduce((s, m) => s + m.yesPrice, 0);
  
  const deviation = totalYesPrice - 1.0;
  
  return {
    city: marketsForCity[0].city,
    date: marketsForCity[0].date,
    bucketCount: allMkts.length,
    sumYesPrice: +totalYesPrice.toFixed(4),
    deviation: +(deviation * 100).toFixed(1),  // As percentage
    isOverpriced: deviation > CONFIG.SUM_DEVIATION_THRESHOLD,
    isUnderpriced: deviation < -CONFIG.SUM_DEVIATION_THRESHOLD,
    signal: deviation > CONFIG.SUM_DEVIATION_THRESHOLD ? 'SELL_ALL' : 
            deviation < -CONFIG.SUM_DEVIATION_THRESHOLD ? 'BUY_CHEAP' : 'FAIR',
  };
}

// ── GFS Update Timing ────────────────────────────────────────────────────────

/**
 * Check when the last GFS forecast update was.
 * GFS updates at 00, 06, 12, 18 UTC. Data available ~3.5-4h after run time.
 * The first 5-10 minutes after data availability is the prime trading window.
 */
function getForecastUpdateInfo() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  
  // GFS cycle times
  const cycles = [0, 6, 12, 18];
  const dataLag = 4; // Hours after cycle time until data available
  
  // Find most recent available cycle
  let lastAvailableCycle = null;
  for (const cycle of cycles.reverse()) {
    const availableHour = (cycle + dataLag) % 24;
    const availableDay = cycle + dataLag >= 24 ? 1 : 0;
    
    if (utcHour >= availableHour || availableDay === 0) {
      lastAvailableCycle = cycle;
      break;
    }
  }
  
  // Find next cycle availability
  const nextCycleIdx = cycles.findIndex(c => {
    const avail = (c + dataLag) % 24;
    return avail > utcHour;
  });
  const nextCycle = nextCycleIdx >= 0 ? cycles[nextCycleIdx] : cycles[0];
  const nextAvailable = (nextCycle + dataLag) % 24;
  
  const hoursUntilNext = nextAvailable > utcHour 
    ? nextAvailable - utcHour 
    : 24 - utcHour + nextAvailable;
  
  return {
    lastCycleUTC: lastAvailableCycle != null ? `${String(lastAvailableCycle).padStart(2,'0')}:00` : 'unknown',
    nextUpdateUTC: `${String(nextAvailable).padStart(2,'0')}:00`,
    hoursUntilNextUpdate: +hoursUntilNext.toFixed(1),
    isNearUpdate: hoursUntilNext < 0.5,  // Within 30 min of new data
    currentUTC: `${String(utcHour).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`,
  };
}

// ── Main Pipeline ────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Weather Forecast Arbitrage Scanner v2.0 ===');
  console.log('   31-member GFS ensemble | Kelly sizing | Laddering\n');
  const t0 = Date.now();
  
  // Show forecast timing info
  const timing = getForecastUpdateInfo();
  console.log(`[TIMING] Current: ${timing.currentUTC} UTC | Last GFS cycle: ${timing.lastCycleUTC} | Next update: ${timing.nextUpdateUTC} (${timing.hoursUntilNextUpdate}h)`);
  if (timing.isNearUpdate) console.log('  ⚡ NEAR UPDATE WINDOW — markets may be stale!');
  console.log('');

  // Step 1: Fetch Polymarket weather markets
  console.log('[FETCH] Polymarket weather markets...');
  const allMarkets = [];
  const seen = new Set();
  
  // Source 1: ws-feed resolving markets
  try {
    const resolvingData = await fetchJSON('http://localhost:3003/resolving');
    const weatherResolving = (resolvingData.markets || []).filter(m => 
      (m.question || '').toLowerCase().includes('temperature')
    );
    for (const m of weatherResolving) {
      if (!seen.has(m.conditionId)) { allMarkets.push(m); seen.add(m.conditionId); }
    }
    console.log(`  Resolving markets: ${weatherResolving.length} weather`);
  } catch (e) { console.log('  Resolving: unavailable'); }

  // Source 2: Gamma events API — fetch up to 1000 weather markets
  for (let offset = 0; offset < 1000; offset += 100) {
    try {
      const url = `${GAMMA_API}/events?closed=false&active=true&limit=100&offset=${offset}&slug_contains=highest-temperature&order=volume24hr&ascending=false`;
      const events = await fetchJSON(url);
      if (!events?.length) break;
      for (const event of events) {
        for (const m of (event.markets || [])) {
          if (!seen.has(m.conditionId)) { allMarkets.push(m); seen.add(m.conditionId); }
        }
      }
      await sleep(200);
    } catch { break; }
  }
  
  console.log(`[FETCH] ${allMarkets.length} total weather markets found`);

  // Step 2: Parse weather markets (expanded parser)
  const parsed = [];
  for (const m of allMarkets) {
    const p = parseWeatherMarket(m.question || '');
    if (!p) continue;
    
    let yesPrice = null;
    try {
      const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      yesPrice = parseFloat(prices?.[0]) || null;
    } catch {}
    
    // Also try yesPrice/noPrice fields directly
    if (yesPrice == null) yesPrice = parseFloat(m.yesPrice) || null;
    if (yesPrice == null) continue;
    
    // Extract YES/NO token IDs from clobTokenIds array [YES, NO]
    let yesTokenId = null, noTokenId = null;
    try {
      const tids = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
      if (Array.isArray(tids) && tids.length >= 2) {
        yesTokenId = tids[0];
        noTokenId = tids[1];
      }
    } catch {}
    
    parsed.push({
      ...p,
      question: m.question,
      slug: m.slug,
      conditionId: m.conditionId,
      yesTokenId,
      noTokenId,
      yesPrice,
      volume24h: parseFloat(m.volume24hr || m.volume24h) || 0,
      liquidity: parseFloat(m.liquidityClob || m.liquidity) || 0,
      endDate: m.endDate,
    });
  }
  
  console.log(`[PARSE] ${parsed.length} markets parsed (${allMarkets.length - parsed.length} unparseable — ${((parsed.length / Math.max(allMarkets.length, 1)) * 100).toFixed(0)}% hit rate)`);

  // Step 2b: Backfill missing token IDs via Gamma markets API
  const missingTokenIds = parsed.filter(p => !p.yesTokenId && p.conditionId);
  if (missingTokenIds.length > 0) {
    console.log(`[TOKENS] Backfilling ${missingTokenIds.length} missing token IDs from CLOB API...`);
    // Use CLOB API /markets/{conditionId} — returns tokens with token_id and outcome
    for (const p of missingTokenIds) {
      try {
        const url = `https://clob.polymarket.com/markets/${p.conditionId}`;
        const m = await fetchJSON(url);
        if (m?.tokens && Array.isArray(m.tokens)) {
          const yesToken = m.tokens.find(t => t.outcome === 'Yes');
          const noToken = m.tokens.find(t => t.outcome === 'No');
          if (yesToken) p.yesTokenId = yesToken.token_id;
          if (noToken) p.noTokenId = noToken.token_id;
        }
        await sleep(100); // Rate limit
      } catch {}
    }
    const filled = missingTokenIds.filter(p => p.yesTokenId).length;
    console.log(`[TOKENS] Backfilled ${filled}/${missingTokenIds.length} token IDs`);
  }

  // Step 3: Group by city+date
  const cityDates = {};
  for (const p of parsed) {
    const key = `${p.city}|${p.date}`;
    if (!cityDates[key]) cityDates[key] = [];
    cityDates[key].push(p);
  }
  
  console.log(`[GROUPS] ${Object.keys(cityDates).length} city-date groups`);

  // Step 4: Fetch ENSEMBLE forecasts (the big upgrade)
  console.log(`\n[ENSEMBLE] Fetching 31-member GFS ensemble forecasts...`);
  const forecasts = {};
  const noaaForecasts = {};
  const fetchedCities = new Set();
  
  for (const key of Object.keys(cityDates)) {
    const [city, date] = key.split('|');
    const config = CITIES[city];
    if (!config || fetchedCities.has(city)) continue;
    fetchedCities.add(city);
    
    try {
      // Primary: 31-member GFS ensemble
      const ensemble = await getEnsembleForecast(city, config);
      if (ensemble) {
        for (const [d, data] of Object.entries(ensemble)) {
          forecasts[`${city}|${d}`] = data;
        }
      } else {
        // Fallback: deterministic with synthetic ensemble
        const determ = await getDeterministicForecast(city, config);
        if (determ) {
          for (const [d, data] of Object.entries(determ)) {
            forecasts[`${city}|${d}`] = data;
          }
        }
      }
      
      // Also fetch NOAA for US cities as secondary reference
      if (config.noaa) {
        const noaa = await getNOAAForecast(config);
        if (noaa) noaaForecasts[city] = noaa;
      }
      
      await sleep(500);  // Rate limit Open-Meteo
    } catch (e) {
      console.log(`  ${city}: error: ${e.message}`);
    }
  }
  
  // Log forecast summary
  for (const key of Object.keys(cityDates)) {
    const f = forecasts[key];
    if (!f) continue;
    const [city, date] = key.split('|');
    const unit = CITIES[city]?.unit || '?';
    const srcTag = f.synthetic ? '(synthetic)' : `(${f.memberCount} members)`;
    const noaaRef = noaaForecasts[city]?.[date] ? ` | NOAA: ${noaaForecasts[city][date]}°${unit}` : '';
    console.log(`  ${city} ${date}: ${f.mean}°${unit} ±${f.stdDev}° ${srcTag} [conf: ${(f.confidence * 100).toFixed(0)}%]${noaaRef}`);
  }

  // Step 5: Compare ensemble forecasts to market prices + generate signals
  console.log('\n[SIGNALS] Comparing ensemble vs market...');
  const signals = [];
  const ladders = [];
  const sumChecks = [];
  const allResults = [];

  for (const [key, markets] of Object.entries(cityDates)) {
    const forecast = forecasts[key];
    if (!forecast) continue;
    
    const [city] = key.split('|');
    const config = CITIES[city];
    
    // Sum-to-100 check
    const sumCheck = checkSumTo100(markets);
    if (sumCheck) sumChecks.push(sumCheck);
    
    // Temperature ladder signal
    const ladder = generateLadder(markets, forecast, config.unit);
    if (ladder) ladders.push(ladder);
    
    // Individual market signals
    for (const mkt of markets) {
      const forecastProb = ensembleProbability(mkt, forecast);
      if (forecastProb == null) continue;
      
      const edge = forecastProb - mkt.yesPrice;
      const edgePct = mkt.yesPrice > 0 ? +((edge / mkt.yesPrice) * 100).toFixed(1) : 0;
      const size = kellySize(Math.abs(edge), forecast.confidence, 
                             edge > 0 ? mkt.yesPrice : (1 - mkt.yesPrice));
      
      const result = {
        city,
        date: mkt.date,
        question: mkt.question?.slice(0, 120),
        slug: mkt.slug,
        conditionId: mkt.conditionId,
        yesTokenId: mkt.yesTokenId,
        noTokenId: mkt.noTokenId,
        type: mkt.type,
        bucket: mkt.type === 'range' ? `${mkt.low}-${mkt.high}` : mkt.type === 'exact' ? `${mkt.low}` : mkt.type === 'at_or_below' ? `≤${mkt.high}` : `≥${mkt.low}`,
        unit: config.unit,
        // Ensemble data
        ensembleMean: forecast.mean,
        ensembleStdDev: forecast.stdDev,
        ensembleMembers: forecast.memberCount,
        ensembleConfidence: +(forecast.confidence).toFixed(2),
        synthetic: !!forecast.synthetic,
        // Signal
        forecastProb: +forecastProb.toFixed(4),
        marketPrice: mkt.yesPrice,
        edge: +edge.toFixed(4),
        edgePct,
        signal: edge > CONFIG.MIN_EDGE ? 'BUY_YES' : edge < -CONFIG.MIN_EDGE ? 'BUY_NO' : 'FAIR',
        // Sizing
        kellySize: size,
        // Metadata
        volume24h: mkt.volume24h,
        liquidity: mkt.liquidity,
        endDate: mkt.endDate,
      };
      
      allResults.push(result);
      if (Math.abs(edge) > CONFIG.MIN_EDGE && forecast.confidence >= CONFIG.ENSEMBLE_MIN_CONFIDENCE) {
        signals.push(result);
      }
    }
  }

  // Sort by edge strength
  signals.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
  allResults.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
  ladders.sort((a, b) => b.returnRatio - a.returnRatio);

  const output = {
    version: '2.0',
    timestamp: new Date().toISOString(),
    runtime: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    timing,
    stats: {
      marketsFound: allMarkets.length,
      marketsParsed: parsed.length,
      parseRate: `${((parsed.length / Math.max(allMarkets.length, 1)) * 100).toFixed(0)}%`,
      cityDateGroups: Object.keys(cityDates).length,
      forecastsFetched: Object.keys(forecasts).length,
      ensembleForecasts: Object.values(forecasts).filter(f => !f.synthetic).length,
      syntheticForecasts: Object.values(forecasts).filter(f => f.synthetic).length,
      resultsCompared: allResults.length,
      signalCount: signals.length,
      ladderCount: ladders.length,
      sumChecks: sumChecks.length,
    },
    signals: signals.slice(0, 50),
    ladders: ladders.slice(0, 10),
    sumChecks: sumChecks.filter(s => s.signal !== 'FAIR'),
    all: allResults.slice(0, 200),
    forecasts: Object.fromEntries(
      Object.entries(forecasts).map(([k, v]) => [k, { 
        mean: v.mean, stdDev: v.stdDev, confidence: v.confidence, 
        members: v.memberCount, synthetic: v.synthetic,
        min: v.min, max: v.max, median: v.median,
      }])
    ),
  };
  
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  // ── Console Output ─────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  WEATHER SCANNER v2.0 RESULTS`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Runtime:             ${output.runtime}`);
  console.log(`Markets found:       ${allMarkets.length}`);
  console.log(`Markets parsed:      ${parsed.length} (${output.stats.parseRate})`);
  console.log(`Ensemble forecasts:  ${output.stats.ensembleForecasts} (${output.stats.syntheticForecasts} synthetic)`);
  console.log(`Comparisons:         ${allResults.length}`);
  console.log(`Signals (>${CONFIG.MIN_EDGE*100}% edge): ${signals.length}`);
  console.log(`Ladder opportunities: ${ladders.length}`);
  console.log(`Sum-to-100 alerts:   ${sumChecks.filter(s => s.signal !== 'FAIR').length}`);

  // Show sum-to-100 alerts
  const sumAlerts = sumChecks.filter(s => s.signal !== 'FAIR');
  if (sumAlerts.length > 0) {
    console.log(`\n📊 Sum-to-100 Structural Alerts:`);
    for (const s of sumAlerts) {
      const icon = s.isOverpriced ? '🔴' : '🟢';
      console.log(`  ${icon} ${s.city} ${s.date}: ${s.bucketCount} buckets sum to ${(s.sumYesPrice * 100).toFixed(1)}% (${s.deviation > 0 ? '+' : ''}${s.deviation}%) → ${s.signal}`);
    }
  }

  // Show ladder opportunities
  if (ladders.length > 0) {
    console.log(`\n🪜 Temperature Ladder Opportunities (neobrother strategy):`);
    for (const l of ladders.slice(0, 5)) {
      console.log(`  ${l.city} ${l.date}: ${l.legs.length} legs | Cost: $${l.totalCost} | Potential: $${l.totalPotentialReturn} (${l.returnRatio}x)`);
      console.log(`    Forecast: ${l.ensembleMean}°${l.unit} ±${l.ensembleStdDev}° [conf: ${(l.confidence * 100).toFixed(0)}%]`);
      for (const leg of l.legs) {
        const peakMark = leg.isPeak ? ' ★' : '';
        console.log(`    → ${leg.bucket}°${l.unit}: market ${(leg.marketPrice * 100).toFixed(1)}¢ | forecast ${(leg.forecastProb * 100).toFixed(1)}% | edge ${(leg.edge * 100).toFixed(1)}¢ | size $${leg.suggestedSize}${peakMark}`);
      }
    }
  }

  // Show individual signals
  if (signals.length > 0) {
    console.log(`\n🌤️ Individual Signals (${signals.length}):`);
    for (const s of signals.slice(0, 20)) {
      const icon = s.signal === 'BUY_YES' ? '📈' : '📉';
      const ensembleTag = s.synthetic ? '(synth)' : `(${s.ensembleMembers}m)`;
      console.log(`  ${icon} ${s.signal} | ${s.city} ${s.date} | ${s.bucket}°${s.unit}`);
      console.log(`     Ensemble: ${s.ensembleMean}°${s.unit} ±${s.ensembleStdDev}° ${ensembleTag} → prob: ${(s.forecastProb*100).toFixed(1)}%`);
      console.log(`     Market: ${(s.marketPrice*100).toFixed(1)}¢ | Edge: ${(s.edge*100).toFixed(1)}¢ (${s.edgePct}%) | Kelly: $${s.kellySize}`);
      console.log(`     Vol: $${s.volume24h.toFixed(0)} | Liq: $${s.liquidity.toFixed(0)}`);
    }
  } else {
    console.log('\nNo actionable signals found.');
  }

  // Show forecast summary
  console.log(`\n📊 Forecasts:`);
  for (const [key, f] of Object.entries(forecasts)) {
    const [city, date] = key.split('|');
    const unit = CITIES[city]?.unit || '?';
    const srcTag = f.synthetic ? 'synthetic' : `${f.memberCount} members`;
    console.log(`  ${city} ${date}: HIGH ${f.mean}°${unit} ±${f.stdDev}° (${srcTag}, conf ${(f.confidence*100).toFixed(0)}%)`);
  }

  console.log(`\nOutput: ${OUTPUT_FILE}`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
