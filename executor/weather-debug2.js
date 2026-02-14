#!/usr/bin/env node
// Fetch resolved weather markets by searching known slug patterns for past 14 days
const GAMMA_API = 'https://gamma-api.polymarket.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'stuart-debug/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

const cities = ['nyc', 'chicago', 'atlanta', 'dallas', 'seattle', 'miami', 'seoul', 'london', 'buenos-aires', 'wellington', 'ankara', 'toronto'];
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

async function main() {
  const now = new Date();
  let totalFound = 0;
  let totalMarkets = 0;
  
  // Generate dates for past 14 days
  const dates = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now - i * 86400000);
    const month = months[d.getUTCMonth()];
    const day = d.getUTCDate();
    const year = d.getUTCFullYear();
    dates.push({ month, day, year, iso: `${year}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}` });
  }
  
  console.log(`Searching ${dates.length} dates x ${cities.length} cities = ${dates.length * cities.length} combinations\n`);
  
  const allEvents = [];
  
  for (const date of dates) {
    for (const city of cities) {
      const slug = `highest-temperature-in-${city}-on-${date.month}-${date.day}-${date.year}`;
      try {
        // Try events endpoint with slug_contains
        const url = `${GAMMA_API}/events?slug=${slug}&limit=1`;
        const events = await fetchJSON(url);
        if (events && events.length > 0) {
          const e = events[0];
          const mkts = e.markets || [];
          totalFound++;
          totalMarkets += mkts.length;
          console.log(`✅ ${city} ${date.iso}: ${mkts.length} markets, closed=${e.closed}`);
          
          // Show first market details
          if (mkts.length > 0) {
            const m = mkts[0];
            console.log(`   Q: ${(m.question||'').slice(0,100)}`);
            console.log(`   outcomePrices: ${m.outcomePrices}, closed: ${m.closed}`);
          }
          
          allEvents.push({ city, date: date.iso, slug, event: e });
        }
        await sleep(200);
      } catch (e) {
        // 404 or similar — event doesn't exist for this city/date
      }
    }
  }
  
  console.log(`\nFound ${totalFound} events with ${totalMarkets} total markets`);
  
  // Show resolved vs not
  let resolved = 0, open = 0;
  for (const ae of allEvents) {
    if (ae.event.closed) resolved++;
    else open++;
  }
  console.log(`Resolved: ${resolved}, Open: ${open}`);
  
  // Save raw data for backtest
  const { writeFileSync } = require('fs');
  const path = require('path');
  writeFileSync(path.join(__dirname, '..', 'weather-resolved-raw.json'), JSON.stringify(allEvents, null, 2));
  console.log('Saved to weather-resolved-raw.json');
}

main().catch(e => console.error(e));
