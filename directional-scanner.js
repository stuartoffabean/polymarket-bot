#!/usr/bin/env node
/**
 * Directional Market Scanner v2.0 — Paper Trade Mode
 * 
 * Scans Polymarket for event-driven directional opportunities.
 * Uses ClawPod (Massive Unblocker) for deep research on each candidate.
 * Outputs structured JSON for Claude cron agent to evaluate and paper-trade.
 * 
 * Pipeline:
 *   1. Discover active markets from Gamma API
 *   2. Filter to actionable candidates (resolution <72h, sufficient liquidity)
 *   3. Fetch real orderbook prices from CLOB API
 *   4. ClawPod deep research: full articles, Polymarket activity, related data
 *   5. Output structured opportunities for thesis evaluation
 * 
 * Usage: node directional-scanner.js [--min-volume 1000] [--max-hours 72]
 * 
 * PAPER TRADE ONLY — logs to directional-paper.json, never places orders.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
const PAPER_FILE = path.join(ROOT, 'directional-paper.json');
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const MIN_VOLUME = parseInt(process.env.MIN_VOLUME || '1000');
const MAX_HOURS = parseInt(process.env.MAX_HOURS || '72');
const PAPER_TRADE_SIZE = parseFloat(process.env.PAPER_TRADE_SIZE || '10');

// ClawPod / Massive Unblocker
const MASSIVE_TOKEN = process.env.MASSIVE_UNBLOCKER_TOKEN || '';
const UNBLOCKER_API = 'https://unblocker.joinmassive.com/browser';

// External API keys
const NEWSAPI_KEY = process.env.NEWSAPI_KEY || '';
const ODDSBLAZE_KEY = process.env.ODDSBLAZE_KEY || '';

// Import enrichment module (OddsBlaze, Congress, LMSYS, FRED, Metaculus)
let enrichMarket = null;
try {
  const enrichment = require('./enrichment');
  enrichMarket = enrichment.enrichMarket;
  console.log('[INIT] Enrichment module loaded (OddsBlaze, Congress, LMSYS, FRED, Metaculus)');
} catch (e) {
  console.log(`[INIT] Enrichment module not available: ${e.message}`);
}

// Import research memory (vector-backed knowledge store)
let ResearchMemory = null;
let researchMemory = null;
try {
  ResearchMemory = require('./research-memory').ResearchMemory;
  researchMemory = new ResearchMemory();
  const stats = researchMemory.stats();
  console.log(`[INIT] Research memory loaded (${stats.totalEntries} entries, ${stats.activeEntries} active)`);
} catch (e) {
  console.log(`[INIT] Research memory not available: ${e.message}`);
}

// Categories to SKIP (we have separate scanners for these)
const SKIP_CATEGORIES = ['weather', 'temperature', 'highest temp', 'crypto binary', 'bitcoin up or down', 'ethereum up or down'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpGet(url, timeoutMs = 15000, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const req = mod.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'DirectionalScanner/2.0', ...headers },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const req = mod.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'DirectionalScanner/2.0', 'Accept': 'application/json' },
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
// CLAWPOD RESEARCH
// ═══════════════════════════════════════════════════════════════

let NodeHtmlMarkdown = null;
try {
  const nhm = require('node-html-markdown');
  NodeHtmlMarkdown = nhm.NodeHtmlMarkdown;
} catch { }
// Try global node_modules too
if (!NodeHtmlMarkdown) {
  try {
    const nhm = require('/data/workspace/node_modules/node-html-markdown');
    NodeHtmlMarkdown = nhm.NodeHtmlMarkdown;
  } catch { }
}

function htmlToMarkdown(html) {
  if (!NodeHtmlMarkdown) return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  try { return NodeHtmlMarkdown.translate(html); } 
  catch { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
}

async function clawpodFetch(url, maxChars = 3000) {
  if (!MASSIVE_TOKEN) return null;
  try {
    const params = new URLSearchParams({ url, format: 'rendered', expiration: '0' });
    const apiUrl = `${UNBLOCKER_API}?${params.toString()}`;
    const resp = await httpGet(apiUrl, 120000, { 'Authorization': `Bearer ${MASSIVE_TOKEN}` });
    if (resp.status !== 200) return null;
    const md = htmlToMarkdown(resp.data);
    return md.slice(0, maxChars);
  } catch (e) {
    console.log(`   ⚠️ ClawPod fetch failed for ${url}: ${e.message}`);
    return null;
  }
}

/**
 * Deep research a market question using multiple sources.
 * Returns structured research context for Claude to evaluate.
 */
