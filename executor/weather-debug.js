#!/usr/bin/env node
// Debug: inspect what Gamma returns for resolved weather markets
const GAMMA_API = 'https://gamma-api.polymarket.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'stuart-debug/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function main() {
  // Strategy 1: events with slug_contains=highest-temperature, closed=true
  console.log('=== Strategy 1: events?closed=true&slug_contains=highest-temperature ===');
  try {
    const events = await fetchJSON(`${GAMMA_API}/events?closed=true&limit=20&slug_contains=highest-temperature&order=endDate&ascending=false`);
    console.log(`Found ${events.length} events`);
    for (const e of events.slice(0, 5)) {
      console.log(`\nEvent: ${e.title || e.slug}`);
      console.log(`  slug: ${e.slug}, closed: ${e.closed}, endDate: ${e.endDate}`);
      console.log(`  markets: ${(e.markets||[]).length}`);
      for (const m of (e.markets||[]).slice(0, 3)) {
        console.log(`  - Q: ${(m.question||'').slice(0,120)}`);
        console.log(`    conditionId: ${m.conditionId}`);
        console.log(`    closed: ${m.closed}, resolved: ${m.resolved}`);
        console.log(`    outcomePrices: ${m.outcomePrices}`);
        console.log(`    endDate: ${m.endDate}`);
      }
    }
  } catch (e) { console.log('Error:', e.message); }

  await sleep(500);

  // Strategy 2: direct markets search
  console.log('\n=== Strategy 2: markets?closed=true (filter for temperature) ===');
  try {
    const markets = await fetchJSON(`${GAMMA_API}/markets?closed=true&limit=100&order=endDate&ascending=false`);
    const weatherMkts = markets.filter(m => (m.question||'').toLowerCase().includes('temperature'));
    console.log(`Found ${weatherMkts.length} temperature markets out of ${markets.length}`);
    for (const m of weatherMkts.slice(0, 10)) {
      console.log(`\n  Q: ${(m.question||'').slice(0,150)}`);
      console.log(`  closed: ${m.closed}, resolved: ${m.resolved}, endDate: ${m.endDate}`);
      console.log(`  outcomePrices: ${m.outcomePrices}`);
      console.log(`  lastTradePrice: ${m.lastTradePrice}`);
      const daysAgo = (Date.now() - new Date(m.endDate).getTime()) / 86400000;
      console.log(`  daysAgo: ${daysAgo.toFixed(1)}`);
    }
  } catch (e) { console.log('Error:', e.message); }

  await sleep(500);

  // Strategy 3: Try tag-based search
  console.log('\n=== Strategy 3: events?tag=weather&closed=true ===');
  try {
    const events = await fetchJSON(`${GAMMA_API}/events?closed=true&limit=20&tag=weather&order=endDate&ascending=false`);
    console.log(`Found ${events.length} events`);
    for (const e of events.slice(0, 3)) {
      console.log(`\nEvent: ${e.title || e.slug}`);
      console.log(`  markets: ${(e.markets||[]).length}`);
    }
  } catch (e) { console.log('Error:', e.message); }

  // Strategy 4: broader slug search
  console.log('\n=== Strategy 4: events?closed=true&slug_contains=temperature ===');
  try {
    const events = await fetchJSON(`${GAMMA_API}/events?closed=true&limit=20&slug_contains=temperature&order=endDate&ascending=false`);
    console.log(`Found ${events.length} events`);
    for (const e of events.slice(0, 5)) {
      console.log(`\nEvent: ${e.title || e.slug}, endDate: ${e.endDate}`);
      console.log(`  markets: ${(e.markets||[]).length}`);
      for (const m of (e.markets||[]).slice(0, 2)) {
        console.log(`  - Q: ${(m.question||'').slice(0,150)}`);
        console.log(`    resolved: ${m.resolved}, outcomePrices: ${m.outcomePrices}`);
      }
    }
  } catch (e) { console.log('Error:', e.message); }
}

main().catch(e => console.error(e));
