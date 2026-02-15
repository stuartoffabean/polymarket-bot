#!/usr/bin/env node
/**
 * Weather V2 — Forecast-based weather market scanner
 * 
 * Uses Open-Meteo API (free, global, no key) for hourly temperature forecasts.
 * Compares forecast-derived probabilities against Polymarket bucket prices.
 * Outputs opportunities where forecast edge > 20%.
 * 
 * PAPER TRADE ONLY — logs to weather-v2-paper.json, never places orders.
 * 
 * Usage: node weather-v2.js [--dry-run] [--city NYC] [--min-edge 0.20]
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const GAMMA_API = 'https://gamma-api.polymarket.com';
const OPEN_METEO_API = 'https://api.open-meteo.com/v1/forecast';
const PAPER_FILE = path.join(__dirname, 'weather-v2-paper.json');
const MIN_EDGE = parseFloat(process.env.MIN_EDGE || '0.20'); // 20% minimum edge

// City configs: name variations Polymarket uses → coordinates + temp unit
const CITIES = {
  'New York City': { lat: 40.7128, lon: -74.0060, unit: 'fahrenheit', aliases: ['NYC', 'New York'] },
  'Miami':         { lat: 25.7617, lon: -80.1918, unit: 'fahrenheit', aliases: [] },
  'Chicago':       { lat: 41.8781, lon: -87.6298, unit: 'fahrenheit', aliases: [] },
  'Atlanta':       { lat: 33.7490, lon: -84.3880, unit: 'fahrenheit', aliases: [] },
  'Dallas':        { lat: 32.7767, lon: -96.7970, unit: 'fahrenheit', aliases: [] },
  'Seattle':       { lat: 47.6062, lon: -122.3321, unit: 'fahrenheit', aliases: [] },
  'Toronto':       { lat: 43.6532, lon: -79.3832, unit: 'celsius', aliases: [] },
  'London':        { lat: 51.5074, lon: -0.1278, unit: 'celsius', aliases: [] },
  'Seoul':         { lat: 37.5665, lon: 126.9780, unit: 'celsius', aliases: [] },
  'Buenos Aires':  { lat: -34.6037, lon: -58.3816, unit: 'celsius', aliases: [] },
  'Ankara':        { lat: 39.9334, lon: 32.8597, unit: 'celsius', aliases: [] },
  'Wellington':    { lat: -41.2865, lon: 174.7762, unit: 'celsius', aliases: [] },
  'São Paulo':     { lat: -23.5505, lon: -46.6333, unit: 'celsius', aliases: ['Sao Paulo'] },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════
// HTTP HELPER
// ═══════════════════════════════════════════════════════════════

function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    const parsed = new URL(url);
    const req = mod.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'WeatherV2-PolymarketBot/1.0', 'Accept': 'application/json' },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error(`JSON parse failed: ${d.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ═══════════════════════════════════════════════════════════════
// OPEN-METEO FORECAST
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch hourly temperature forecast for a city.
 * Returns { date: '2026-02-16', hourlyTemps: [temp0, temp1, ...temp23], highTemp, unit }
 */
async function fetchForecast(cityName, cityConfig, targetDate) {
  const unit = cityConfig.unit;
  const url = `${OPEN_METEO_API}?latitude=${cityConfig.lat}&longitude=${cityConfig.lon}&hourly=temperature_2m&temperature_unit=${unit}&forecast_days=3&timezone=auto`;
  
  const data = await httpGet(url);
  const times = data.hourly.time;
  const temps = data.hourly.temperature_2m;
  
  // Filter to target date
  const dateStr = targetDate; // e.g. '2026-02-16'
  const dayTemps = [];
  for (let i = 0; i < times.length; i++) {
    if (times[i].startsWith(dateStr)) {
      dayTemps.push(temps[i]);
    }
  }
  
  if (dayTemps.length === 0) {
    return null;
  }
  
  const highTemp = Math.max(...dayTemps);
  
  return {
    city: cityName,
    date: dateStr,
    hourlyTemps: dayTemps,
    highTemp,
    unit: unit === 'fahrenheit' ? '°F' : '°C',
  };
}

