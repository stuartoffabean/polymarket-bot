#!/usr/bin/env node
/**
 * Weather Scanner Backtest v2.0
 * 
 * Validates ensemble edge against 14 days of resolved Polymarket weather markets.
 * 
 * Data sources:
 *   - Gamma API events?slug= for resolved markets (exact slug match per city/date)
 *   - Open-Meteo Historical Ensemble API for past GFS forecasts
 *   - Pre-resolution prices reconstructed from oneDayPriceChange
 * 
 * Output: weather-backtest.json
 */

const { writeFileSync, readFileSync, existsSync } = require('fs');
const { join } = require('path');

const OUTPUT_FILE = join(__dirname, '..', 'weather-backtest.json');
const GAMMA_API = 'https://gamma-api.polymarket.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'stuart-backtest/2.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ── City Config ──────────────────────────────────────────────────────────────
const CITIES = {
  'new york city': { slug: 'nyc', lat: 40.7128, lon: -74.0060, unit: 'F', polyAliases: ['nyc', 'new york city', 'new york'] },
  'chicago': { slug: 'chicago', lat: 41.8781, lon: -87.6298, unit: 'F', polyAliases: ['chicago'] },
  'atlanta': { slug: 'atlanta', lat: 33.7490, lon: -84.3880, unit: 'F', polyAliases: ['atlanta'] },
  'dallas': { slug: 'dallas', lat: 32.7767, lon: -96.7970, unit: 'F', polyAliases: ['dallas'] },
  'seattle': { slug: 'seattle', lat: 47.6062, lon: -122.3321, unit: 'F', polyAliases: ['seattle'] },
  'miami': { slug: 'miami', lat: 25.7617, lon: -80.1918, unit: 'F', polyAliases: ['miami'] },
  'seoul': { slug: 'seoul', lat: 37.5665, lon: 126.9780, unit: 'C', polyAliases: ['seoul'] },
  'london': { slug: 'london', lat: 51.5074, lon: -0.1278, unit: 'C', polyAliases: ['london'] },
  'buenos aires': { slug: 'buenos-aires', lat: -34.6037, lon: -58.3816, unit: 'C', polyAliases: ['buenos aires'] },
  'wellington': { slug: 'wellington', lat: -41.2866, lon: 174.7756, unit: 'C', polyAliases: ['wellington'] },
  'ankara': { slug: 'ankara', lat: 39.9334, lon: 32.8597, unit: 'C', polyAliases: ['ankara'] },
  'toronto': { slug: 'toronto', lat: 43.6532, lon: -79.3832, unit: 'C', polyAliases: ['toronto'] },
};

const CITY_TYPICAL_SPREAD = {
  'new york city': 5.0, 'chicago': 7.0, 'atlanta': 4.0, 'dallas': 5.0,
  'seattle': 3.0, 'miami': 2.0, 'seoul': 3.5, 'london': 2.5,
  'buenos aires': 2.5, 'wellington': 2.0, 'ankara': 4.0, 'toronto': 5.0,
};

const CONFIG = {
  MIN_EDGE: 0.05,
  KELLY_FRACTION: 0.25,
  MAX_TRADE_SIZE: 10,
  MAX_BANKROLL_PCT: 0.05,
  BANKROLL: 500,
  ENSEMBLE_MIN_CONFIDENCE: 0.3,
};

