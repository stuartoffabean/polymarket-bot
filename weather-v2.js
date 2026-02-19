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

// Known city configs (cached, used as fallback if geocoding fails)
const KNOWN_CITIES = {
  'New York City': { lat: 40.7128, lon: -74.0060, unit: 'fahrenheit', country: 'US', aliases: ['NYC', 'New York'] },
  'Miami':         { lat: 25.7617, lon: -80.1918, unit: 'fahrenheit', country: 'US', aliases: [] },
  'Chicago':       { lat: 41.8781, lon: -87.6298, unit: 'fahrenheit', country: 'US', aliases: [] },
  'Atlanta':       { lat: 33.7490, lon: -84.3880, unit: 'fahrenheit', country: 'US', aliases: [] },
  'Dallas':        { lat: 32.7767, lon: -96.7970, unit: 'fahrenheit', country: 'US', aliases: [] },
  'Seattle':       { lat: 47.6062, lon: -122.3321, unit: 'fahrenheit', country: 'US', aliases: [] },
  'Toronto':       { lat: 43.6532, lon: -79.3832, unit: 'celsius', country: 'CA', aliases: [] },
  'London':        { lat: 51.5074, lon: -0.1278, unit: 'celsius', country: 'GB', aliases: [] },
  'Seoul':         { lat: 37.5665, lon: 126.9780, unit: 'celsius', country: 'KR', aliases: [] },
  'Buenos Aires':  { lat: -34.6037, lon: -58.3816, unit: 'celsius', country: 'AR', aliases: [] },
  'Ankara':        { lat: 39.9334, lon: 32.8597, unit: 'celsius', country: 'TR', aliases: [] },
  'Wellington':    { lat: -41.2865, lon: 174.7762, unit: 'celsius', country: 'NZ', aliases: [] },
  'São Paulo':     { lat: -23.5505, lon: -46.6333, unit: 'celsius', country: 'BR', aliases: ['Sao Paulo'] },
};

// Dynamic city config cache (populated at runtime via geocoding)
const CITIES = { ...KNOWN_CITIES };

// US country code for NOAA eligibility
const US_COUNTRY = 'US';
const US_CITIES = new Set(Object.entries(KNOWN_CITIES).filter(([_, c]) => c.country === US_COUNTRY).map(([name]) => name));

const GEOCODE_API = 'https://geocoding-api.open-meteo.com/v1/search';

/**
 * Dynamically resolve a city name to coordinates + unit.
 * Uses cached KNOWN_CITIES first, falls back to Open-Meteo geocoding API.
 */
async function resolveCityConfig(cityName) {
  // Check known cities (exact + alias match)
  if (CITIES[cityName]) return CITIES[cityName];
  for (const [name, config] of Object.entries(CITIES)) {
    if (config.aliases && config.aliases.some(a => a.toLowerCase() === cityName.toLowerCase())) {
      CITIES[cityName] = config; // cache alias
      return config;
    }
  }
  
  // Geocode via Open-Meteo
  try {
    const data = await httpGet(`${GEOCODE_API}?name=${encodeURIComponent(cityName)}&count=1&language=en`);
    if (data.results && data.results.length > 0) {
      const r = data.results[0];
      const isUS = r.country_code === 'US';
      const config = {
        lat: r.latitude,
        lon: r.longitude,
        unit: isUS ? 'fahrenheit' : 'celsius',
        country: r.country_code,
        aliases: [],
        geocoded: true, // flag that this was dynamically resolved
      };
      CITIES[cityName] = config;
      if (isUS) US_CITIES.add(cityName);
      console.log(`   🌐 Geocoded "${cityName}" → ${r.latitude.toFixed(2)}, ${r.longitude.toFixed(2)} (${r.country_code}) ${isUS ? '[NOAA eligible]' : ''}`);
      return config;
    }
  } catch (e) {
    console.log(`   ⚠️  Geocoding failed for "${cityName}": ${e.message}`);
  }
  
  return null;
}

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
async function fetchForecast(cityName, cityConfig, targetDate, model = null) {
  const unit = cityConfig.unit;
  let url = `${OPEN_METEO_API}?latitude=${cityConfig.lat}&longitude=${cityConfig.lon}&hourly=temperature_2m&temperature_unit=${unit}&forecast_days=3&timezone=auto`;
  if (model) url += `&models=${model}`;
  
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
    source: model || 'best_match',
  };
}