// ═══════════════════════════════════════════════════════════════
// FORECAST → BUCKET PROBABILITY
// ═══════════════════════════════════════════════════════════════

/**
 * Given a forecast high temp, compute probability for each bucket.
 * Uses a normal distribution centered on forecast high with σ based on
 * forecast horizon (±2°F/1°C for day-of, ±4°F/2°C for next-day).
 * 
 * Returns Map<bucketKey, probability> where bucketKey = "36-37" or "≤33" or "≥46"
 */
function computeBucketProbabilities(forecastHigh, buckets, unit, hoursUntilResolution) {
  // Forecast uncertainty: grows with time
  // Day-of (0-12h): σ ≈ 1.5°F / 0.8°C
  // Next-day (12-36h): σ ≈ 3°F / 1.5°C  
  // 2-day (36-60h): σ ≈ 5°F / 2.5°C
  let sigma;
  if (unit === '°F') {
    if (hoursUntilResolution <= 12) sigma = 1.5;
    else if (hoursUntilResolution <= 36) sigma = 3.0;
    else sigma = 5.0;
  } else {
    if (hoursUntilResolution <= 12) sigma = 0.8;
    else if (hoursUntilResolution <= 36) sigma = 1.5;
    else sigma = 2.5;
  }
  
  const probs = {};
  
  for (const bucket of buckets) {
    const { low, high, key } = bucket;
    // P(low <= X < high) using normal CDF
    const pHigh = high === Infinity ? 1 : normalCDF((high - forecastHigh) / sigma);
    const pLow = low === -Infinity ? 0 : normalCDF((low - forecastHigh) / sigma);
    probs[key] = Math.max(0, pHigh - pLow);
  }
  
  return probs;
}

// Standard normal CDF approximation (Abramowitz and Stegun)
function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

// ═══════════════════════════════════════════════════════════════
// PARSE POLYMARKET WEATHER MARKETS
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a weather market question into bucket info.
 * Examples:
 *   "Will the highest temperature in New York City be between 36-37°F on February 15?"
 *   "Will the highest temperature in NYC be 46°F or higher on February 15?"
 *   "Will the highest temperature in London be 8°C on February 15?"
 */
function parseWeatherMarket(question) {
  // Match "between X-Y°F/°C"
  let m = question.match(/between (\d+)-(\d+)°([FC])/);
  if (m) {
    return { low: parseInt(m[1]), high: parseInt(m[2]) + 1, unit: '°' + m[3], key: `${m[1]}-${m[2]}` };
  }
  
  // Match "be X°C/°F" (exact single degree)
  m = question.match(/be (-?\d+)°([FC]) on/);
  if (m) {
    return { low: parseInt(m[1]), high: parseInt(m[1]) + 1, unit: '°' + m[2], key: `${m[1]}` };
  }
  
  // Match "X°F or higher" / "≥X°F"
  m = question.match(/(\d+)°([FC]) or higher|≥(\d+)°([FC])/);
  if (m) {
    const val = parseInt(m[1] || m[3]);
    const u = m[2] || m[4];
    return { low: val, high: Infinity, unit: '°' + u, key: `≥${val}` };
  }
  
  // Match "X°F or lower" / "≤X°F" / "X°F or below"
  m = question.match(/(-?\d+)°([FC]) or (?:lower|below)|≤(-?\d+)°([FC])/);
  if (m) {
    const val = parseInt(m[1] || m[3]);
    const u = m[2] || m[4];
    return { low: -Infinity, high: val + 1, unit: '°' + u, key: `≤${val}` };
  }
  
  return null;
}

/**
 * Extract city name from market question
 */
function extractCity(question) {
  for (const [city, config] of Object.entries(CITIES)) {
    if (question.includes(city)) return city;
    for (const alias of config.aliases) {
      if (question.includes(alias)) return city;
    }
  }
  return null;
}

/**
 * Extract date from market question/event title
 * Returns ISO date string like '2026-02-16'
 */