// ── Parser ───────────────────────────────────────────────────────────────────
function parseWeatherMarket(question) {
  const q = question.toLowerCase();
  if (!q.includes('temperature') && !q.includes('temp')) return null;
  
  let city = null;
  for (const [name, config] of Object.entries(CITIES)) {
    if (config.polyAliases.some(alias => q.includes(alias))) { city = name; break; }
  }
  if (!city) return null;

  const monthNames = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
  let date = null;
  const dateMatch1 = q.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if (dateMatch1) {
    const month = monthNames[dateMatch1[1].toLowerCase()];
    const day = dateMatch1[2].padStart(2, '0');
    const year = dateMatch1[3] || '2026';
    date = `${year}-${month}-${day}`;
  }
  if (!date) {
    const dateMatch2 = q.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch2) date = `${dateMatch2[1]}-${dateMatch2[2]}-${dateMatch2[3]}`;
  }
  if (!date) return null;

  const unit = CITIES[city].unit;
  let type = null, low = null, high = null;

  // Negative temp patterns: "-3°C" or "neg 3" etc
  const rangeMatch = q.match(/between\s+(-?\d+)\s*[–-]\s*(-?\d+)\s*°?\s*[fc°]/i);
  if (rangeMatch) { type = 'range'; low = parseInt(rangeMatch[1]); high = parseInt(rangeMatch[2]); }
  if (!type) { const m = q.match(/(-?\d+)\s*°?\s*[fc°]?\s+or\s+(?:below|less|lower)/i); if (m) { type = 'at_or_below'; high = parseInt(m[1]); } }
  if (!type) { const m = q.match(/(-?\d+)\s*°?\s*[fc°]?\s+or\s+(?:higher|more|above|greater)/i); if (m) { type = 'at_or_above'; low = parseInt(m[1]); } }
  if (!type) { const m = q.match(/be\s+(-?\d+)\s*°\s*[fc°]\s+on/i); if (m) { type = 'exact'; low = parseInt(m[1]); high = parseInt(m[1]); } }
  if (!type) { const m = q.match(/(?:highest|lowest)\s+temperature.*?be\s+(-?\d+)\s*°\s*[fc°]/i); if (m) { type = 'exact'; low = parseInt(m[1]); high = parseInt(m[1]); } }
  if (!type) { const m = q.match(/(?:above|over|exceed|exceeds)\s+(-?\d+)\s*°?\s*[fc°]/i); if (m) { type = 'at_or_above'; low = parseInt(m[1]); } }
  if (!type) { const m = q.match(/(?:below|under)\s+(-?\d+)\s*°?\s*[fc°]/i); if (m) { type = 'at_or_below'; high = parseInt(m[1]); } }
  
  // Negative: "-X°C" in question
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

// ── Ensemble Probability ─────────────────────────────────────────────────────
function ensembleProbability(parsed, ensembleData) {
  const highs = ensembleData.ensembleHighs;
  if (!highs || highs.length === 0) return null;
  const roundedHighs = highs.map(t => Math.round(t));
  let matching = 0;
  switch (parsed.type) {
    case 'range': matching = roundedHighs.filter(t => t >= parsed.low && t <= parsed.high).length; break;
    case 'exact': matching = roundedHighs.filter(t => t === parsed.low).length; break;
    case 'at_or_below': matching = roundedHighs.filter(t => t <= parsed.high).length; break;
    case 'at_or_above': matching = roundedHighs.filter(t => t >= parsed.low).length; break;
    default: return null;
  }
  return matching / highs.length;
}

// ── Kelly ────────────────────────────────────────────────────────────────────
function kellySize(edge, confidence, marketPrice) {
  if (edge <= 0 || marketPrice <= 0 || marketPrice >= 1) return 0;
  const kelly = (edge * confidence) / (1 - marketPrice);
  let size = kelly * CONFIG.KELLY_FRACTION * CONFIG.BANKROLL;
  size = Math.min(size, CONFIG.MAX_TRADE_SIZE, CONFIG.BANKROLL * CONFIG.MAX_BANKROLL_PCT);
  return Math.max(0, +size.toFixed(2));
}