// ═══════════════════════════════════════════════════════════════
// NOAA FORECAST (US cities only)
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch NOAA forecast for a US city.
 * Chain: /points/{lat},{lon} → gridpoint forecast URL → hourly forecast
 * Returns same format as fetchForecast() or null if unavailable.
 */
async function fetchNOAAForecast(cityName, cityConfig, targetDate) {
  if (!US_CITIES.has(cityName)) return null;
  
  try {
    // Step 1: Get grid point
    const pointUrl = `https://api.weather.gov/points/${cityConfig.lat.toFixed(4)},${cityConfig.lon.toFixed(4)}`;
    const pointData = await httpGet(pointUrl);
    
    if (!pointData.properties || !pointData.properties.forecastHourly) {
      console.log(`   ⚠️  NOAA: No grid data for ${cityName}`);
      return null;
    }
    
    await sleep(200); // NOAA rate limit courtesy
    
    // Step 2: Get hourly forecast
    const hourlyUrl = pointData.properties.forecastHourly;
    const hourlyData = await httpGet(hourlyUrl);
    
    if (!hourlyData.properties || !hourlyData.properties.periods) {
      console.log(`   ⚠️  NOAA: No hourly periods for ${cityName}`);
      return null;
    }
    
    // Step 3: Filter to target date and find high temp
    const periods = hourlyData.properties.periods;
    const dayTemps = [];
    
    for (const period of periods) {
      const periodDate = period.startTime.slice(0, 10); // YYYY-MM-DD
      if (periodDate === targetDate) {
        // NOAA returns Fahrenheit by default for US
        let temp = period.temperature;
        if (period.temperatureUnit === 'C' && cityConfig.unit === 'fahrenheit') {
          temp = temp * 9/5 + 32;
        } else if (period.temperatureUnit === 'F' && cityConfig.unit === 'celsius') {
          temp = (temp - 32) * 5/9;
        }
        dayTemps.push(temp);
      }
    }
    
    if (dayTemps.length === 0) return null;
    
    const highTemp = Math.max(...dayTemps);
    const unit = cityConfig.unit === 'fahrenheit' ? '°F' : '°C';
    
    console.log(`   📡 NOAA forecast: ${highTemp.toFixed(1)}${unit} (${dayTemps.length} hourly readings)`);
    
    return {
      city: cityName,
      date: targetDate,
      hourlyTemps: dayTemps,
      highTemp,
      unit,
      source: 'NOAA',
    };
  } catch (err) {
    console.log(`   ⚠️  NOAA fetch failed for ${cityName}: ${err.message}`);
    return null;
  }
}

/**
 * Get best forecast for a city — uses both NOAA + Open-Meteo for US cities,
 * averages them for higher confidence. Falls back to Open-Meteo only for intl.
 */