async function researchMarket(question, eventTitle, slug) {
  const research = {
    question,
    sources: [],
    newsHeadlines: [],
    fullArticles: [],
    polymarketContext: null,
    sportsbookOdds: null,
    searchResults: [],
  };

  // 1. Google News via ClawPod (JS-rendered, gets real headlines)
  const searchQuery = encodeURIComponent(question.replace(/\?/g, '').slice(0, 80));
  console.log(`   📰 Researching: "${question.slice(0, 60)}..."`);
  
  // 1. NewsAPI for structured headlines (fast, free, reliable)
  if (NEWSAPI_KEY) {
    try {
      const newsUrl = `https://newsapi.org/v2/everything?q=${searchQuery}&apiKey=${NEWSAPI_KEY}&pageSize=5&language=en&sortBy=publishedAt`;
      const newsResp = await httpGetJson(newsUrl, 10000);
      if (newsResp.articles && newsResp.articles.length > 0) {
        research.sources.push('newsapi');
        for (const a of newsResp.articles.slice(0, 5)) {
          research.newsHeadlines.push(`[${a.publishedAt?.slice(0,10)}] ${a.title}`);
          if (a.description) research.fullArticles.push({ title: a.title, text: a.description, source: a.source?.name });
        }
      }
    } catch (e) {
      console.log(`   ⚠️ NewsAPI failed: ${e.message}`);
    }
    await sleep(200);
  }

  // 2. ClawPod: fetch full article from top news source (deep research)
  if (MASSIVE_TOKEN && research.fullArticles.length > 0 && research.fullArticles[0].source) {
    // Search for the specific topic on a major news aggregator
    const topicSearch = encodeURIComponent(question.replace(/\?/g, '').slice(0, 60));
    const bingNews = await clawpodFetch(`https://www.bing.com/news/search?q=${topicSearch}`, 4000);
    if (bingNews) {
      research.sources.push('bing-news');
      // Extract meaningful text (not nav/boilerplate)
      const lines = bingNews.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 40 && l.length < 500 
          && !l.startsWith('[') && !l.startsWith('!')  && !l.startsWith('#')
          && !l.includes('cookie') && !l.includes('privacy') && !l.includes('Sign in'));
      if (lines.length > 0) {
        research.fullArticles.push({ title: 'Bing News results', text: lines.slice(0, 10).join('\n'), source: 'bing' });
      }
    }
    await sleep(500);
  }

  // 3. ClawPod: If no NewsAPI results, try Bing News directly as primary
  if (MASSIVE_TOKEN && research.newsHeadlines.length === 0) {
    const topicSearch = encodeURIComponent(question.replace(/\?/g, '').slice(0, 60));
    const bingNews = await clawpodFetch(`https://www.bing.com/news/search?q=${topicSearch}`, 4000);
    if (bingNews) {
      research.sources.push('bing-news-primary');
      const lines = bingNews.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 30 && l.length < 300 && !l.startsWith('[') && !l.startsWith('!'));
      research.newsHeadlines = lines.slice(0, 10);
    }
    await sleep(500);
  }

  // 4. Polymarket event page context (via ClawPod — gets comments, volume, activity)
  if (MASSIVE_TOKEN && slug) {
    const pmPage = await clawpodFetch(`https://polymarket.com/event/${slug}`, 3000);
    if (pmPage) {
      research.sources.push('polymarket-page');
      research.polymarketContext = pmPage.slice(0, 2000);
    }
    await sleep(500);
  }

  // 5. Enrichment module: OddsBlaze, Congress.gov, LMSYS, FRED, Metaculus
  // Auto-detects which sources apply based on market question
  if (enrichMarket) {
    try {
      const enrichments = await enrichMarket(question);
      if (enrichments) {
        if (enrichments.odds) {
          research.sources.push('oddsblaze');
          research.sportsbookOdds = enrichments.odds;
        }
        if (enrichments.congress) {
          research.sources.push('congress.gov');
          research.congressData = enrichments.congress;
        }
        if (enrichments.lmsys) {
          research.sources.push('lmsys');
          research.lmsysData = enrichments.lmsys;
        }
        if (enrichments.fred) {
          research.sources.push('fred');
          research.fredData = enrichments.fred;
        }
        if (enrichments.metaculus) {
          research.sources.push('metaculus');
          research.metaculusData = enrichments.metaculus;
        }
        if (enrichments.news) {
          research.sources.push('newsapi-enrichment');
          // Merge any extra headlines from enrichment NewsAPI
          if (enrichments.news.headlines) {
            research.newsHeadlines.push(...enrichments.news.headlines.slice(0, 5));
          }
        }
      }
    } catch (e) {
      console.log(`   ⚠️ Enrichment module failed: ${e.message}`);
    }
  }

  return research;
}