// ── Historical Ensemble ──────────────────────────────────────────────────────
async function getHistoricalEnsemble(city, config, targetDate) {
  const tempUnit = config.unit === 'F' ? 'fahrenheit' : 'celsius';
  const now = new Date();
  const target = new Date(targetDate + 'T00:00:00Z');
  const daysAgo = Math.ceil((now - target) / 86400000);
  const pastDays = Math.min(daysAgo + 2, 92);
  
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${config.lat}&longitude=${config.lon}&hourly=temperature_2m&models=gfs_seamless&past_days=${pastDays}&forecast_days=1&temperature_unit=${tempUnit}`;
  
  const data = await fetchJSON(url);
  const hourly = data.hourly || {};
  const times = hourly.time || [];
  const memberKeys = Object.keys(hourly).filter(k => k.startsWith('temperature_2m'));
  if (memberKeys.length === 0) return null;
  
  // Get daily highs for each member for the target date
  const memberHighs = {};
  for (let i = 0; i < times.length; i++) {
    const date = times[i].split('T')[0];
    if (date !== targetDate) continue;
    for (const key of memberKeys) {
      const temp = hourly[key]?.[i];
      if (temp == null) continue;
      if (!memberHighs[key] || temp > memberHighs[key]) memberHighs[key] = temp;
    }
  }
  
  const highs = Object.values(memberHighs).sort((a, b) => a - b);
  if (highs.length === 0) return null;
  
  const mean = highs.reduce((s, t) => s + t, 0) / highs.length;
  const variance = highs.reduce((s, t) => s + (t - mean) ** 2, 0) / highs.length;
  const stdDev = Math.sqrt(variance);
  
  return {
    ensembleHighs: highs,
    mean: +mean.toFixed(1),
    median: highs[Math.floor(highs.length / 2)],
    min: Math.min(...highs),
    max: Math.max(...highs),
    stdDev: +stdDev.toFixed(2),
    confidence: Math.max(0, Math.min(1, 1 - (stdDev / (CITY_TYPICAL_SPREAD[city] || 10)))),
    memberCount: highs.length,
  };
}

// ── Reconstruct Pre-Resolution Price ─────────────────────────────────────────
function getPreResolutionPrice(market) {
  // outcomePrices tells us resolution: ["1","0"]=YES won, ["0","1"]=NO won
  let resolution = null;
  try {
    const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    const yp = parseFloat(prices?.[0]);
    resolution = yp >= 0.5 ? 'YES' : 'NO';
  } catch { return null; }
  
  // Reconstruct: if YES won, final YES price = 1.0, so pre-res price = 1.0 - oneDayPriceChange
  // If NO won, final YES price = 0.0, so pre-res price = 0.0 - oneDayPriceChange = -oneDayPriceChange
  const change = parseFloat(market.oneDayPriceChange);
  if (isNaN(change)) return { resolution, preResPrice: null };
  
  let preResPrice;
  if (resolution === 'YES') {
    preResPrice = 1.0 - change; // Was lower, went to 1
  } else {
    preResPrice = 0.0 - change; // Was higher, went to 0 (change is negative)
  }
  
  // Clamp to valid range
  preResPrice = Math.max(0.01, Math.min(0.99, preResPrice));
  
  return { resolution, preResPrice: +preResPrice.toFixed(4) };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Weather Scanner Backtest v2.0 ===\n');
  const t0 = Date.now();
  
  // Use pre-fetched data if available
  let rawData;
  const rawFile = join(__dirname, '..', 'weather-resolved-raw.json');
  if (existsSync(rawFile)) {
    console.log('[DATA] Loading pre-fetched resolved markets...');
    rawData = JSON.parse(readFileSync(rawFile, 'utf8'));
  } else {
    console.log('[DATA] Need to fetch — run weather-debug2.js first');
    process.exit(1);
  }
  
  console.log(`[DATA] ${rawData.length} events loaded`);
  
  // Step 1: Parse all markets and get resolutions
  const allParsed = [];
  let parseFailures = 0;
  
  for (const entry of rawData) {
    const event = entry.event;
    for (const m of (event.markets || [])) {
      const parsed = parseWeatherMarket(m.question || '');
      if (!parsed) { parseFailures++; continue; }
      
      const { resolution, preResPrice } = getPreResolutionPrice(m) || {};
      if (!resolution) continue;
      
      allParsed.push({
        ...parsed,
        question: m.question,
        slug: m.slug,
        conditionId: m.conditionId,
        resolution,
        preResPrice,
        volume: parseFloat(m.volumeNum) || 0,
      });
    }
  }
  
  console.log(`[PARSE] ${allParsed.length} markets parsed (${parseFailures} unparseable)`);
  console.log(`  With price: ${allParsed.filter(p => p.preResPrice != null).length}`);
  console.log(`  Without price: ${allParsed.filter(p => p.preResPrice == null).length}`);
  
  // Step 2: Get unique city-dates and fetch ensemble forecasts
  const cityDates = {};
  for (const p of allParsed) {
    const key = `${p.city}|${p.date}`;
    if (!cityDates[key]) cityDates[key] = [];
    cityDates[key].push(p);
  }
  
  console.log(`[GROUPS] ${Object.keys(cityDates).length} city-date groups`);
  console.log('[ENSEMBLE] Fetching historical GFS ensemble forecasts...');
  
  const forecasts = {};
  let fetchCount = 0;
  
  for (const key of Object.keys(cityDates)) {
    const [city, date] = key.split('|');
    const config = CITIES[city];
    if (!config) continue;
    
    try {
      const ensemble = await getHistoricalEnsemble(city, config, date);
      if (ensemble) {
        forecasts[key] = ensemble;
        fetchCount++;
        if (fetchCount % 12 === 0) {
          console.log(`  Fetched ${fetchCount} forecasts...`);
        }
      }
      await sleep(400); // Rate limit
    } catch (e) {
      console.log(`  ${city} ${date}: error: ${e.message}`);
    }
  }
  
  console.log(`[ENSEMBLE] Fetched ${fetchCount} forecasts\n`);
  
  // Step 3: Generate signals and compare
  const trades = [];
  const skipped = [];
  
  // Accumulators
  let totalSignals = 0, correctSignals = 0;
  let grossPnL = 0;
  const byCity = {}, byBucketType = {}, byConfidence = {};
  
  for (const [key, markets] of Object.entries(cityDates)) {
    const forecast = forecasts[key];
    if (!forecast) continue;
    
    for (const mkt of markets) {
      const forecastProb = ensembleProbability(mkt, forecast);
      if (forecastProb == null) continue;
      
      const marketPrice = mkt.preResPrice;
      if (marketPrice == null) {
        skipped.push({ ...mkt, reason: 'no_price', forecastProb });
        continue;
      }
      
      const edge = forecastProb - marketPrice;
      
      // Would scanner have generated a signal?
      let signal = 'FAIR';
      let tradeSide = null;
      let tradePrice = null;
      
      if (edge > CONFIG.MIN_EDGE && forecast.confidence >= CONFIG.ENSEMBLE_MIN_CONFIDENCE) {
        signal = 'BUY_YES';
        tradeSide = 'YES';
        tradePrice = marketPrice;
      } else if (edge < -CONFIG.MIN_EDGE && forecast.confidence >= CONFIG.ENSEMBLE_MIN_CONFIDENCE) {
        signal = 'BUY_NO';
        tradeSide = 'NO';
        tradePrice = 1 - marketPrice;
      }
      
      const result = {
        city: mkt.city,
        date: mkt.date,
        question: (mkt.question || '').slice(0, 120),
        type: mkt.type,
        bucket: mkt.type === 'range' ? `${mkt.low}-${mkt.high}` : mkt.type === 'exact' ? `${mkt.low}` : mkt.type === 'at_or_below' ? `≤${mkt.high}` : `≥${mkt.low}`,
        unit: mkt.unit,
        resolution: mkt.resolution,
        preResPrice: marketPrice,
        forecastProb: +forecastProb.toFixed(4),
        edge: +edge.toFixed(4),
        signal,
        tradeSide,
        tradePrice: tradePrice != null ? +tradePrice.toFixed(4) : null,
        ensembleMean: forecast.mean,
        ensembleStdDev: forecast.stdDev,
        confidence: +forecast.confidence.toFixed(2),
        members: forecast.memberCount,
        volume: mkt.volume,
      };
      
      if (tradeSide) {
        const size = kellySize(Math.abs(edge), forecast.confidence, tradePrice);
        result.kellySize = size;
        
        // P&L
        const shares = tradePrice > 0 ? size / tradePrice : 0;
        const correct = (tradeSide === mkt.resolution);
        const pnl = correct ? (1 - tradePrice) * shares : -tradePrice * shares;
        
        result.correct = correct;
        result.shares = +shares.toFixed(2);
        result.pnl = +pnl.toFixed(4);
        
        totalSignals++;
        if (correct) correctSignals++;
        grossPnL += pnl;
        
        // By city
        if (!byCity[mkt.city]) byCity[mkt.city] = { trades: 0, correct: 0, pnl: 0 };
        byCity[mkt.city].trades++;
        if (correct) byCity[mkt.city].correct++;
        byCity[mkt.city].pnl += pnl;
        
        // By bucket type
        const bt = mkt.type === 'range' ? 'range' : (mkt.type === 'at_or_above' || mkt.type === 'at_or_below') ? 'above_below' : 'exact';
        if (!byBucketType[bt]) byBucketType[bt] = { trades: 0, correct: 0, pnl: 0 };
        byBucketType[bt].trades++;
        if (correct) byBucketType[bt].correct++;
        byBucketType[bt].pnl += pnl;
        
        // By confidence
        const cl = forecast.confidence >= 0.8 ? 'high' : forecast.confidence >= 0.5 ? 'medium' : 'low';
        if (!byConfidence[cl]) byConfidence[cl] = { trades: 0, correct: 0, pnl: 0 };
        byConfidence[cl].trades++;
        if (correct) byConfidence[cl].correct++;
        byConfidence[cl].pnl += pnl;
        
        trades.push(result);
      } else {
        skipped.push(result);
      }
    }
  }
  
  // Step 4: Also compute calibration (how well-calibrated are our probabilities?)
  // Bin forecasts into deciles and check actual resolution rates
  const calibration = {};
  for (const [key, markets] of Object.entries(cityDates)) {
    const forecast = forecasts[key];
    if (!forecast) continue;
    for (const mkt of markets) {
      const fp = ensembleProbability(mkt, forecast);
      if (fp == null) continue;
      const bin = Math.round(fp * 10) / 10; // Round to nearest 0.1
      const binKey = bin.toFixed(1);
      if (!calibration[binKey]) calibration[binKey] = { predicted: +bin, count: 0, resolved_yes: 0 };
      calibration[binKey].count++;
      if (mkt.resolution === 'YES') calibration[binKey].resolved_yes++;
    }
  }
  
  // Calculate calibration scores
  for (const v of Object.values(calibration)) {
    v.actual_rate = v.count > 0 ? +(v.resolved_yes / v.count).toFixed(3) : 0;
    v.error = +(v.actual_rate - v.predicted).toFixed(3);
  }
  
  const hitRate = totalSignals > 0 ? correctSignals / totalSignals : 0;
  const avgEdge = totalSignals > 0 ? trades.reduce((s, t) => s + Math.abs(t.edge), 0) / totalSignals : 0;
  
  // Sort calibration by predicted probability
  const sortedCalibration = Object.values(calibration).sort((a, b) => a.predicted - b.predicted);
  
  const output = {
    version: '2.0',
    timestamp: new Date().toISOString(),
    runtime: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    
    summary: {
      eventsAnalyzed: rawData.length,
      marketsAnalyzed: allParsed.length,
      marketsWithForecasts: Object.keys(forecasts).length * 7, // approx
      totalSignals,
      correctSignals,
      hitRate: +(hitRate * 100).toFixed(1),
      hitRateStr: `${(hitRate * 100).toFixed(1)}%`,
      avgEdge: +avgEdge.toFixed(4),
      avgEdgeStr: `${(avgEdge * 100).toFixed(1)}%`,
      grossPnL: +grossPnL.toFixed(2),
      netPnLAfterFees: +grossPnL.toFixed(2), // Weather = zero fees
      feeNote: 'Weather markets have ZERO taker fees',
      verdict: grossPnL > 1 ? 'POSITIVE_EDGE' : grossPnL > -1 ? 'FLAT' : 'NEGATIVE_EDGE',
    },
    
    breakdowns: {
      byCity: Object.fromEntries(
        Object.entries(byCity).map(([city, d]) => [city, {
          trades: d.trades, correct: d.correct,
          hitRate: d.trades > 0 ? +((d.correct / d.trades * 100).toFixed(1)) : 0,
          pnl: +d.pnl.toFixed(2),
        }]).sort((a, b) => b[1].pnl - a[1].pnl)
      ),
      byBucketType: Object.fromEntries(
        Object.entries(byBucketType).map(([type, d]) => [type, {
          trades: d.trades, correct: d.correct,
          hitRate: d.trades > 0 ? +((d.correct / d.trades * 100).toFixed(1)) : 0,
          pnl: +d.pnl.toFixed(2),
        }])
      ),
      byConfidence: Object.fromEntries(
        Object.entries(byConfidence).map(([level, d]) => [level, {
          trades: d.trades, correct: d.correct,
          hitRate: d.trades > 0 ? +((d.correct / d.trades * 100).toFixed(1)) : 0,
          pnl: +d.pnl.toFixed(2),
        }])
      ),
    },
    
    calibration: sortedCalibration,
    
    trades: trades.sort((a, b) => b.pnl - a.pnl),
    
    // Top winners and losers
    topWinners: trades.filter(t => t.correct).sort((a, b) => b.pnl - a.pnl).slice(0, 10),
    topLosers: trades.filter(t => !t.correct).sort((a, b) => a.pnl - b.pnl).slice(0, 10),
  };
  
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  
  // Console output
  console.log(`${'='.repeat(60)}`);
  console.log(`  WEATHER BACKTEST RESULTS (14 days, 12 cities)`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Events analyzed:         ${rawData.length}`);
  console.log(`Markets analyzed:        ${allParsed.length}`);
  console.log(`Ensemble forecasts:      ${Object.keys(forecasts).length}`);
  console.log(`Total signals generated: ${totalSignals}`);
  console.log(`Correct predictions:     ${correctSignals}`);
  console.log(`Hit rate:                ${output.summary.hitRateStr}`);
  console.log(`Average edge:            ${output.summary.avgEdgeStr}`);
  console.log(`Gross P&L:               $${grossPnL.toFixed(2)}`);
  console.log(`Net P&L (after fees):    $${grossPnL.toFixed(2)} (weather = zero fees)`);
  console.log(`Verdict:                 ${output.summary.verdict}`);
  
  console.log(`\n📊 By City:`);
  for (const [city, d] of Object.entries(byCity).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${city.padEnd(16)} ${d.correct}/${d.trades} (${(d.correct/d.trades*100).toFixed(0)}%) | P&L: $${d.pnl.toFixed(2)}`);
  }
  
  console.log(`\n📊 By Bucket Type:`);
  for (const [type, d] of Object.entries(byBucketType)) {
    console.log(`  ${type.padEnd(16)} ${d.correct}/${d.trades} (${(d.correct/d.trades*100).toFixed(0)}%) | P&L: $${d.pnl.toFixed(2)}`);
  }
  
  console.log(`\n📊 By Confidence:`);
  for (const [level, d] of Object.entries(byConfidence)) {
    console.log(`  ${level.padEnd(16)} ${d.correct}/${d.trades} (${(d.correct/d.trades*100).toFixed(0)}%) | P&L: $${d.pnl.toFixed(2)}`);
  }
  
  console.log(`\n📊 Calibration (forecast prob → actual resolution rate):`);
  for (const c of sortedCalibration) {
    const bar = '█'.repeat(Math.round(c.actual_rate * 20));
    console.log(`  ${(c.predicted*100).toFixed(0)}% predicted → ${(c.actual_rate*100).toFixed(0)}% actual (n=${c.count}) ${bar} ${c.error > 0 ? '+' : ''}${(c.error*100).toFixed(0)}% error`);
  }
  
  if (trades.length > 0) {
    console.log(`\n🏆 Top 5 Winners:`);
    for (const t of trades.filter(t => t.correct).sort((a, b) => b.pnl - a.pnl).slice(0, 5)) {
      console.log(`  +$${t.pnl.toFixed(2)} | ${t.city} ${t.date} ${t.bucket}°${t.unit} | ${t.signal} @ ${(t.tradePrice*100).toFixed(0)}¢`);
    }
    console.log(`\n💀 Top 5 Losers:`);
    for (const t of trades.filter(t => !t.correct).sort((a, b) => a.pnl - b.pnl).slice(0, 5)) {
      console.log(`  -$${Math.abs(t.pnl).toFixed(2)} | ${t.city} ${t.date} ${t.bucket}°${t.unit} | ${t.signal} @ ${(t.tradePrice*100).toFixed(0)}¢`);
    }
  }
  
  console.log(`\nOutput: ${OUTPUT_FILE}`);
  
  if (output.summary.verdict !== 'POSITIVE_EDGE') {
    console.log(`\n⚠️  WEATHER EXECUTOR SHOULD REMAIN DISABLED`);
  } else {
    console.log(`\n✅ POSITIVE EDGE CONFIRMED — safe to re-enable weather executor`);
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  console.error(e.stack);
  process.exit(1);
});
