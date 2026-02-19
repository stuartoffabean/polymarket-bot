#!/usr/bin/env node
/**
 * resolve-weather-paper.js — Resolve weather v2 paper trades against actual temperatures
 * 
 * Resolution sources (in priority order):
 * 1. Polymarket market resolution — check if YES token price = $1.00 or $0.00 (definitive)
 * 2. NOAA observed data — actual station observations for US cities (authoritative)
 * 3. Open-Meteo historical API — global coverage fallback
 * 
 * Cross-validates weather data against Polymarket resolution to catch bucket-matching bugs.
 * 
 * Run via cron or manually: node resolve-weather-paper.js [--dry-run]
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const PAPER_FILE = path.join(__dirname, 'weather-v2-paper.json');
const DRY_RUN = process.argv.includes('--dry-run');

// City coordinates + NOAA station IDs for US cities
const CITY_COORDS = {
  'New York City': { lat: 40.7128, lon: -74.0060, tz: 'America/New_York', noaaStation: 'KNYC' },
  'London': { lat: 51.5074, lon: -0.1278, tz: 'Europe/London' },
  'Tokyo': { lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo' },
  'Seoul': { lat: 37.5665, lon: 126.978, tz: 'Asia/Seoul' },
  'Chicago': { lat: 41.8781, lon: -87.6298, tz: 'America/Chicago', noaaStation: 'KORD' },
  'Miami': { lat: 25.7617, lon: -80.1918, tz: 'America/New_York', noaaStation: 'KMIA' },
  'Dallas': { lat: 32.7767, lon: -96.797, tz: 'America/Chicago', noaaStation: 'KDFW' },
  'Seattle': { lat: 47.6062, lon: -122.3321, tz: 'America/Los_Angeles', noaaStation: 'KSEA' },
  'Atlanta': { lat: 33.749, lon: -84.388, tz: 'America/New_York', noaaStation: 'KATL' },
  'Toronto': { lat: 43.6532, lon: -79.3832, tz: 'America/Toronto' },
  'Buenos Aires': { lat: -34.6037, lon: -58.3816, tz: 'America/Argentina/Buenos_Aires' },
  'Wellington': { lat: -41.2865, lon: 174.7762, tz: 'Pacific/Auckland' },
  'São Paulo': { lat: -23.5505, lon: -46.6333, tz: 'America/Sao_Paulo' },
  'Ankara': { lat: 39.9334, lon: 32.8597, tz: 'Europe/Istanbul' },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = { timeout: 15000, headers: { 'User-Agent': 'PolymarketWeatherResolver/1.0', ...headers } };
    https.get(url, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data: null, raw: data }); }
      });
    }).on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════
// SOURCE 1: Polymarket Market Resolution
// ═══════════════════════════════════════════════════════════════

async function checkPolymarketResolution(yesToken) {
  // Check current price — if resolved, YES token = $1.00 (won) or ~$0.00 (lost)
  try {
    const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(yesToken)}`;
    const resp = await httpGet(url);
    if (resp.status !== 200 || !resp.data) return null;

    const book = resp.data;
    // If market resolved: no asks left, best bid = 1.0 (YES won) or no bids (YES lost)
    const bids = book.bids || [];
    const asks = book.asks || [];
    
    // Resolved YES: bids at $1.00, no asks
    if (bids.length > 0 && asks.length === 0) {
      const topBid = parseFloat(bids[0].price);
      if (topBid >= 0.99) return 'YES_WON';
      if (topBid <= 0.01) return 'YES_LOST';
    }
    
    // Resolved NO: no bids, or bids at 0
    if (bids.length === 0 && asks.length === 0) return 'MARKET_EMPTY';
    
    // Check if price has settled to ~0 or ~1 (market resolved but book still has stragglers)
    const midBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
    const midAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;
    if (midBid >= 0.95 && midAsk >= 0.95) return 'YES_WON';
    if (midBid <= 0.05 && midAsk <= 0.05) return 'YES_LOST';
    
    return null; // Not resolved yet
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// SOURCE 2: NOAA Observed Data (US cities)
// ═══════════════════════════════════════════════════════════════

async function getNOAAObserved(city, date) {
  const coords = CITY_COORDS[city];
  if (!coords || !coords.noaaStation) return null;

  try {
    // NOAA Climate Data Online - observed station data
    const startDate = `${date}T00:00:00Z`;
    const endDate = `${date}T23:59:59Z`;
    const url = `https://api.weather.gov/stations/${coords.noaaStation}/observations?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`;
    
    const resp = await httpGet(url, { Accept: 'application/geo+json' });
    if (resp.status !== 200 || !resp.data) return null;

    const features = resp.data.features || [];
    if (features.length === 0) return null;

    // Find max temperature from hourly observations
    let maxTempC = -999;
    for (const f of features) {
      const temp = f.properties?.temperature?.value;
      if (temp !== null && temp !== undefined && temp > maxTempC) {
        maxTempC = temp;
      }
    }

    if (maxTempC === -999) return null;

    return {
      tempC: maxTempC,
      tempF: maxTempC * 9/5 + 32,
      source: 'NOAA',
      station: coords.noaaStation,
      observations: features.length,
    };
  } catch (e) {
    console.log(`   ⚠️ NOAA observed fetch failed for ${city}: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// SOURCE 3: Open-Meteo Historical (global fallback)
// ═══════════════════════════════════════════════════════════════

async function getOpenMeteoActual(city, date) {
  const coords = CITY_COORDS[city];
  if (!coords) return null;

  try {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${coords.lat}&longitude=${coords.lon}&start_date=${date}&end_date=${date}&daily=temperature_2m_max&timezone=${encodeURIComponent(coords.tz)}`;
    const resp = await httpGet(url);
    if (!resp.data?.daily?.temperature_2m_max?.[0]) return null;

    const tempC = resp.data.daily.temperature_2m_max[0];
    return {
      tempC,
      tempF: tempC * 9/5 + 32,
      source: 'Open-Meteo',
    };
  } catch (e) {
    console.log(`   ⚠️ Open-Meteo fetch failed for ${city}: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// COMBINED: Get best actual temperature + cross-validate
// ═══════════════════════════════════════════════════════════════

async function getActualTemp(city, date) {
  // Try NOAA first (US cities), then Open-Meteo
  const noaa = await getNOAAObserved(city, date);
  await sleep(300);
  const openMeteo = await getOpenMeteoActual(city, date);
  
  if (noaa && openMeteo) {
    const diff = Math.abs(noaa.tempF - openMeteo.tempF);
    if (diff > 3) {
      console.log(`   ⚠️ NOAA/Open-Meteo disagree by ${diff.toFixed(1)}°F (NOAA: ${noaa.tempF.toFixed(1)}°F, OM: ${openMeteo.tempF.toFixed(1)}°F) — using NOAA`);
    }
    return { ...noaa, openMeteoTempF: openMeteo.tempF, openMeteoTempC: openMeteo.tempC };
  }
  
  if (noaa) return noaa;
  if (openMeteo) return openMeteo;
  return null;
}

// ═══════════════════════════════════════════════════════════════
// BUCKET MATCHING
// ═══════════════════════════════════════════════════════════════

function bucketContainsTemp(bucket, actualTemp, unit) {
  const temp = unit === '°C' ? actualTemp.tempC : actualTemp.tempF;
  const rounded = Math.round(temp);
  
  if (bucket.startsWith('≥') || bucket.startsWith('>=')) {
    const threshold = parseFloat(bucket.replace(/[≥>=]/g, ''));
    return rounded >= threshold;
  }
  if (bucket.startsWith('≤') || bucket.startsWith('<=')) {
    const threshold = parseFloat(bucket.replace(/[≤<=]/g, ''));
    return rounded <= threshold;
  }
  if (bucket.includes('-')) {
    const [low, high] = bucket.split('-').map(Number);
    return rounded >= low && rounded <= high;
  }
  return rounded === parseInt(bucket);
}

function findWinningBucket(trades, city, date, actualTemp) {
  const cityTrades = trades.filter(t => t.city === city && t.date === date);
  const unit = cityTrades[0]?.unit || '°F';
  
  for (const t of cityTrades) {
    if (bucketContainsTemp(t.bucket, actualTemp, unit)) {
      return t.bucket;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log(`🌡️  Weather V2 Paper Trade Resolution${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`   Sources: Polymarket resolution + NOAA observed + Open-Meteo historical\n`);
  
  const paper = JSON.parse(fs.readFileSync(PAPER_FILE, 'utf8'));
  const trades = paper.paperTrades || [];
  
  const unresolved = trades.filter(t => !t.resolution);
  const alreadyResolved = trades.filter(t => t.resolution);
  
  console.log(`Total trades: ${trades.length}`);
  console.log(`Already resolved: ${alreadyResolved.length}`);
  console.log(`Unresolved: ${unresolved.length}\n`);
  
  if (unresolved.length === 0) {
    console.log('Nothing to resolve.');
    return;
  }
  
  // Group unresolved by city+date
  const groups = {};
  unresolved.forEach(t => {
    const key = `${t.city}|${t.date}`;
    if (!groups[key]) groups[key] = { city: t.city, date: t.date, trades: [] };
    groups[key].trades.push(t);
  });
  
  let resolved = 0, skipped = 0, wins = 0, losses = 0;
  let totalPl = 0;
  let polymarketMismatches = 0;
  
  for (const [key, group] of Object.entries(groups)) {
    const { city, date } = group;
    
    // Check if the date has passed (need full day to end)
    const dateEnd = new Date(date + 'T23:59:59Z');
    const now = new Date();
    if (now < dateEnd) {
      console.log(`⏳ ${city} ${date} — not yet ended, skipping`);
      skipped += group.trades.length;
      continue;
    }
    
    // Get actual temperature (NOAA + Open-Meteo)
    const actualTemp = await getActualTemp(city, date);
    if (!actualTemp) {
      console.log(`❓ ${city} ${date} — no actual temp data yet, skipping`);
      skipped += group.trades.length;
      continue;
    }
    
    const unit = group.trades[0]?.unit || '°F';
    const displayTemp = unit === '°C' ? `${actualTemp.tempC.toFixed(1)}°C` : `${actualTemp.tempF.toFixed(1)}°F`;
    const wonBucket = findWinningBucket(trades, city, date, actualTemp);
    const sourceTag = actualTemp.source === 'NOAA' ? `NOAA(${actualTemp.station})` : 'Open-Meteo';
    
    console.log(`✅ ${city} ${date} — actual: ${displayTemp} via ${sourceTag}, winning bucket: ${wonBucket || 'NONE'}`);
    
    for (const trade of group.trades) {
      const weatherSaysWon = bucketContainsTemp(trade.bucket, actualTemp, unit);
      
      // Cross-validate with Polymarket resolution
      let polyResult = null;
      if (trade.yesToken) {
        polyResult = await checkPolymarketResolution(trade.yesToken);
        await sleep(200); // rate limit
      }
      
      let won = weatherSaysWon;
      let crossValidated = false;
      
      if (polyResult === 'YES_WON') {
        crossValidated = true;
        if (!weatherSaysWon) {
          console.log(`   🚨 MISMATCH: Weather says LOSS but Polymarket resolved YES for bucket ${trade.bucket}!`);
          won = true; // Trust Polymarket resolution over our weather data
          polymarketMismatches++;
        }
      } else if (polyResult === 'YES_LOST' || polyResult === 'MARKET_EMPTY') {
        crossValidated = true;
        if (weatherSaysWon) {
          console.log(`   🚨 MISMATCH: Weather says WIN but Polymarket resolved NO for bucket ${trade.bucket}!`);
          won = false; // Trust Polymarket
          polymarketMismatches++;
        }
      }
      
      // Calculate P&L properly based on trade type
      // entryPrice = what we actually paid per share (from orderbook ask)
      const entryPrice = trade.entryPrice || trade.execPrice || trade.marketPrice;
      const shares = trade.shares || 1;  // backwards compat: old trades = 1 share
      const totalCost = trade.totalCost || entryPrice;
      
      // Per-share P&L: WIN pays $1/share, LOSS pays $0/share
      const perSharePl = won ? (1 - entryPrice) : -entryPrice;
      // Dollar P&L = per-share * shares
      const dollarPl = perSharePl * shares;
      
      trade.resolution = won ? 'WIN' : 'LOSS';
      trade.actualTemp = unit === '°C' ? actualTemp.tempC : actualTemp.tempF;
      trade.tempSource = actualTemp.source;
      trade.wonBucket = wonBucket;
      trade.pl = perSharePl;              // per-share (backwards compat)
      trade.dollarPnl = Math.round(dollarPl * 100) / 100;
      trade.entryPrice = entryPrice;      // backfill if missing
      trade.crossValidated = crossValidated;
      trade.polymarketResolution = polyResult;
      
      if (won) wins++;
      else losses++;
      totalPl += dollarPl;
      resolved++;
      
      const cvTag = crossValidated ? ' ✓PM' : '';
      const sizeTag = shares > 1 ? ` (${shares}sh × ${entryPrice.toFixed(2)})` : '';
      console.log(`   ${won ? '🟢' : '🔴'} ${trade.bucket} ${unit} → ${trade.resolution}${cvTag} | $${dollarPl >= 0 ? '+' : ''}${dollarPl.toFixed(2)}${sizeTag} | edge: ${(trade.edge * 100).toFixed(1)}%`);
    }
    
    await sleep(500); // Rate limit between cities
  }
  
  console.log(`\n📊 Resolution Summary:`);
  console.log(`  Resolved: ${resolved} | Skipped: ${skipped}`);
  console.log(`  Wins: ${wins} | Losses: ${losses} | Win rate: ${resolved > 0 ? (wins/resolved*100).toFixed(1) : 'N/A'}%`);
  console.log(`  Total P/L: $${totalPl >= 0 ? '+' : ''}${totalPl.toFixed(2)}`);
  console.log(`  Polymarket cross-validated: ${resolved - skipped} | Mismatches: ${polymarketMismatches}`);
  console.log(`  Previously resolved: ${alreadyResolved.length} (${alreadyResolved.filter(t=>t.resolution==='WIN').length}W/${alreadyResolved.filter(t=>t.resolution==='LOSS').length}L)`);
  
  if (polymarketMismatches > 0) {
    console.log(`\n⚠️  ${polymarketMismatches} MISMATCHES — our bucket logic disagrees with Polymarket resolution!`);
    console.log(`   This means our forecast-to-bucket mapping has bugs. Review immediately.`);
  }
  
  if (!DRY_RUN && resolved > 0) {
    fs.writeFileSync(PAPER_FILE, JSON.stringify(paper, null, 2));
    console.log(`\n💾 Saved ${resolved} resolutions to ${PAPER_FILE}`);
  } else if (DRY_RUN) {
    console.log(`\n🔍 Dry run — no changes written`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