function extractDate(text) {
  const months = { January: '01', February: '02', March: '03', April: '04', May: '05', June: '06',
    July: '07', August: '08', September: '09', October: '10', November: '11', December: '12' };
  
  const m = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/);
  if (m) {
    const year = new Date().getFullYear();
    return `${year}-${months[m[1]]}-${String(m[2]).padStart(2, '0')}`;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// MAIN SCANNER
// ═══════════════════════════════════════════════════════════════

async function scanWeatherMarkets() {
  console.log('🌡️  Weather V2 Scanner starting...');
  console.log(`   Min edge threshold: ${(MIN_EDGE * 100).toFixed(0)}%`);
  console.log(`   Time: ${new Date().toISOString()}\n`);
  
  // 1. Fetch all active events from Polymarket
  const events = await httpGet(`${GAMMA_API}/events?limit=200&active=true&closed=false&order=volume24hr&ascending=false`);
  
  // 2. Filter to weather/temperature events
  const weatherEvents = events.filter(e => 
    e.title && (e.title.toLowerCase().includes('temperature') || e.title.toLowerCase().includes('highest temp'))
  );
  
  console.log(`📊 Found ${weatherEvents.length} active weather events\n`);
  
  if (weatherEvents.length === 0) {
    console.log('No active weather markets found.');
    return [];
  }
  
  const opportunities = [];
  const allAnalysis = [];
  const now = new Date();
  
  // 3. Process each weather event
  for (const event of weatherEvents) {
    const city = extractCity(event.title);
    const date = extractDate(event.title);
    
    if (!city || !date) {
      console.log(`⚠️  Skipping "${event.title}" — can't parse city/date`);
      continue;
    }
    
    const cityConfig = CITIES[city];
    if (!cityConfig) {
      console.log(`⚠️  Skipping "${city}" — no city config`);
      continue;
    }
    
    // Calculate hours until resolution (end of target date in local time)
    const targetEnd = new Date(date + 'T23:59:59Z');
    const hoursUntil = (targetEnd - now) / (1000 * 60 * 60);
    
    if (hoursUntil < 0) {
      console.log(`⏭️  Skipping "${event.title}" — already past`);
      continue;
    }
    
    if (hoursUntil > 60) {
      console.log(`⏭️  Skipping "${event.title}" — too far out (${hoursUntil.toFixed(0)}h)`);
      continue;
    }
    
    // 4. Fetch forecast
    let forecast;
    try {
      forecast = await fetchForecast(city, cityConfig, date);
      if (!forecast) {
        console.log(`⚠️  No forecast data for ${city} on ${date}`);
        continue;
      }
    } catch (err) {
      console.log(`❌ Forecast fetch failed for ${city}: ${err.message}`);
      continue;
    }
    
    console.log(`🏙️  ${city} — ${date} (resolves in ${hoursUntil.toFixed(0)}h)`);
    console.log(`   Forecast high: ${forecast.highTemp.toFixed(1)}${forecast.unit}`);
    
    // 5. Parse market buckets
    const activeMarkets = (event.markets || []).filter(m => m.active && !m.closed);
    const buckets = [];
    
    for (const market of activeMarkets) {
      const bucket = parseWeatherMarket(market.question);
      if (!bucket) {
        console.log(`   ⚠️  Can't parse: "${market.question}"`);
        continue;
      }
      
      const prices = JSON.parse(market.outcomePrices || '[]');
      const tokens = JSON.parse(market.clobTokenIds || '[]');
      
      bucket.yesPrice = parseFloat(prices[0] || '0');
      bucket.noPrice = parseFloat(prices[1] || '0');
      bucket.yesToken = tokens[0] || '';
      bucket.noToken = tokens[1] || '';
      bucket.marketId = market.id;
      bucket.question = market.question;
      buckets.push(bucket);
    }
    
    // 6. Compute forecast probabilities
    const probs = computeBucketProbabilities(
      forecast.highTemp, buckets, forecast.unit, hoursUntil
    );
    
    // 7. Compare forecast vs market prices → find edges
    console.log(`   Buckets:`);
    for (const bucket of buckets) {
      const forecastProb = probs[bucket.key] || 0;
      const marketPrice = bucket.yesPrice;
      const edge = forecastProb - marketPrice;
      
      const edgeStr = edge >= 0 ? `+${(edge * 100).toFixed(1)}%` : `${(edge * 100).toFixed(1)}%`;
      const marker = Math.abs(edge) >= MIN_EDGE ? '🎯' : '  ';
      console.log(`   ${marker} ${bucket.key}${forecast.unit}: forecast=${(forecastProb * 100).toFixed(1)}% market=${(marketPrice * 100).toFixed(1)}% edge=${edgeStr}`);
      
      const analysis = {
        city, date, bucket: bucket.key, unit: forecast.unit,
        forecastHigh: forecast.highTemp,
        forecastProb: Math.round(forecastProb * 1000) / 1000,
        marketPrice, edge: Math.round(edge * 1000) / 1000,
        hoursUntil: Math.round(hoursUntil),
        yesToken: bucket.yesToken,
        noToken: bucket.noToken,
        marketId: bucket.marketId,
        question: bucket.question,
      };
      allAnalysis.push(analysis);
      
      // Buy YES if forecast prob >> market price (underpriced YES)
      if (edge >= MIN_EDGE && marketPrice < 0.85) {
        opportunities.push({
          ...analysis,
          action: 'BUY_YES',
          reason: `Forecast ${(forecastProb * 100).toFixed(0)}% vs market ${(marketPrice * 100).toFixed(0)}% = ${(edge * 100).toFixed(0)}% edge`,
        });
      }
      
      // Buy NO if market overprices YES (forecast prob << market price)
      if (edge <= -MIN_EDGE && marketPrice > 0.15) {
        opportunities.push({
          ...analysis,
          action: 'BUY_NO',
          edge: -edge, // flip to positive for NO side
          reason: `YES overpriced: forecast ${(forecastProb * 100).toFixed(0)}% vs market ${(marketPrice * 100).toFixed(0)}% = ${(-edge * 100).toFixed(0)}% NO edge`,
        });
      }
    }
    
    console.log('');
    await sleep(300); // Rate limit Open-Meteo
  }
  
  // 8. Summary
  console.log('═══════════════════════════════════════════');
  console.log(`📋 SUMMARY: ${opportunities.length} opportunities with ≥${(MIN_EDGE * 100).toFixed(0)}% edge`);
  for (const opp of opportunities) {
    console.log(`   ${opp.action} ${opp.city} ${opp.bucket}${opp.unit} on ${opp.date} — ${opp.reason}`);
  }
  
  // 9. Save paper trade log
  const paperLog = loadPaperLog();
  const entry = {
    timestamp: new Date().toISOString(),
    marketsScanned: weatherEvents.length,
    forecastsChecked: allAnalysis.length,
    opportunities: opportunities.length,
    analysis: allAnalysis,
    recommendations: opportunities,
  };
  paperLog.runs.push(entry);
  
  // Track paper trades (what we WOULD buy)
  for (const opp of opportunities) {
    paperLog.paperTrades.push({
      timestamp: new Date().toISOString(),
      city: opp.city,
      date: opp.date,
      bucket: opp.bucket,
      unit: opp.unit,
      action: opp.action,
      forecastProb: opp.forecastProb,
      marketPrice: opp.marketPrice,
      edge: opp.edge,
      forecastHigh: opp.forecastHigh,
      hoursUntil: opp.hoursUntil,
      yesToken: opp.yesToken,
      noToken: opp.noToken,
      resolution: null, // to be filled on resolution
    });
  }
  
  fs.writeFileSync(PAPER_FILE, JSON.stringify(paperLog, null, 2));
  console.log(`\n💾 Paper log saved to ${PAPER_FILE}`);
  
  return opportunities;
}

function loadPaperLog() {
  try {
    return JSON.parse(fs.readFileSync(PAPER_FILE, 'utf8'));
  } catch {
    return { runs: [], paperTrades: [] };
  }
}

// ═══════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════

if (require.main === module) {
  scanWeatherMarkets()
    .then(opps => {
      if (opps.length === 0) {
        console.log('\n✅ No actionable opportunities found.');
      } else {
        console.log(`\n🎯 ${opps.length} opportunities ready for thesis evaluation.`);
        console.log('   (Paper trade only — no orders placed)');
      }
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { scanWeatherMarkets, fetchForecast, computeBucketProbabilities, CITIES };
