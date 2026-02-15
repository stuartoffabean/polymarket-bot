#!/usr/bin/env node
/**
 * Event Momentum Scanner v1.0
 * Scans Polymarket for event-driven opportunities with news catalysts.
 * 
 * Runs every 2 hours (configurable via EVENT_SCAN_INTERVAL_MS).
 * Writes opportunities to OPPORTUNITIES.json, alerts via Telegram for score >= 7.
 * Health check on port 3004.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const ROOT = path.resolve(__dirname);
const OPPS_FILE = path.join(ROOT, 'OPPORTUNITIES.json');
const LOG_FILE = path.join(ROOT, 'event-scanner-log.json');
const PORT = parseInt(process.env.EVENT_SCANNER_PORT || '3004');
const SCAN_INTERVAL = parseInt(process.env.EVENT_SCAN_INTERVAL_MS || String(2 * 60 * 60 * 1000)); // 2h
const GAMMA = 'https://gamma-api.polymarket.com';
const MIN_EDGE = parseFloat(process.env.EVENT_SCANNER_MIN_EDGE || '0.10');
const MIN_SCORE = parseInt(process.env.EVENT_SCANNER_MIN_SCORE || '6');
const ALERT_SCORE = parseInt(process.env.EVENT_SCANNER_ALERT_SCORE || '7');

// Google Trends integration
const TRENDS_ENABLED = true;
const TRENDS_EXPLORE = 'https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=420&geo=US&ns=15';

async function fetchGoogleTrends(query) {
  try {
    // Use Google Trends "Related queries" via the explore widget JSON endpoint
    const encoded = encodeURIComponent(query);
    const url = `https://trends.google.com/trends/api/explore?hl=en-US&tz=420&req=${encodeURIComponent(JSON.stringify({comparisonItem:[{keyword:query,geo:'US',time:'now 1-d'}],category:0,property:''}))}`;
    const r = await httpGet(url, 10000);
    if (r.status !== 200) return { score: 0, rising: false };
    // Trends API returns ")]}'\n" prefix — strip it
    const clean = r.data.replace(/^\)\]\}',?\n/, '');
    const json = JSON.parse(clean);
    // Extract the interest-over-time token if available
    const widgets = json.widgets || [];
    const iotWidget = widgets.find(w => w.id === 'TIMESERIES');
    if (!iotWidget || !iotWidget.token) return { score: 0, rising: false };

    // Fetch the actual timeseries
    const tsUrl = `https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=420&req=${encodeURIComponent(JSON.stringify(iotWidget.request))}&token=${iotWidget.token}`;
    await sleep(500);
    const tsR = await httpGet(tsUrl, 10000);
    if (tsR.status !== 200) return { score: 0, rising: false };
    const tsClean = tsR.data.replace(/^\)\]\}',?\n/, '');
    const tsJson = JSON.parse(tsClean);
    const points = tsJson?.default?.timelineData || [];
    if (points.length < 4) return { score: 0, rising: false };

    // Get last 6 hours vs previous 6 hours
    const values = points.map(p => (p.value || [0])[0]);
    const recent = values.slice(-6);
    const prior = values.slice(-12, -6);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const priorAvg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
    const spike = priorAvg > 0 ? recentAvg / priorAvg : (recentAvg > 20 ? 3 : 1);
    const peak = Math.max(...values);

    return {
      score: peak,              // 0-100 relative interest
      recentAvg: Math.round(recentAvg),
      priorAvg: Math.round(priorAvg),
      spikeRatio: +spike.toFixed(2),  // >2 = significant spike
      rising: spike >= 1.5 && recentAvg >= 20,
      breakout: spike >= 3 && recentAvg >= 40,
    };
  } catch (e) {
    console.error(`[TRENDS] Failed for "${query}":`, e.message);
    return { score: 0, rising: false };
  }
}

// External data enrichment
const { enrichMarket, adjustEdgeFromEnrichment } = require('./enrichment');

// Sentiment keywords
const POSITIVE_SIGNALS = ['confirmed', 'approved', 'passed', 'signed', 'won', 'elected', 'achieved',
  'completed', 'resolved', 'agreed', 'breakthrough', 'victory', 'success', 'announces', 'officially',
  'unanimous', 'landslide', 'certain', 'inevitable', 'guaranteed', 'deal reached', 'finaliz'];
const NEGATIVE_SIGNALS = ['rejected', 'failed', 'denied', 'collapsed', 'cancelled', 'postponed',
  'unlikely', 'impossible', 'stalled', 'blocked', 'vetoed', 'defeated', 'abandoned', 'withdrawn'];

let lastScanAt = null;
let lastScanResults = null;
let scanCount = 0;

// ── Utility ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'PolymarketScanner/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sendTelegramAlert(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_notification: false });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, () => {});
  req.on('error', () => {});
  req.write(payload);
  req.end();
}

function loadJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return []; }
}

function saveJson(fp, data) {
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, fp);
}

function appendLog(entry) {
  const log = loadJson(LOG_FILE);
  log.push(entry);
  // Keep last 500 entries
  if (log.length > 500) log.splice(0, log.length - 500);
  saveJson(LOG_FILE, log);
}

// ── Step 1: Market Discovery ─────────────────────────────────────────────────

async function discoverMarkets() {
  const markets = new Map(); // conditionId -> market

  // Fetch trending (top by 24h volume)
  try {
    const r = await httpGet(`${GAMMA}/events?active=true&closed=false&limit=100&order=volume24hr&ascending=false`);
    const events = JSON.parse(r.data);
    for (const ev of events) {
      for (const m of (ev.markets || [])) {
        if (m.active && !m.closed && m.conditionId) {
          m._eventTitle = ev.title;
          m._eventSlug = ev.slug;
          m._source = 'trending';
          markets.set(m.conditionId, m);
        }
      }
    }
    console.log(`[DISCOVER] Trending: ${events.length} events, ${markets.size} markets`);
  } catch (e) {
    console.error('[DISCOVER] Trending fetch failed:', e.message);
  }

  // Fetch recently created (by startDate descending = newest first)
  try {
    await sleep(500);
    const r = await httpGet(`${GAMMA}/events?active=true&closed=false&limit=50&order=startDate&ascending=false`);
    const events = JSON.parse(r.data);
    let added = 0;
    for (const ev of events) {
      for (const m of (ev.markets || [])) {
        if (m.active && !m.closed && m.conditionId && !markets.has(m.conditionId)) {
          m._eventTitle = ev.title;
          m._eventSlug = ev.slug;
          m._source = 'new';
          markets.set(m.conditionId, m);
          added++;
        }
      }
    }
    console.log(`[DISCOVER] New markets: +${added}`);
  } catch (e) {
    console.error('[DISCOVER] New markets fetch failed:', e.message);
  }

  // Filter by resolution time
  const now = Date.now();
  const maxMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  const filtered = [];
  for (const m of markets.values()) {
    const endDate = m.endDate ? new Date(m.endDate).getTime() : null;
    if (!endDate) { filtered.push(m); continue; } // Include if no end date (may resolve anytime)
    const hoursToRes = (endDate - now) / (1000 * 60 * 60);
    if (hoursToRes > 0 && hoursToRes <= 7 * 24) {
      m._hoursToResolution = hoursToRes;
      filtered.push(m);
    }
  }

  // Sort by volume descending so we scan most liquid markets first
  filtered.sort((a, b) => parseFloat(b.volume24hr || b.volume || 0) - parseFloat(a.volume24hr || a.volume || 0));
  console.log(`[DISCOVER] After time filter: ${filtered.length} markets (from ${markets.size})`);
  return filtered;
}

// ── Step 2: News Matching via Google News RSS ────────────────────────────────

function extractSearchTerms(question) {
  // Remove common filler words and extract meaningful terms
  const stopWords = new Set(['will', 'the', 'be', 'in', 'on', 'at', 'to', 'a', 'an', 'is', 'of',
    'for', 'by', 'or', 'and', 'this', 'that', 'it', 'its', 'with', 'from', 'as', 'but', 'not',
    'no', 'yes', 'before', 'after', 'during', 'between', 'what', 'which', 'who', 'whom',
    'how', 'when', 'where', 'than', 'more', 'most', 'least', 'any', 'all', 'each', 'every',
    'do', 'does', 'did', 'has', 'have', 'had', 'was', 'were', 'been', 'being', 'are',
    'could', 'would', 'should', 'may', 'might', 'shall', 'can', 'if', 'then', 'else',
    'about', 'above', 'below', 'up', 'down', 'out', 'off', 'over', 'under', 'again',
    'into', 'through', 'against', 'win', 'reach', 'get', 'go']);
  
  const words = question.replace(/[?!.,;:'"()]/g, '').split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));
  
  // Take top 4-5 most meaningful words (longer words tend to be more meaningful)
  const sorted = words.sort((a, b) => b.length - a.length);
  return sorted.slice(0, 5).join(' ');
}

function parseRssXml(xml) {
  // Simple RSS parser — no dependency needed
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const desc = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
    items.push({
      title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
      link: link.trim(),
      pubDate: pubDate.trim(),
      description: desc.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim(),
    });
  }
  return items;
}

async function fetchNews(query) {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
    const r = await httpGet(url, 10000);
    if (r.status !== 200) return [];
    return parseRssXml(r.data);
  } catch (e) {
    console.error(`[NEWS] Failed for "${query}":`, e.message);
    return [];
  }
}

function analyzeNews(articles, question) {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  
  // Filter to recent articles
  const recent = articles.filter(a => {
    if (!a.pubDate) return true; // Include if no date
    const t = new Date(a.pubDate).getTime();
    return t > oneDayAgo;
  });

  // Sentiment analysis on combined text
  const allText = recent.map(a => `${a.title} ${a.description}`).join(' ').toLowerCase();
  
  let positiveCount = 0;
  let negativeCount = 0;
  const matchedPositive = [];
  const matchedNegative = [];
  
  for (const sig of POSITIVE_SIGNALS) {
    const count = (allText.match(new RegExp(sig, 'gi')) || []).length;
    if (count > 0) { positiveCount += count; matchedPositive.push(sig); }
  }
  for (const sig of NEGATIVE_SIGNALS) {
    const count = (allText.match(new RegExp(sig, 'gi')) || []).length;
    if (count > 0) { negativeCount += count; matchedNegative.push(sig); }
  }

  // Determine if news suggests YES or NO
  let impliedOutcome = null;
  let confidence = 0; // 0-1
  
  if (positiveCount > negativeCount && positiveCount >= 2) {
    impliedOutcome = 'Yes';
    confidence = Math.min(0.9, 0.5 + (positiveCount - negativeCount) * 0.1);
  } else if (negativeCount > positiveCount && negativeCount >= 2) {
    impliedOutcome = 'No';
    confidence = Math.min(0.9, 0.5 + (negativeCount - positiveCount) * 0.1);
  }

  return {
    totalArticles: articles.length,
    recentArticles: recent.length,
    positiveSignals: positiveCount,
    negativeSignals: negativeCount,
    matchedPositive,
    matchedNegative,
    impliedOutcome,
    confidence,
    spiking: recent.length >= 5, // 5+ articles in 24h = news spike
    sources: recent.slice(0, 5).map(a => a.link),
    topHeadlines: recent.slice(0, 3).map(a => a.title),
  };
}

// ── Step 3: Edge Detection ───────────────────────────────────────────────────

// ── Question-Relevance Check ─────────────────────────────────────────────────
// Detects when news sentiment answers a DIFFERENT question than the market asks.
// e.g., "US wins gold medals" (true) ≠ "US wins the MOST gold medals" (unlikely)

const SUPERLATIVE_PATTERNS = [
  { regex: /\b(the )?most\b/i, type: 'superlative' },
  { regex: /\bwin .*(championship|title|trophy|finals|series)\b/i, type: 'championship' },
  { regex: /\b(first|1st) (to|place)\b/i, type: 'ranking' },
  { regex: /\babove \$?[\d,]+\b/i, type: 'threshold' },
  { regex: /\bbelow \$?[\d,]+\b/i, type: 'threshold' },
  { regex: /\bbetween .* and\b/i, type: 'range' },
  { regex: /\bmore than\b/i, type: 'comparison' },
  { regex: /\bfewer than\b/i, type: 'comparison' },
  { regex: /\beat least\b/i, type: 'minimum' },
  { regex: /\bexactly\b/i, type: 'exact' },
  { regex: /\bhighest\b/i, type: 'superlative' },
  { regex: /\blowest\b/i, type: 'superlative' },
  { regex: /\bbest\b/i, type: 'superlative' },
  { regex: /\brecord\b/i, type: 'superlative' },
];

function checkQuestionRelevance(question, headlines) {
  const q = question.toLowerCase();
  
  // Detect if the market question has a superlative/comparative/threshold qualifier
  const matchedQualifiers = SUPERLATIVE_PATTERNS.filter(p => p.regex.test(q));
  if (matchedQualifiers.length === 0) return { relevant: true, penalty: 0 };
  
  // Check if any headline actually addresses the specific qualifier
  const headlineText = headlines.map(h => h.toLowerCase()).join(' ');
  const qualifierInNews = SUPERLATIVE_PATTERNS.some(p => p.regex.test(headlineText));
  
  // If market asks a superlative question but news just confirms the general topic
  // (e.g., "US wins golds" vs "Will US win the MOST golds"), the news isn't answering
  // the actual question. The news is irrelevant — treat confidence as if we have no signal.
  if (!qualifierInNews) {
    const types = matchedQualifiers.map(m => m.type);
    console.log(`[RELEVANCE] Question has qualifiers [${types.join(',')}] but news doesn't address them — REJECTING (news doesn't answer the question)`);
    return { relevant: false, reject: true, types };
  }
  
  return { relevant: true, penalty: 0 };
}

function detectEdge(market, news) {
  // Get current YES price
  let yesPrice = 0.5;
  try {
    const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    yesPrice = parseFloat(prices[0]) || 0.5;
  } catch { }

  if (!news.impliedOutcome || news.confidence < 0.5) {
    return null; // No clear signal
  }

  // Check if news actually answers the market question (not just the topic)
  const question = market.question || '';
  const relevance = checkQuestionRelevance(question, news.topHeadlines || []);
  
  if (!relevance.relevant && relevance.reject) {
    console.log(`[EDGE] REJECTED — news doesn't answer the specific question (qualifiers: ${relevance.types})`);
    return null; // No edge — news is about the topic but doesn't address the actual question
  }
  
  let adjustedConfidence = news.confidence;

  let estimatedProb, currentPrice, outcome;
  
  if (news.impliedOutcome === 'Yes') {
    outcome = 'Yes';
    currentPrice = yesPrice;
    estimatedProb = adjustedConfidence;
  } else {
    outcome = 'No';
    currentPrice = 1 - yesPrice;
    estimatedProb = adjustedConfidence;
  }

  // Boost confidence if news is spiking with strong signal
  if (news.spiking && news.recentArticles >= 8) {
    estimatedProb = Math.min(0.95, estimatedProb + 0.1);
  }

  const edge = estimatedProb - currentPrice;
  
  if (edge < MIN_EDGE) return null;

  return { outcome, currentPrice, estimatedProb, edge };
}

// ── Step 4: Quality Scoring ──────────────────────────────────────────────────

function scoreOpportunity(market, news, edge) {
  let score = 0;
  let reasons = [];

  // Catalyst clarity: 0-3
  if (news.spiking && news.recentArticles >= 8) {
    score += 3; reasons.push('catalyst:confirmed(3)');
  } else if (news.recentArticles >= 5) {
    score += 2; reasons.push('catalyst:strong(2)');
  } else if (news.recentArticles >= 2) {
    score += 1; reasons.push('catalyst:rumor(1)');
  }

  // Resolution time: 0-3
  const hrs = market._hoursToResolution || 999;
  if (hrs <= 24) {
    score += 3; reasons.push('time:<24h(3)');
  } else if (hrs <= 48) {
    score += 2; reasons.push('time:24-48h(2)');
  } else if (hrs <= 168) {
    score += 1; reasons.push('time:2-7d(1)');
  }

  // Edge size: 0-3
  if (edge.edge > 0.30) {
    score += 3; reasons.push(`edge:${(edge.edge*100).toFixed(0)}%(3)`);
  } else if (edge.edge > 0.20) {
    score += 2; reasons.push(`edge:${(edge.edge*100).toFixed(0)}%(2)`);
  } else if (edge.edge >= MIN_EDGE) {
    score += 1; reasons.push(`edge:${(edge.edge*100).toFixed(0)}%(1)`);
  }

  // Liquidity: 0-1
  const vol = parseFloat(market.volume24hr || market.volume || 0);
  if (vol >= 10000) {
    score += 1; reasons.push('liquid(1)');
  }

  // Google Trends momentum: 0-2
  const trends = news._trends || {};
  if (trends.breakout) {
    score += 2; reasons.push(`trends:breakout(2) spike=${trends.spikeRatio}x`);
  } else if (trends.rising) {
    score += 1; reasons.push(`trends:rising(1) spike=${trends.spikeRatio}x`);
  }

  return { score, reasons };
}

// ── Step 5: Full Scan ────────────────────────────────────────────────────────

async function runScan() {
  const scanStart = Date.now();
  scanCount++;
  console.log(`\n${'='.repeat(60)}\n[SCAN #${scanCount}] Starting at ${new Date().toISOString()}\n${'='.repeat(60)}`);

  let marketsScanned = 0, newsQueries = 0, oppsFound = 0;
  const newOpportunities = [];

  try {
    // Step 1: Discover
    const markets = await discoverMarkets();
    marketsScanned = markets.length;

    // Step 2-4: For each market, check news and score
    // Rate limit: ~1 request per 2 seconds for Google News
    for (const market of markets) {
      const question = market.question || market.groupItemTitle || '';
      if (!question) continue;

      const terms = extractSearchTerms(question);
      if (terms.length < 3) continue; // Too generic

      // Limit news queries to top 50 markets by volume to stay within rate limits
      if (newsQueries >= 50) break;

      await sleep(1500); // Rate limit Google News
      newsQueries++;
      
      if (newsQueries % 10 === 0) console.log(`[SCAN] Progress: ${newsQueries} news queries done...`);
      
      const articles = await fetchNews(terms);
      if (articles.length === 0) continue;

      const news = analyzeNews(articles, question);

      // Google Trends enrichment
      let trends = { score: 0, rising: false };
      if (TRENDS_ENABLED && news.recentArticles >= 2) {
        // Only query trends if we already have some news signal (saves rate limit)
        await sleep(1000);
        trends = await fetchGoogleTrends(terms);
        if (trends.rising) console.log(`[TRENDS] 📈 "${terms}" — spike ${trends.spikeRatio}x, score ${trends.score}`);
      }
      news._trends = trends;
      
      // Step 3: Edge detection
      const edge = detectEdge(market, news);
      if (!edge) continue;

      // Step 3.5: External data enrichment
      let enrichments = null;
      try {
        enrichments = await enrichMarket(question);
        if (enrichments) {
          const adj = adjustEdgeFromEnrichment(enrichments, edge.estimatedProb, edge.outcome);
          if (adj) {
            console.log(`[ENRICH] ${question.slice(0, 60)} — ${adj.reasons.join(', ')} (+${(adj.adjustment*100).toFixed(0)}%)`);
            edge.estimatedProb = adj.adjustedConfidence;
            edge.edge = edge.estimatedProb - edge.currentPrice;
            edge._enrichmentBoost = adj;
          }
        }
      } catch (e) {
        console.error('[ENRICH] Error:', e.message);
      }

      // Step 4: Scoring
      const { score, reasons } = scoreOpportunity(market, news, edge);
      if (score < MIN_SCORE) continue;

      // Get token IDs
      let yesTokenId = null, noTokenId = null;
      try {
        const tokens = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
        yesTokenId = tokens[0];
        noTokenId = tokens[1];
      } catch { }

      const tokenId = edge.outcome === 'Yes' ? yesTokenId : noTokenId;
      const vol = parseFloat(market.volume24hr || market.volume || 0);

      const opp = {
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        market: market.conditionId,
        tokenId,
        question,
        outcome: edge.outcome,
        currentPrice: +edge.currentPrice.toFixed(4),
        estimatedProb: +edge.estimatedProb.toFixed(4),
        edge: +edge.edge.toFixed(4),
        score,
        scoreBreakdown: reasons,
        catalyst: news.topHeadlines.slice(0, 2).join(' | '),
        sources: news.sources.slice(0, 3),
        resolution: market.endDate || null,
        hoursToResolution: +(market._hoursToResolution || 0).toFixed(1),
        volume24h: vol,
        eventTitle: market._eventTitle,
        eventSlug: market._eventSlug,
        scannedAt: new Date().toISOString(),
        status: 'pending',
        newsStats: {
          totalArticles: news.totalArticles,
          recentArticles: news.recentArticles,
          positiveSignals: news.positiveSignals,
          negativeSignals: news.negativeSignals,
          spiking: news.spiking,
        },
        trends: news._trends || null,
        enrichments: enrichments || null,
        enrichmentBoost: edge._enrichmentBoost || null,
      };

      newOpportunities.push(opp);
      oppsFound++;

      console.log(`\n🎯 OPPORTUNITY: ${question}`);
      console.log(`   Score: ${score}/10 [${reasons.join(', ')}]`);
      console.log(`   ${edge.outcome} @ ${edge.currentPrice.toFixed(2)} → est ${edge.estimatedProb.toFixed(2)} (edge ${(edge.edge*100).toFixed(0)}%)`);
      console.log(`   Catalyst: ${opp.catalyst.slice(0, 100)}`);

      // Telegram alert for high-score opportunities
      if (score >= ALERT_SCORE) {
        const msg = `🎯 <b>EVENT SCANNER: Score ${score}/10</b>\n` +
          `<b>${question}</b>\n` +
          `${edge.outcome} @ ${edge.currentPrice.toFixed(2)}¢ → est ${(edge.estimatedProb*100).toFixed(0)}% (edge ${(edge.edge*100).toFixed(0)}%)\n` +
          `⏱ ${(market._hoursToResolution || 0).toFixed(0)}h to resolution\n` +
          `📰 ${news.recentArticles} articles, ${news.spiking ? 'SPIKING' : 'normal'}\n` +
          `💡 ${opp.catalyst.slice(0, 120)}\n` +
          `[${reasons.join(', ')}]`;
        sendTelegramAlert(msg);
      }
    }

    // Merge with existing opportunities (don't overwrite, append new)
    const existing = loadJson(OPPS_FILE);
    // Remove stale scanner opps older than 24h
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const kept = existing.filter(o => {
      if (!o.id?.startsWith('evt-')) return true; // Keep non-scanner entries
      const t = new Date(o.scannedAt).getTime();
      return t > cutoff;
    });
    // Dedupe by market conditionId
    const existingMarkets = new Set(kept.filter(o => o.id?.startsWith('evt-')).map(o => o.market));
    const toAdd = newOpportunities.filter(o => !existingMarkets.has(o.market));
    const final = [...kept, ...toAdd];
    saveJson(OPPS_FILE, final);

    const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
    const summary = {
      scan: scanCount,
      at: new Date().toISOString(),
      elapsed: `${elapsed}s`,
      marketsScanned,
      newsQueries,
      opportunitiesFound: oppsFound,
      newAdded: toAdd.length,
      totalInFile: final.length,
    };

    console.log(`\n[SCAN #${scanCount}] Complete in ${elapsed}s — ${marketsScanned} markets, ${newsQueries} news queries, ${oppsFound} opps found, ${toAdd.length} new added`);
    appendLog(summary);
    lastScanAt = new Date().toISOString();
    lastScanResults = summary;

    return summary;
  } catch (e) {
    console.error('[SCAN] Fatal error:', e);
    appendLog({ scan: scanCount, at: new Date().toISOString(), error: e.message });
    return { error: e.message };
  }
}

// ── Health Check Server ──────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'event-scanner',
      scanCount,
      lastScanAt,
      lastScanResults,
      uptime: process.uptime(),
    }));
  } else if (req.url === '/scan') {
    // Manual trigger
    res.writeHead(200, { 'Content-Type': 'application/json' });
    runScan().then(r => res.end(JSON.stringify(r))).catch(e => res.end(JSON.stringify({ error: e.message })));
    return; // Don't end yet
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ── Main ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[EVENT-SCANNER] Health check on port ${PORT}`);
  console.log(`[EVENT-SCANNER] Scan interval: ${SCAN_INTERVAL / 1000 / 60} minutes`);
  console.log(`[EVENT-SCANNER] Min edge: ${MIN_EDGE * 100}%, Min score: ${MIN_SCORE}, Alert score: ${ALERT_SCORE}`);

  // Run first scan immediately
  runScan().then(() => {
    // Schedule recurring scans
    setInterval(runScan, SCAN_INTERVAL);
  });
});