async function getBestForecast(cityName, cityConfig, targetDate) {
  if (US_CITIES.has(cityName)) {
    // US cities: NOAA API + Open-Meteo default (original approach)
    const openMeteo = await fetchForecast(cityName, cityConfig, targetDate);
    await sleep(300);
    const noaa = await fetchNOAAForecast(cityName, cityConfig, targetDate);
    
    if (!openMeteo && !noaa) return null;
    if (!noaa) { openMeteo.source = 'Open-Meteo'; return openMeteo; }
    if (!openMeteo) return noaa;
    
    const avgHigh = (openMeteo.highTemp + noaa.highTemp) / 2;
    const spread = Math.abs(openMeteo.highTemp - noaa.highTemp);
    
    console.log(`   🔀 Ensemble: Open-Meteo=${openMeteo.highTemp.toFixed(1)} NOAA=${noaa.highTemp.toFixed(1)} → avg=${avgHigh.toFixed(1)} spread=${spread.toFixed(1)}`);
    
    return {
      city: cityName, date: targetDate,
      hourlyTemps: openMeteo.hourlyTemps,
      highTemp: avgHigh,
      unit: openMeteo.unit,
      source: 'Ensemble(NOAA+Open-Meteo)',
      source1: 'Open-Meteo', source1High: openMeteo.highTemp,
      source2: 'NOAA', source2High: noaa.highTemp,
      spread,
    };
  }
  
  // International cities: GFS (NOAA model) + ECMWF via Open-Meteo (both free, global)
  const gfs = await fetchForecast(cityName, cityConfig, targetDate, 'gfs_seamless');
  await sleep(200);
  const ecmwf = await fetchForecast(cityName, cityConfig, targetDate, 'ecmwf_ifs025');
  
  if (!gfs && !ecmwf) return null;
  if (!ecmwf) { gfs.source = 'GFS'; return gfs; }
  if (!gfs) { ecmwf.source = 'ECMWF'; return ecmwf; }
  
  const avgHigh = (gfs.highTemp + ecmwf.highTemp) / 2;
  const spread = Math.abs(gfs.highTemp - ecmwf.highTemp);
  
  console.log(`   🔀 Ensemble: GFS=${gfs.highTemp.toFixed(1)} ECMWF=${ecmwf.highTemp.toFixed(1)} → avg=${avgHigh.toFixed(1)} spread=${spread.toFixed(1)}`);
  
  return {
    city: cityName, date: targetDate,
    hourlyTemps: gfs.hourlyTemps,
    highTemp: avgHigh,
    unit: gfs.unit,
    source: 'Ensemble(GFS+ECMWF)',
    source1: 'GFS', source1High: gfs.highTemp,
    source2: 'ECMWF', source2High: ecmwf.highTemp,
    spread,
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
    
    const cityConfig = await resolveCityConfig(city);
    if (!cityConfig) {
      console.log(`⚠️  Skipping "${city}" — could not resolve coordinates`);
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
    
    // 4. Fetch forecast (ensemble: NOAA + Open-Meteo for US, Open-Meteo only for intl)
    let forecast;
    try {
      console.log(`🏙️  ${city} — ${date} (resolves in ${hoursUntil.toFixed(0)}h)`);
      forecast = await getBestForecast(city, cityConfig, date);
      if (!forecast) {
        console.log(`   ⚠️  No forecast data for ${city} on ${date}`);
        continue;
      }
    } catch (err) {
      console.log(`   ❌ Forecast fetch failed for ${city}: ${err.message}`);
      continue;
    }
    
    console.log(`   Forecast high: ${forecast.highTemp.toFixed(1)}${forecast.unit} [${forecast.source}]`);
    
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
      
      bucket.yesPrice = parseFloat(prices[0] || '0');  // Gamma mid/last — used as fallback only
      bucket.noPrice = parseFloat(prices[1] || '0');
      bucket.yesToken = tokens[0] || '';
      bucket.noToken = tokens[1] || '';
      bucket.marketId = market.id;
      bucket.question = market.question;

      // Fetch ACTUAL executable prices from orderbook (YES book + NO book)
      try {
        if (!bucket.yesToken) throw new Error('no token');
        // YES orderbook
        const yesBookUrl = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(bucket.yesToken)}`;
        const yesBook = await httpGet(yesBookUrl, 5000);
        const yesAsks = (yesBook.asks || []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        const yesBids = (yesBook.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
        if (yesAsks.length > 0) {
          bucket.yesAsk = parseFloat(yesAsks[0].price);
          bucket.yesAskDepth = parseFloat(yesAsks[0].size);
        }
        if (yesBids.length > 0) {
          bucket.yesBid = parseFloat(yesBids[0].price);
        }
        await sleep(100); // rate limit CLOB
        // NO orderbook (separate token, separate book)
        if (bucket.noToken) {
          const noBookUrl = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(bucket.noToken)}`;
          const noBook = await httpGet(noBookUrl, 5000);
          const noAsks = (noBook.asks || []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
          const noBids = (noBook.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
          if (noAsks.length > 0) {
            bucket.noAsk = parseFloat(noAsks[0].price);
            bucket.noAskDepth = parseFloat(noAsks[0].size);
          }
          if (noBids.length > 0) {
            bucket.noBid = parseFloat(noBids[0].price);
          }
          await sleep(100); // rate limit CLOB
        }
      } catch (e) {
        console.log(`   ⚠️  Orderbook fetch failed for ${bucket.key}: ${e.message}`);
      }
      buckets.push(bucket);
    }
    
    // 6. Compute forecast probabilities
    const probs = computeBucketProbabilities(
      forecast.highTemp, buckets, forecast.unit, hoursUntil
    );
    
    // 7. Compare forecast vs EXECUTABLE market prices → find edges
    console.log(`   Buckets:`);
    for (const bucket of buckets) {
      const forecastProb = probs[bucket.key] || 0;
      
      // Use executable ask price (what we'd actually pay), fallback to Gamma mid
      const yesExecPrice = bucket.yesAsk || bucket.yesPrice;
      const noExecPrice = bucket.noAsk || (1 - (bucket.yesBid || bucket.yesPrice));
      const gammaMid = bucket.yesPrice;
      
      // Edge for BUY_YES: forecast - ask price (what we'd pay)
      const yesEdge = forecastProb - yesExecPrice;
      // Edge for BUY_NO: (1 - forecast) - noAsk
      const noEdge = (1 - forecastProb) - noExecPrice;
      
      const bestEdge = Math.max(yesEdge, noEdge);
      const edgeStr = yesEdge >= 0 ? `+${(yesEdge * 100).toFixed(1)}%` : `${(yesEdge * 100).toFixed(1)}%`;
      const marker = Math.abs(bestEdge) >= MIN_EDGE ? '🎯' : '  ';
      const bookTag = bucket.yesAsk ? `ask=${(yesExecPrice * 100).toFixed(1)}¢` : 'no-book';
      console.log(`   ${marker} ${bucket.key}${forecast.unit}: forecast=${(forecastProb * 100).toFixed(1)}% mid=${(gammaMid * 100).toFixed(1)}% ${bookTag} edge=${edgeStr}`);
      
      const analysis = {
        city, date, bucket: bucket.key, unit: forecast.unit,
        forecastHigh: forecast.highTemp,
        forecastProb: Math.round(forecastProb * 1000) / 1000,
        marketPrice: gammaMid,
        execPrice: yesExecPrice,
        execPriceNo: noExecPrice,
        yesAsk: bucket.yesAsk || null,
        yesBid: bucket.yesBid || null,
        yesAskDepth: bucket.yesAskDepth || null,
        noAsk: bucket.noAsk || null,
        noBid: bucket.noBid || null,
        noAskDepth: bucket.noAskDepth || null,
        edge: Math.round(yesEdge * 1000) / 1000,
        execEdge: Math.round(yesEdge * 1000) / 1000, // edge vs executable price
        hoursUntil: Math.round(hoursUntil),
        yesToken: bucket.yesToken,
        noToken: bucket.noToken,
        marketId: bucket.marketId,
        question: bucket.question,
      };
      allAnalysis.push(analysis);
      
      // Buy YES if forecast prob >> executable ask (real edge after slippage)
      if (yesEdge >= MIN_EDGE && yesExecPrice < 0.85) {
        opportunities.push({
          ...analysis,
          action: 'BUY_YES',
          edge: Math.round(yesEdge * 1000) / 1000,
          reason: `Forecast ${(forecastProb * 100).toFixed(0)}% vs ask ${(yesExecPrice * 100).toFixed(0)}¢ = ${(yesEdge * 100).toFixed(0)}% edge (mid was ${(gammaMid * 100).toFixed(0)}¢)`,
        });
      }
      
      // Buy NO if YES overpriced vs executable NO price
      if (noEdge >= MIN_EDGE && noExecPrice < 0.85) {
        opportunities.push({
          ...analysis,
          action: 'BUY_NO',
          edge: Math.round(noEdge * 1000) / 1000,
          reason: `NO forecast ${((1 - forecastProb) * 100).toFixed(0)}% vs NO ask ${(noExecPrice * 100).toFixed(0)}¢ = ${(noEdge * 100).toFixed(0)}% edge (mid was ${((1 - gammaMid) * 100).toFixed(0)}¢)`,
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
  
  // Track paper trades (what we WOULD buy) — realistic paper trading
  const PAPER_TRADE_SIZE = parseFloat(process.env.PAPER_TRADE_SIZE || '10'); // $10 per trade
  for (const opp of opportunities) {
    // Determine actual entry price based on action
    let entryPrice;
    if (opp.action === 'BUY_YES') {
      entryPrice = opp.yesAsk || opp.execPrice || opp.marketPrice;
    } else { // BUY_NO
      entryPrice = opp.noAsk || opp.execPriceNo || (1 - opp.marketPrice);
    }
    // Calculate shares — cap by available depth (can't buy more than what's on the book)
    const availableDepth = opp.action === 'BUY_YES' ? (opp.yesAskDepth || Infinity) : (opp.noAskDepth || Infinity);
    const maxSharesByDepth = Math.floor(availableDepth);
    const maxSharesByBudget = entryPrice > 0 ? Math.floor(PAPER_TRADE_SIZE / entryPrice) : 0;
    const shares = Math.min(maxSharesByBudget, maxSharesByDepth);
    const totalCost = shares * entryPrice;
    const depthLimited = maxSharesByDepth < maxSharesByBudget;
    
    // Skip if shares = 0 (can't fill) or entry < 1¢ (dust, no real liquidity)
    if (shares <= 0 || entryPrice < 0.01 || totalCost < 0.50) {
      console.log(`   ⏭️ Skipping paper trade: ${opp.city} ${opp.bucket} — ${shares <= 0 ? 'no depth' : entryPrice < 0.01 ? 'dust price' : 'cost too low'}`);
      continue;
    }

    paperLog.paperTrades.push({
      timestamp: new Date().toISOString(),
      city: opp.city,
      date: opp.date,
      bucket: opp.bucket,
      unit: opp.unit,
      action: opp.action,
      forecastProb: opp.forecastProb,
      gammaMid: opp.marketPrice,          // Gamma mid (reference only, NOT entry price)
      entryPrice: Math.round(entryPrice * 10000) / 10000,  // Actual entry price (ask from orderbook)
      entrySource: opp.yesAsk || opp.noAsk ? 'orderbook' : 'gamma-mid-fallback',
      depthLimited: depthLimited,
      availableDepth: availableDepth === Infinity ? null : availableDepth,
      spread: opp.yesAsk && opp.yesBid ? Math.round((opp.yesAsk - opp.yesBid) * 10000) / 10000 : null,
      shares: shares,
      totalCost: Math.round(totalCost * 100) / 100,
      paperTradeSize: PAPER_TRADE_SIZE,
      yesAsk: opp.yesAsk || null,
      yesBid: opp.yesBid || null,
      noAsk: opp.noAsk || null,
      noBid: opp.noBid || null,
      yesAskDepth: opp.yesAskDepth || null,
      noAskDepth: opp.noAskDepth || null,
      edge: opp.edge,                     // Edge vs executable price
      forecastHigh: opp.forecastHigh,
      hoursUntil: opp.hoursUntil,
      yesToken: opp.yesToken,
      noToken: opp.noToken,
      resolution: null,      // WIN or LOSS
      dollarPnl: null,       // Actual dollar P&L when resolved
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
  (async () => {
    // 1. Resolve any past paper trades first
    try {
      console.log('📋 Checking for resolvable paper trades...');
      const { execSync } = require('child_process');
      const out = execSync('node resolve-weather-paper.js', { cwd: __dirname, timeout: 60000 }).toString();
      console.log(out);
    } catch (e) {
      console.log('⚠️ Resolution check failed (non-fatal):', e.message?.slice(0, 100));
    }

    // 2. Scan for new opportunities
    try {
      const opps = await scanWeatherMarkets();
      if (opps.length === 0) {
        console.log('\n✅ No actionable opportunities found.');
      } else {
        console.log(`\n🎯 ${opps.length} opportunities ready for thesis evaluation.`);
        console.log('   (Paper trade only — no orders placed)');
      }
    } catch (err) {
      console.error('❌ Fatal error:', err);
      process.exit(1);
    }
    process.exit(0);
  })();
}

module.exports = { scanWeatherMarkets, fetchForecast, fetchNOAAForecast, getBestForecast, computeBucketProbabilities, CITIES };
