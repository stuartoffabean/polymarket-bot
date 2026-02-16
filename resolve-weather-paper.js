#!/usr/bin/env node
/**
 * resolve-weather-paper.js — Resolve weather v2 paper trades against actual temperatures
 * 
 * Pulls actual high temperatures from Open-Meteo historical API and updates
 * paper trades with WIN/LOSS resolution, actual temperature, and P&L.
 * 
 * Run via cron or manually: node resolve-weather-paper.js [--dry-run]
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const PAPER_FILE = path.join(__dirname, 'weather-v2-paper.json');
const DRY_RUN = process.argv.includes('--dry-run');

// City coordinates for Open-Meteo API
const CITY_COORDS = {
  'New York City': { lat: 40.7128, lon: -74.0060, tz: 'America/New_York' },
  'London': { lat: 51.5074, lon: -0.1278, tz: 'Europe/London' },
  'Tokyo': { lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo' },
  'Seoul': { lat: 37.5665, lon: 126.978, tz: 'Asia/Seoul' },
  'Chicago': { lat: 41.8781, lon: -87.6298, tz: 'America/Chicago' },
  'Miami': { lat: 25.7617, lon: -80.1918, tz: 'America/New_York' },
  'Dallas': { lat: 32.7767, lon: -96.797, tz: 'America/Chicago' },
  'Seattle': { lat: 47.6062, lon: -122.3321, tz: 'America/Los_Angeles' },
  'Atlanta': { lat: 33.749, lon: -84.388, tz: 'America/New_York' },
  'Toronto': { lat: 43.6532, lon: -79.3832, tz: 'America/Toronto' },
  'Buenos Aires': { lat: -34.6037, lon: -58.3816, tz: 'America/Argentina/Buenos_Aires' },
  'Wellington': { lat: -41.2865, lon: 174.7762, tz: 'Pacific/Auckland' },
  'São Paulo': { lat: -23.5505, lon: -46.6333, tz: 'America/Sao_Paulo' },
  'Ankara': { lat: 39.9334, lon: 32.8597, tz: 'Europe/Istanbul' },
};

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function getActualTemp(city, date) {
  const coords = CITY_COORDS[city];
  if (!coords) {
    console.log(`  ⚠️ No coordinates for ${city}`);
    return null;
  }

  // Open-Meteo historical weather API (free, no key needed)
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${coords.lat}&longitude=${coords.lon}&start_date=${date}&end_date=${date}&daily=temperature_2m_max&timezone=${encodeURIComponent(coords.tz)}`;
  
  try {
    const data = await httpGet(url);
    if (data.daily && data.daily.temperature_2m_max && data.daily.temperature_2m_max[0] !== null) {
      const tempC = data.daily.temperature_2m_max[0];
      return { tempC, tempF: tempC * 9/5 + 32 };
    }
    return null;
  } catch (e) {
    console.log(`  ⚠️ Failed to fetch temp for ${city} ${date}: ${e.message}`);
    return null;
  }
}

function bucketContainsTemp(bucket, actualTemp, unit) {
  // Parse bucket format: "42-43", "≥74", "≤81", "8", "33", etc.
  const temp = unit === '°C' ? actualTemp.tempC : actualTemp.tempF;
  const rounded = Math.round(temp); // Polymarket uses rounded temps for resolution
  
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
  // Single value bucket (e.g., "8" for London °C)
  return rounded === parseInt(bucket);
}

function findWinningBucket(trades, city, date, actualTemp) {
  // Find which bucket the actual temp falls in
  const cityTrades = trades.filter(t => t.city === city && t.date === date);
  const unit = cityTrades[0]?.unit || '°F';
  
  for (const t of cityTrades) {
    if (bucketContainsTemp(t.bucket, actualTemp, unit)) {
      return t.bucket;
    }
  }
  
  // Temp might be outside all traded buckets
  return null;
}

async function main() {
  console.log(`🌡️  Weather V2 Paper Trade Resolution${DRY_RUN ? ' (DRY RUN)' : ''}\n`);
  
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
  
  for (const [key, group] of Object.entries(groups)) {
    const { city, date } = group;
    
    // Check if the date has passed (allow 6h buffer for late resolution)
    const dateEnd = new Date(date + 'T23:59:59Z');
    const now = new Date();
    if (now < dateEnd) {
      console.log(`⏳ ${city} ${date} — not yet ended, skipping`);
      skipped += group.trades.length;
      continue;
    }
    
    const actualTemp = await getActualTemp(city, date);
    if (!actualTemp) {
      console.log(`❓ ${city} ${date} — no actual temp data yet, skipping`);
      skipped += group.trades.length;
      continue;
    }
    
    const unit = group.trades[0]?.unit || '°F';
    const displayTemp = unit === '°C' ? `${actualTemp.tempC.toFixed(1)}°C` : `${actualTemp.tempF.toFixed(1)}°F`;
    const wonBucket = findWinningBucket(trades, city, date, actualTemp);
    
    console.log(`✅ ${city} ${date} — actual high: ${displayTemp} (${actualTemp.tempC.toFixed(1)}°C / ${actualTemp.tempF.toFixed(1)}°F), winning bucket: ${wonBucket || 'NONE'}`);
    
    for (const trade of group.trades) {
      const won = bucketContainsTemp(trade.bucket, actualTemp, unit);
      const pl = won ? (1 - (trade.execPrice || trade.marketPrice)) : -(trade.execPrice || trade.marketPrice);
      
      trade.resolution = won ? 'WIN' : 'LOSS';
      trade.actualTemp = unit === '°C' ? actualTemp.tempC : actualTemp.tempF;
      trade.wonBucket = wonBucket;
      trade.pl = pl;
      
      if (won) wins++;
      else losses++;
      totalPl += pl;
      resolved++;
      
      console.log(`   ${won ? '🟢' : '🔴'} ${trade.bucket} ${unit} (${trade.action}) → ${trade.resolution} | P/L: ${pl >= 0 ? '+' : ''}${pl.toFixed(4)} | edge was ${(trade.edge * 100).toFixed(1)}%`);
    }
    
    // Rate limit (Open-Meteo is free but be nice)
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`\n📊 Resolution Summary:`);
  console.log(`  Resolved: ${resolved} | Skipped: ${skipped}`);
  console.log(`  Wins: ${wins} | Losses: ${losses} | Win rate: ${resolved > 0 ? (wins/resolved*100).toFixed(1) : 'N/A'}%`);
  console.log(`  Total P/L: ${totalPl >= 0 ? '+' : ''}${totalPl.toFixed(4)}`);
  console.log(`  Previously resolved: ${alreadyResolved.length} (${alreadyResolved.filter(t=>t.resolution==='WIN').length}W/${alreadyResolved.filter(t=>t.resolution==='LOSS').length}L)`);
  
  if (!DRY_RUN && resolved > 0) {
    fs.writeFileSync(PAPER_FILE, JSON.stringify(paper, null, 2));
    console.log(`\n💾 Saved ${resolved} resolutions to ${PAPER_FILE}`);
  } else if (DRY_RUN) {
    console.log(`\n🔍 Dry run — no changes written`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
