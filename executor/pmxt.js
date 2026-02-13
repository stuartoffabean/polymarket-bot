#!/usr/bin/env node
/**
 * PMXT v2.0 — Cross-Platform Arbitrage Scanner
 * 
 * Direct API calls (fast) + research-backed matching:
 *   - Jaccard (60%) + Levenshtein (40%) similarity (realfishsam weighting)
 *   - Entity normalization (ImMike approach)
 *   - Two-layer matching: event → outcome (poly-kalshi-arb pattern)
 *   - Pair caching with 2h TTL (Rust bot pattern)
 * 
 * Usage: node executor/pmxt.js
 * Output: pmxt-results.json
 */

const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');

const OUTPUT_FILE = join(__dirname, '..', 'pmxt-results.json');
const CACHE_FILE = join(__dirname, '..', 'pmxt-cache.json');
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const GAMMA_API = 'https://gamma-api.polymarket.com';
const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(1000);
    }
  }
}

// ── Fuzzy Matching (realfishsam weighting: 60% Jaccard + 40% Levenshtein) ──

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function levSim(a, b) {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

const NOISE = new Set(['will','the','a','an','in','on','at','by','to','of','for','be','is','are','or','and','it','no','yes','not','this','that','what','how','does','do','has','have','had']);

function jaccard(a, b) {
  const aw = new Set(a.split(/\s+/).filter(w => w.length > 2 && !NOISE.has(w)));
  const bw = new Set(b.split(/\s+/).filter(w => w.length > 2 && !NOISE.has(w)));
  if (!aw.size || !bw.size) return 0;
  const inter = [...aw].filter(w => bw.has(w)).length;
  return inter / new Set([...aw, ...bw]).size;
}

function similarity(a, b) {
  const an = normalize(a), bn = normalize(b);
  // Fast path: Jaccard first, only compute Levenshtein if Jaccard shows promise
  const j = jaccard(an, bn);
  if (j < 0.15) return j * 0.6; // No point computing Levenshtein
  return j * 0.6 + levSim(an, bn) * 0.4;
}

// ── Entity Normalization (ImMike approach) ───────────────────────────────────

const ALIASES = {
  'united states': 'us', 'u.s.': 'us', 'u.s': 'us',
  'federal reserve': 'fed', 'bitcoin': 'btc', 'ethereum': 'eth',
  'donald trump': 'trump', 'elon musk': 'musk',
  'european union': 'eu', 'united kingdom': 'uk',
  'republican party': 'republican', 'democratic party': 'democratic',
  'gop': 'republican', 'people\'s republic of china': 'china',
};

function normalize(text) {
  let t = (text || '').toLowerCase().replace(/['']/g, "'");
  for (const [from, to] of Object.entries(ALIASES)) t = t.replaceAll(from, to);
  return t.replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Cache ────────────────────────────────────────────────────────────────────

function loadCache() {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    const now = Date.now(), valid = {};
    for (const [k, v] of Object.entries(data))
      if (now - v.ts < CACHE_TTL_MS) valid[k] = v;
    return valid;
  } catch { return {}; }
}
function saveCache(c) { try { writeFileSync(CACHE_FILE, JSON.stringify(c)); } catch {} }

// ── Data Fetching ────────────────────────────────────────────────────────────

async function fetchKalshiEvents() {
  console.log('[FETCH] Kalshi events...');
  const all = [];
  let cursor = '';
  const skipPrefixes = ['KXMVE','KXNBA','KXNFL','KXNHL','KXMLB','KXNCAA','KXSOCCER','KXMMA','KXCRICKET','KXUFC'];
  
  for (let p = 0; p < 5; p++) {
    const url = `${KALSHI_API}/events?limit=200&status=open` + (cursor ? `&cursor=${cursor}` : '');
    const d = await fetchJSON(url);
    const events = (d.events || []).filter(e => !skipPrefixes.some(pfx => e.event_ticker?.startsWith(pfx)));
    all.push(...events);
    cursor = d.cursor || '';
    if (!cursor) break;
    await sleep(200);
  }
  console.log(`[FETCH] ${all.length} Kalshi events`);
  return all;
}

async function fetchKalshiMarkets(eventTicker) {
  const d = await fetchJSON(`${KALSHI_API}/markets?event_ticker=${eventTicker}&limit=100&status=open`);
  return (d.markets || []).filter(m => m.yes_bid > 0 || m.yes_ask > 0);
}

async function fetchPolymarketEvents() {
  console.log('[FETCH] Polymarket events...');
  const all = [];
  for (let offset = 0; offset < 600; offset += 200) {
    const url = `${GAMMA_API}/events?closed=false&active=true&limit=200&offset=${offset}&order=volume24hr&ascending=false`;
    const data = await fetchJSON(url);
    if (!data?.length) break;
    all.push(...data);
    await sleep(200);
  }
  console.log(`[FETCH] ${all.length} Polymarket events`);
  return all;
}

// ── Two-Layer Matching ───────────────────────────────────────────────────────

// Layer 1: Match Kalshi events → Polymarket events by title similarity
function matchEvents(kEvents, pEvents, cache) {
  const pairs = [];

  for (const ke of kEvents) {
    const kTitle = normalize(ke.title || '');
    if (kTitle.length < 8) continue;

    // Check cache
    const cacheKey = `evt:${ke.event_ticker}`;
    if (cache[cacheKey]) {
      const cached = cache[cacheKey];
      const pe = pEvents.find(p => p.id === cached.polyEventId);
      if (pe) {
        pairs.push({ ke, pe, score: cached.score, cached: true });
        continue;
      }
    }

    let bestPe = null, bestScore = 0;
    for (const pe of pEvents) {
      const pTitle = normalize(pe.title || '');
      const score = similarity(kTitle, pTitle);
      if (score > bestScore) { bestScore = score; bestPe = pe; }
    }

    if (bestPe && bestScore >= 0.30) {
      pairs.push({ ke, pe: bestPe, score: bestScore, cached: false });
      cache[cacheKey] = { ts: Date.now(), polyEventId: bestPe.id, score: bestScore };
    }
  }

  return pairs.sort((a, b) => b.score - a.score);
}

// Layer 2: Within matched events, pair specific outcomes/markets
function matchMarketsInEvent(kMarkets, pEvent) {
  const pMarkets = pEvent.markets || [];
  if (!pMarkets.length) return [];

  const results = [];

  for (const km of kMarkets) {
    const kTitle = normalize(km.title || '');
    
    let bestPm = null, bestScore = 0;
    for (const pm of pMarkets) {
      const pTitle = normalize(pm.question || pm.title || '');
      const score = similarity(kTitle, pTitle);
      if (score > bestScore) { bestScore = score; bestPm = pm; }
    }

    if (!bestPm || bestScore < 0.35) continue;

    // Extract prices
    const kYes = km.yes_bid ? km.yes_bid / 100 : null;
    const kAsk = km.yes_ask ? km.yes_ask / 100 : null;
    
    let pYes = null;
    try {
      const prices = typeof bestPm.outcomePrices === 'string' ? JSON.parse(bestPm.outcomePrices) : bestPm.outcomePrices;
      pYes = parseFloat(prices?.[0]) || null;
    } catch {}

    if (kYes == null || pYes == null) continue;

    const diff = +(kYes - pYes).toFixed(4);
    const absDiff = Math.abs(diff);
    const minP = Math.min(kYes, pYes);

    results.push({
      eventScore: 0, // filled in by caller
      marketScore: +bestScore.toFixed(3),
      combined: 0, // filled in by caller
      kalshi: {
        event: null, // filled by caller
        eventTicker: km.event_ticker,
        title: (km.title || '').slice(0, 120),
        ticker: km.ticker,
        yesPrice: kYes,
        askPrice: kAsk,
        volume: km.volume || 0,
      },
      poly: {
        event: null,
        title: (bestPm.question || '').slice(0, 120),
        slug: bestPm.slug,
        yesPrice: pYes,
        volume24h: parseFloat(bestPm.volume24hr) || 0,
        liquidity: parseFloat(bestPm.liquidityClob || bestPm.liquidity) || 0,
      },
      diff,
      absDiff: +absDiff.toFixed(4),
      pct: minP > 0.001 ? +((absDiff / minP) * 100).toFixed(1) : 999,
      signal: diff > 0.03 ? 'POLY_CHEAP' : diff < -0.03 ? 'POLY_EXPENSIVE' : 'ALIGNED',
    });
  }

  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== PMXT v2.0 — Cross-Platform Scanner ===\n');
  const t0 = Date.now();

  const cache = loadCache();
  const cachedN = Object.keys(cache).length;
  if (cachedN) console.log(`[CACHE] ${cachedN} entries loaded`);

  // Fetch data from both platforms
  const [kEvents, pEvents] = await Promise.all([
    fetchKalshiEvents(),
    fetchPolymarketEvents(),
  ]);

  // Layer 1: Match events
  console.log('[MATCH] Layer 1: event matching...');
  const eventPairs = matchEvents(kEvents, pEvents, cache);
  const uncached = eventPairs.filter(p => !p.cached);
  console.log(`[MATCH] ${eventPairs.length} event pairs (${uncached.length} new, ${eventPairs.length - uncached.length} cached)`);

  // Layer 2: For top event pairs, fetch Kalshi market details and match outcomes
  console.log('[MATCH] Layer 2: outcome matching...');
  const allMatches = [];
  const TOP_PAIRS = 100; // Top 100 event matches for broader coverage
  let kMarketsChecked = 0;

  for (let i = 0; i < Math.min(eventPairs.length, TOP_PAIRS); i++) {
    const { ke, pe, score: evtScore } = eventPairs[i];
    
    if (i > 0 && i % 20 === 0) console.log(`  Progress: ${i}/${Math.min(eventPairs.length, TOP_PAIRS)}`);

    let kMarkets;
    try {
      kMarkets = await fetchKalshiMarkets(ke.event_ticker);
      kMarketsChecked++;
    } catch { continue; }
    if (!kMarkets.length) continue;

    const matches = matchMarketsInEvent(kMarkets, pe);
    for (const m of matches) {
      m.eventScore = +evtScore.toFixed(3);
      m.combined = +((evtScore + m.marketScore) / 2).toFixed(3);
      m.kalshi.event = (ke.title || '').slice(0, 100);
      m.poly.event = (pe.title || '').slice(0, 100);
      allMatches.push(m);
    }

    await sleep(150);
  }

  saveCache(cache);

  // Deduplicate
  const seen = new Map();
  for (const m of allMatches) {
    const key = `${m.kalshi.ticker}|${m.poly.slug}`;
    if (!seen.has(key) || m.combined > seen.get(key).combined) seen.set(key, m);
  }
  const pairs = [...seen.values()].sort((a, b) => b.absDiff - a.absDiff);

  const signals = pairs.filter(m => m.absDiff >= 0.05 && m.combined >= 0.45);
  const aligned = pairs.filter(m => m.absDiff < 0.05 && m.combined >= 0.45);

  const output = {
    timestamp: new Date().toISOString(),
    runtime: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    stats: {
      kalshiEvents: kEvents.length,
      polyEvents: pEvents.length,
      eventPairs: eventPairs.length,
      kMarketsChecked,
      totalPairs: pairs.length,
      signals: signals.length,
      aligned: aligned.length,
    },
    signals: signals.slice(0, 30),
    aligned: aligned.slice(0, 30),
    all: pairs.slice(0, 100),
  };
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  // Console output
  console.log(`\n=== PMXT v2.0 Results ===`);
  console.log(`Runtime:       ${output.runtime}`);
  console.log(`Kalshi events: ${kEvents.length}`);
  console.log(`Poly events:   ${pEvents.length}`);
  console.log(`Event pairs:   ${eventPairs.length}`);
  console.log(`Markets checked: ${kMarketsChecked}`);
  console.log(`Outcome pairs: ${pairs.length}`);
  console.log(`Signals (>5%): ${signals.length}`);
  console.log(`Aligned (<5%): ${aligned.length}`);

  if (signals.length > 0) {
    console.log(`\n🔔 Signals:`);
    for (const s of signals.slice(0, 15)) {
      const a = s.signal === 'POLY_CHEAP' ? '📈' : '📉';
      console.log(`  ${a} ${s.pct}% ${s.signal} | conf:${s.combined} (evt:${s.eventScore} mkt:${s.marketScore})`);
      console.log(`     K: ${s.kalshi.title?.slice(0, 70)} → ${s.kalshi.yesPrice}`);
      console.log(`     P: ${s.poly.title?.slice(0, 70)} → ${s.poly.yesPrice}`);
    }
  }

  if (aligned.length > 0) {
    console.log(`\n✅ Aligned (validated cross-platform pairs):`);
    for (const a of aligned.slice(0, 10)) {
      console.log(`  ${(a.diff*100).toFixed(1)}¢ diff | conf:${a.combined}`);
      console.log(`     K: ${a.kalshi.title?.slice(0, 60)} → ${a.kalshi.yesPrice}`);
      console.log(`     P: ${a.poly.title?.slice(0, 60)} → ${a.poly.yesPrice}`);
    }
  }

  console.log(`\nOutput: ${OUTPUT_FILE}`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