function detectCategory(q) {
  const lower = q.toLowerCase();
  if (isSportsQuestion(lower)) return 'sports';
  if (/\b(congress|senate|house|bill|legislation|government|shutdown|impeach|election|vote|democrat|republican)\b/i.test(q)) return 'politics';
  if (/\b(bitcoin|btc|ethereum|eth|crypto|solana|sol|xrp)\b/i.test(q)) return 'crypto';
  if (/\b(gpt|claude|gemini|llama|ai model|lmsys|chatbot|anthropic|openai)\b/i.test(q)) return 'ai';
  if (/\b(gdp|cpi|inflation|fed|interest rate|unemployment|jobs|payroll)\b/i.test(q)) return 'economics';
  return 'other';
}

function isSportsQuestion(q) {
  const sports = ['nba', 'nfl', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball', 'hockey', 
    'tennis', 'golf', 'ufc', 'boxing', 'f1', 'formula', 'premier league', 'champions league',
    'super bowl', 'world series', 'stanley cup', 'mvp', 'championship', 'playoffs', 'olympics'];
  const lower = q.toLowerCase();
  return sports.some(s => lower.includes(s));
}

function detectSport(q) {
  const lower = q.toLowerCase();
  if (lower.includes('nba') || lower.includes('basketball')) return 'nba';
  if (lower.includes('nfl') || lower.includes('football') || lower.includes('super bowl')) return 'nfl';
  if (lower.includes('mlb') || lower.includes('baseball')) return 'mlb';
  if (lower.includes('nhl') || lower.includes('hockey')) return 'nhl';
  if (lower.includes('ufc') || lower.includes('mma')) return 'mma';
  if (lower.includes('soccer') || lower.includes('premier league')) return 'soccer';
  return null;
}

// ═══════════════════════════════════════════════════════════════
// MARKET DISCOVERY
// ═══════════════════════════════════════════════════════════════

async function discoverMarkets() {
  const now = new Date();
  const allMarkets = [];
  
  // Fetch from multiple Gamma endpoints for broad coverage
  const queries = [
    `${GAMMA}/events?limit=100&active=true&closed=false&order=volume24hr&ascending=false`,
    `${GAMMA}/events?limit=100&active=true&closed=false&order=startDate&ascending=false`,
    `${GAMMA}/markets?limit=200&active=true&closed=false&order=volume24hr&ascending=false`,
  ];

  for (const url of queries) {
    try {
      const data = await httpGetJson(url, 15000);
      const items = Array.isArray(data) ? data : [];
      
      for (const item of items) {
        // Events have nested markets
        if (item.markets) {
          for (const m of item.markets) {
            m._eventTitle = item.title;
            m._eventSlug = item.slug;
            allMarkets.push(m);
          }
        } else {
          allMarkets.push(item);
        }
      }
      await sleep(300);
    } catch (e) {
      console.log(`⚠️ Gamma query failed: ${e.message}`);
    }
  }

  // Deduplicate by conditionId
  const seen = new Set();
  const unique = [];
  for (const m of allMarkets) {
    const id = m.conditionId || m.id;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(m);
  }

  // Filter
  const filtered = unique.filter(m => {
    const q = (m.question || m.groupItemTitle || '').toLowerCase();
    
    // Skip categories we handle separately
    if (SKIP_CATEGORIES.some(cat => q.includes(cat))) return false;
    
    // Must have a question
    if (!q || q.length < 10) return false;
    
    // Check resolution time
    const endDate = m.endDate || m.end_date_iso;
    if (endDate) {
      const hours = (new Date(endDate) - now) / (1000 * 60 * 60);
      if (hours < 0 || hours > MAX_HOURS) return false;
      m._hoursToResolution = hours;
    }
    
    // Minimum volume
    const vol = parseFloat(m.volume24hr || m.volume || 0);
    if (vol < MIN_VOLUME) return false;
    m._volume = vol;

    // Skip markets where YES price is basically 0 or 1 (already resolved / no edge)
    try {
      const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      const yesPrice = parseFloat(prices?.[0]) || 0.5;
      if (yesPrice < 0.03 || yesPrice > 0.97) return false; // Already decided
    } catch { }

    return true;
  });

  // Sort by volume descending
  filtered.sort((a, b) => (b._volume || 0) - (a._volume || 0));

  console.log(`📊 Discovered ${unique.length} unique markets, ${filtered.length} pass filters (vol>$${MIN_VOLUME}, <${MAX_HOURS}h resolution)`);
  return filtered;
}

