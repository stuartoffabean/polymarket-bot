#!/usr/bin/env node
// Polymarket Arb Scanner v2 — Lean, no OOM
// Scans NegRisk events for YES sum deviations from $1.00

const fs = require('fs');
const path = require('path');

const GAMMA = 'https://gamma-api.polymarket.com';
const PROXY = 'https://proxy-rosy-sigma-25.vercel.app';
const THRESHOLD = 0.025; // 2.5% deviation
const RESULTS = path.join(__dirname, 'arb-results.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('Fetching top events...');
  const res = await fetch(`${GAMMA}/events?limit=100&active=true&closed=false&order=volume24hr&ascending=false`);
  const events = await res.json();
  
  // Filter to NegRisk only
  const negRisk = events.filter(e => e.negRisk || e.enableNegRisk);
  console.log(`Found ${negRisk.length} NegRisk events out of ${events.length} total`);

  const opportunities = [];

  for (const event of negRisk) {
    const markets = (event.markets || []).filter(m => m.active && !m.closed);
    if (markets.length < 2) continue;

    // Sum mid YES prices from Gamma data (no extra API calls)
    let midSum = 0;
    const outcomes = [];
    
    for (const m of markets) {
      let yesPrice = 0;
      try {
        const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        yesPrice = parseFloat(prices[0]) || 0;
      } catch(e) {}
      
      let tokenId = null;
      try {
        const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        tokenId = tokens[0];
      } catch(e) {}

      midSum += yesPrice;
      if (yesPrice > 0.001) {
        outcomes.push({ name: (m.question || '').slice(0, 60), yesPrice, tokenId });
      }
    }

    const deviation = Math.abs(midSum - 1.0);
    if (deviation < THRESHOLD) continue;

    // Only fetch executable prices for flagged events — skip if too many outcomes (>15 = thin markets, not worth arbing)
    if (outcomes.length > 20) {
      console.log(`\nSKIPPED: ${event.title.slice(0, 60)} | ${outcomes.length} outcomes (too many) | MidSum: ${midSum.toFixed(4)}`);
      continue;
    }
    console.log(`\nFLAGGED: ${event.title.slice(0, 60)} | MidSum: ${midSum.toFixed(4)} | Dev: ${(deviation*100).toFixed(1)}%`);
    
    let execSum = 0;
    let allOk = true;
    for (const o of outcomes) {
      if (!o.tokenId) { allOk = false; continue; }
      try {
        await sleep(700); // rate limit
        const r = await fetch(`${PROXY}/price?token_id=${o.tokenId}&side=buy`);
        const d = await r.json();
        o.execPrice = parseFloat(d.price) || 0;
        execSum += o.execPrice;
        console.log(`  ${o.name}: mid=${o.yesPrice.toFixed(3)} exec=${o.execPrice.toFixed(3)}`);
      } catch(e) {
        o.execPrice = 0;
        allOk = false;
      }
    }

    const type = midSum > 1.0 ? 'SHORT' : 'LONG';
    const execDev = Math.abs(execSum - 1.0);
    const profit = type === 'SHORT' ? (execSum - 1.0) * 100 : (1.0 - execSum) * 100;

    opportunities.push({
      event: event.title,
      slug: event.slug,
      type,
      outcomes: outcomes.length,
      midSum: +midSum.toFixed(4),
      execSum: allOk ? +execSum.toFixed(4) : null,
      deviation: +(deviation * 100).toFixed(2),
      execDeviation: allOk ? +(execDev * 100).toFixed(2) : null,
      profitPer100: +profit.toFixed(2),
      viable: profit > 0 && allOk,
      details: outcomes.map(o => ({ name: o.name, mid: o.yesPrice, exec: o.execPrice, token: o.tokenId }))
    });

    console.log(`  ExecSum: ${execSum.toFixed(4)} | Profit/$100: $${profit.toFixed(2)} | Viable: ${profit > 0 && allOk}`);
  }

  const output = {
    timestamp: new Date().toISOString(),
    summary: { total: events.length, negRisk: negRisk.length, flagged: opportunities.length, viable: opportunities.filter(o => o.viable).length },
    opportunities: opportunities.sort((a, b) => b.profitPer100 - a.profitPer100)
  };

  fs.writeFileSync(RESULTS, JSON.stringify(output, null, 2));
  console.log(`\n✅ Results: ${RESULTS}`);
  console.log(`Flagged: ${opportunities.length} | Viable: ${output.summary.viable}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