// ═══════════════════════════════════════════════════════════════
// ORDERBOOK PRICES
// ═══════════════════════════════════════════════════════════════

async function fetchOrderbook(market) {
  let yesToken = null, noToken = null;
  try {
    const tokens = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
    yesToken = tokens?.[0];
    noToken = tokens?.[1];
  } catch { }
  
  if (!yesToken) return null;

  const book = { yesAsk: null, yesBid: null, noAsk: null, noBid: null, yesDepth: 0, noDepth: 0 };
  
  try {
    const yesBook = await httpGetJson(`${CLOB}/book?token_id=${encodeURIComponent(yesToken)}`, 5000);
    const asks = (yesBook.asks || []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    const bids = (yesBook.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    if (asks.length > 0) { book.yesAsk = parseFloat(asks[0].price); book.yesDepth = parseFloat(asks[0].size); }
    if (bids.length > 0) { book.yesBid = parseFloat(bids[0].price); }
  } catch { }

  await sleep(100);

  if (noToken) {
    try {
      const noBook = await httpGetJson(`${CLOB}/book?token_id=${encodeURIComponent(noToken)}`, 5000);
      const asks = (noBook.asks || []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
      const bids = (noBook.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
      if (asks.length > 0) { book.noAsk = parseFloat(asks[0].price); book.noDepth = parseFloat(asks[0].size); }
      if (bids.length > 0) { book.noBid = parseFloat(bids[0].price); }
    } catch { }
  }

  return { ...book, yesToken, noToken };
}

// ═══════════════════════════════════════════════════════════════
// PAPER TRADE LOGGING
// ═══════════════════════════════════════════════════════════════

function loadPaperLog() {
  try { return JSON.parse(fs.readFileSync(PAPER_FILE, 'utf8')); }
  catch { return { scans: [], paperTrades: [] }; }
}

function savePaperLog(log) {
  fs.writeFileSync(PAPER_FILE, JSON.stringify(log, null, 2));
}

// ═══════════════════════════════════════════════════════════════
// MAIN SCAN
// ═══════════════════════════════════════════════════════════════

async function runScan() {
  console.log('🔍 Directional Scanner v2.0 starting...');
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   Filters: volume>$${MIN_VOLUME}, resolution<${MAX_HOURS}h`);
  console.log(`   Research: ClawPod=${MASSIVE_TOKEN ? 'YES' : 'NO'}, NewsAPI=${NEWSAPI_KEY ? 'YES' : 'NO'}, OddsBlaze=${ODDSBLAZE_KEY ? 'YES' : 'NO'}\n`);

  const markets = await discoverMarkets();
  
  // Limit deep research to top 20 by volume (ClawPod credits are limited)
  const researchLimit = Math.min(markets.length, 20);
  const candidates = [];

  for (let i = 0; i < researchLimit; i++) {
    const market = markets[i];
    const question = market.question || market.groupItemTitle || '';
    const slug = market._eventSlug || market.slug;

    console.log(`\n[${i+1}/${researchLimit}] ${question.slice(0, 70)}...`);
    
    // Check research memory for prior context on this market
    let priorResearch = [];
    if (researchMemory) {
      try {
        const category = detectCategory(question);
        priorResearch = await researchMemory.retrieve(question, {
          maxResults: 3,
          maxAgeHours: 48,
          marketId: market.conditionId,
          category,
        });
        if (priorResearch.length > 0) {
          console.log(`   🧠 Prior research: ${priorResearch.length} entries (newest ${priorResearch[0].hoursAgo}h ago)`);
        }
      } catch (e) {
        console.log(`   ⚠️ Memory retrieval failed: ${e.message}`);
      }
    }

    // Fetch real orderbook
    const orderbook = await fetchOrderbook(market);
    if (!orderbook || (!orderbook.yesAsk && !orderbook.yesBid)) {
      console.log('   ⏭️ No orderbook data, skipping');
      continue;
    }

    // Get current prices
    let gammaMid = 0.5;
    try {
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      gammaMid = parseFloat(prices?.[0]) || 0.5;
    } catch { }

    // Deep research via ClawPod + NewsAPI + OddsBlaze
    const research = await researchMarket(question, market._eventTitle, slug);

    candidates.push({
      question,
      eventTitle: market._eventTitle || '',
      conditionId: market.conditionId,
      slug,
      hoursToResolution: Math.round(market._hoursToResolution || 0),
      endDate: market.endDate || null,
      volume24h: market._volume,
      gammaMid,
      orderbook: {
        yesAsk: orderbook.yesAsk,
        yesBid: orderbook.yesBid,
        noAsk: orderbook.noAsk,
        noBid: orderbook.noBid,
        yesDepth: orderbook.yesDepth,
        noDepth: orderbook.noDepth,
      },
      yesToken: orderbook.yesToken,
      noToken: orderbook.noToken,
      research: {
        sources: research.sources,
        headlines: research.newsHeadlines.slice(0, 10),
        articles: research.fullArticles.slice(0, 3),
        sportsbookOdds: research.sportsbookOdds,
        congressData: research.congressData || null,
        lmsysData: research.lmsysData || null,
        fredData: research.fredData || null,
        metaculusData: research.metaculusData || null,
        polymarketContext: research.polymarketContext ? research.polymarketContext.slice(0, 500) : null,
      },
      // Prior research from memory (context from previous scans)
      priorResearch: priorResearch.map(pr => ({
        hoursAgo: pr.hoursAgo,
        facts: pr.facts,
        sources: pr.sources,
        pricesAtTime: pr.prices,
        score: pr.score,
      })),
    });

    // Store research in memory for future scans
    if (researchMemory && research.sources.length > 0) {
      try {
        // Extract clean facts from headlines + articles (raw data only, no theses)
        const facts = [
          ...research.newsHeadlines.filter(h => h.length > 20).slice(0, 5),
          ...research.fullArticles.map(a => `${a.source}: ${a.text.slice(0, 200)}`).slice(0, 3),
        ];
        if (research.sportsbookOdds) facts.push(`Sportsbook odds: ${JSON.stringify(research.sportsbookOdds).slice(0, 200)}`);
        if (research.congressData) facts.push(`Congress: ${JSON.stringify(research.congressData).slice(0, 200)}`);
        if (research.lmsysData) facts.push(`LMSYS: ${JSON.stringify(research.lmsysData).slice(0, 200)}`);
        if (research.fredData) facts.push(`FRED: ${JSON.stringify(research.fredData).slice(0, 200)}`);
        
        if (facts.length > 0) {
          await researchMemory.store({
            marketId: market.conditionId,
            question,
            category: detectCategory(question),
            facts,
            sources: research.sources,
            complete: research.sources.length >= 2,
            prices: {
              yesAsk: orderbook.yesAsk,
              noAsk: orderbook.noAsk,
              gammaMid,
            },
            hoursToResolution: Math.round(market._hoursToResolution || 0),
            endDate: market.endDate || null,
          });
          console.log(`   💾 Stored ${facts.length} facts in research memory`);
        }
      } catch (e) {
        console.log(`   ⚠️ Memory store failed: ${e.message}`);
      }
    }

    await sleep(300);
  }

  // Save scan results
  const paperLog = loadPaperLog();
  paperLog.scans.push({
    timestamp: new Date().toISOString(),
    marketsDiscovered: markets.length,
    candidatesResearched: candidates.length,
  });
  savePaperLog(paperLog);

  // Output for Claude cron agent
  const output = {
    scanTime: new Date().toISOString(),
    totalMarkets: markets.length,
    candidates: candidates.length,
    markets: candidates,
  };

  // Write candidates to file for cron agent
  fs.writeFileSync(path.join(ROOT, 'directional-candidates.json'), JSON.stringify(output, null, 2));
  
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📋 SCAN COMPLETE: ${candidates.length} candidates with research`);
  console.log(`   Markets discovered: ${markets.length}`);
  console.log(`   Research sources used: ${[...new Set(candidates.flatMap(c => c.research.sources))].join(', ')}`);
  if (researchMemory) {
    const mstats = researchMemory.stats();
    console.log(`   Research memory: ${mstats.totalEntries} entries (${mstats.activeEntries} active, ${mstats.resolvedEntries} resolved)`);
  }
  console.log(`   Output: directional-candidates.json`);
  
  // Print summary of each candidate
  for (const c of candidates) {
    const yesPrice = c.orderbook.yesAsk || c.gammaMid;
    console.log(`\n   📊 ${c.question.slice(0, 65)}`);
    console.log(`      YES: ${(yesPrice * 100).toFixed(0)}¢ | Volume: $${c.volume24h.toLocaleString()} | ${c.hoursToResolution}h left`);
    console.log(`      Research: ${c.research.sources.join(', ')} | Headlines: ${c.research.headlines.length}`);
  }

  return output;
}

// ═══════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════

if (require.main === module) {
  runScan().then(result => {
    console.log(`\n✅ Done. ${result.candidates} candidates written to directional-candidates.json`);
    process.exit(0);
  }).catch(err => {
    console.error('❌ Fatal:', err);
    process.exit(1);
  });
}

module.exports = { runScan, researchMarket, discoverMarkets };
