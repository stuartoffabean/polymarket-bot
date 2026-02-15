#!/usr/bin/env node
/**
 * External Data Enrichment Module for Event Scanner
 * 
 * Sources:
 * 1. OddsBlaze — sportsbook consensus odds (requires API key, $29/mo or free trial)
 * 2. Congress.gov — bill/legislation status tracking (free, 5000 req/hr)
 * 3. LMSYS/LMArena — AI model leaderboard scraper (free, scrapes HF + arena.ai)
 * 
 * Each enricher: takes a market question, returns structured signal or null.
 */

const https = require('https');
const http = require('http');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpGet(url, timeoutMs = 10000, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const req = mod.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'PolymarketScanner/1.0', ...headers },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, timeoutMs, headers).then(resolve).catch(reject);
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ═══════════════════════════════════════════════════════════════════
// 1. ODDSBLAZE — Sportsbook Odds Cross-Reference
// ═══════════════════════════════════════════════════════════════════

const ODDSBLAZE_KEY = process.env.ODDSBLAZE_API_KEY || '';
const ODDSBLAZE_BASE = 'https://data.oddsblaze.com/v1';

// Sport keyword mapping for OddsBlaze API
const SPORT_KEYWORDS = {
  'nfl': 'football_nfl', 'nba': 'basketball_nba', 'mlb': 'baseball_mlb',
  'nhl': 'icehockey_nhl', 'mls': 'soccer_usa_mls', 'ncaa': 'football_ncaaf',
  'college basketball': 'basketball_ncaab', 'college football': 'football_ncaaf',
  'premier league': 'soccer_epl', 'champions league': 'soccer_uefa_champs_league',
  'la liga': 'soccer_spain_la_liga', 'serie a': 'soccer_italy_serie_a',
  'bundesliga': 'soccer_germany_bundesliga', 'ligue 1': 'soccer_france_ligue_one',
  'ufc': 'mma_mixed_martial_arts', 'boxing': 'boxing_boxing',
  'tennis': 'tennis_atp', 'pga': 'golf_pga', 'f1': 'motorsport_formula_one',
  'super bowl': 'football_nfl', 'world cup': 'soccer_fifa_world_cup',
  'olympics': null, // No direct mapping
  'hockey': 'icehockey_nhl', 'football': 'football_nfl', 'basketball': 'basketball_nba',
  'baseball': 'baseball_mlb', 'soccer': 'soccer_epl',
};

function detectSport(question) {
  const q = question.toLowerCase();
  for (const [keyword, sport] of Object.entries(SPORT_KEYWORDS)) {
    if (q.includes(keyword)) return { keyword, sport };
  }
  return null;
}

function extractTeamsOrPlayers(question) {
  // Extract capitalized proper nouns that might be teams/players
  const words = question.replace(/[?!.,;:'"()]/g, '').split(/\s+/);
  const candidates = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i].length > 2 && words[i][0] === words[i][0].toUpperCase() && words[i][0] !== words[i][0].toLowerCase()) {
      // Check for multi-word names (e.g., "Los Angeles Lakers")
      let name = words[i];
      while (i + 1 < words.length && words[i + 1][0] === words[i + 1][0].toUpperCase() && words[i + 1][0] !== words[i + 1][0].toLowerCase()) {
        i++;
        name += ' ' + words[i];
      }
      // Filter out common non-name words
      const skip = new Set(['Will', 'The', 'Win', 'Most', 'This', 'Before', 'After', 'Over', 'Under', 'Yes', 'No', 'How', 'Many', 'Does', 'Super', 'Bowl']);
      if (!skip.has(name.split(' ')[0])) candidates.push(name);
    }
  }
  return candidates;
}

async function enrichWithOddsBlaze(question) {
  if (!ODDSBLAZE_KEY) return null;
  
  const sportMatch = detectSport(question);
  if (!sportMatch || !sportMatch.sport) return null;

  try {
    const url = `${ODDSBLAZE_BASE}/odds/${sportMatch.sport}?key=${ODDSBLAZE_KEY}&market=Moneyline`;
    const r = await httpGet(url);
    if (r.status !== 200) return null;
    const data = JSON.parse(r.data);
    
    const teams = extractTeamsOrPlayers(question);
    if (teams.length === 0) return null;

    // Find matching games
    const games = data.games || data.data || [];
    for (const game of games) {
      const gameName = `${game.home_team || ''} ${game.away_team || ''} ${game.teams?.join(' ') || ''}`.toLowerCase();
      const matched = teams.filter(t => gameName.includes(t.toLowerCase()));
      if (matched.length === 0) continue;

      // Extract consensus odds across sportsbooks
      const odds = game.odds || game.sportsbooks || [];
      if (!Array.isArray(odds) || odds.length === 0) continue;

      // Calculate average implied probability from sportsbooks
      const probabilities = {};
      for (const book of odds) {
        const outcomes = book.outcomes || book.odds || [];
        for (const o of outcomes) {
          const name = o.name || o.team || '';
          const price = o.price || o.odds || 0;
          if (!probabilities[name]) probabilities[name] = [];
          // Convert American odds to implied probability
          let impliedProb;
          if (price > 0) impliedProb = 100 / (price + 100);
          else if (price < 0) impliedProb = Math.abs(price) / (Math.abs(price) + 100);
          else continue;
          probabilities[name].push(impliedProb);
        }
      }

      // Average across books
      const consensus = {};
      for (const [name, probs] of Object.entries(probabilities)) {
        consensus[name] = +(probs.reduce((a, b) => a + b, 0) / probs.length).toFixed(4);
      }

      return {
        source: 'oddsblaze',
        sport: sportMatch.sport,
        matchedTeams: matched,
        consensus,
        numBooks: odds.length,
        gameTime: game.commence_time || game.start_time || null,
      };
    }
    return null;
  } catch (e) {
    console.error('[ODDSBLAZE]', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 2. CONGRESS.GOV — Legislative Action Tracker
// ═══════════════════════════════════════════════════════════════════

const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY || '';
const CONGRESS_BASE = 'https://api.congress.gov/v3';

// Keywords that indicate a legislation/politics market
const LEGISLATION_KEYWORDS = [
  'bill', 'act', 'law', 'legislation', 'congress', 'senate', 'house',
  'pass', 'vote', 'signed', 'veto', 'impeach', 'confirm', 'nominate',
  'government shutdown', 'debt ceiling', 'budget', 'spending',
  'executive order', 'ban', 'repeal', 'amendment',
];

function isLegislationMarket(question) {
  const q = question.toLowerCase();
  return LEGISLATION_KEYWORDS.some(kw => q.includes(kw));
}

function extractBillTerms(question) {
  // Look for bill numbers like "H.R. 1234" or "S. 567"
  const billMatch = question.match(/(?:H\.?R\.?|S\.?|H\.?J\.?\s*Res\.?|S\.?J\.?\s*Res\.?)\s*(\d+)/i);
  if (billMatch) return { type: 'bill_number', value: billMatch[0] };
  
  // Extract key policy terms
  const q = question.toLowerCase();
  const policyTerms = [];
  const policies = ['shutdown', 'debt ceiling', 'immigration', 'healthcare', 'tax', 'defense',
    'spending', 'budget', 'aid', 'tariff', 'trade', 'climate', 'energy', 'gun',
    'abortion', 'marijuana', 'cannabis', 'crypto', 'tiktok', 'ban'];
  for (const p of policies) {
    if (q.includes(p)) policyTerms.push(p);
  }
  if (policyTerms.length > 0) return { type: 'policy', value: policyTerms.join(' ') };
  return null;
}

async function enrichWithCongress(question) {
  if (!CONGRESS_API_KEY) return null;
  if (!isLegislationMarket(question)) return null;

  const terms = extractBillTerms(question);
  if (!terms) return null;

  try {
    let url;
    if (terms.type === 'bill_number') {
      // Direct bill lookup
      const match = terms.value.match(/(?:H\.?R\.?|S\.?)\s*(\d+)/i);
      const prefix = terms.value.toLowerCase().startsWith('s') ? 's' : 'hr';
      const number = match[1];
      url = `${CONGRESS_BASE}/bill/119/${prefix}/${number}?api_key=${CONGRESS_API_KEY}&format=json`;
    } else {
      // Search by keyword
      url = `${CONGRESS_BASE}/bill?query=${encodeURIComponent(terms.value)}&limit=5&sort=updateDate+desc&api_key=${CONGRESS_API_KEY}&format=json`;
    }

    const r = await httpGet(url);
    if (r.status !== 200) return null;
    const data = JSON.parse(r.data);

    if (terms.type === 'bill_number' && data.bill) {
      const bill = data.bill;
      return {
        source: 'congress',
        billNumber: `${bill.type || ''} ${bill.number || ''}`.trim(),
        title: bill.title || '',
        status: bill.latestAction?.text || 'Unknown',
        statusDate: bill.latestAction?.actionDate || null,
        introduced: bill.introducedDate || null,
        sponsors: bill.sponsors?.length || 0,
        cosponsors: bill.cosponsors?.count || 0,
        committees: bill.committees?.count || 0,
        chamber: bill.originChamber || '',
        congress: bill.congress || 119,
        url: bill.url || null,
      };
    }

    // Search results
    const bills = data.bills || [];
    if (bills.length === 0) return null;

    const recent = bills.slice(0, 3).map(b => ({
      number: `${b.type || ''} ${b.number || ''}`.trim(),
      title: (b.title || '').slice(0, 100),
      status: b.latestAction?.text || 'Unknown',
      statusDate: b.latestAction?.actionDate || null,
    }));

    return {
      source: 'congress',
      searchTerm: terms.value,
      matchCount: bills.length,
      recentBills: recent,
    };
  } catch (e) {
    console.error('[CONGRESS]', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 3. LMSYS / LMArena — AI Model Leaderboard Scraper
// ═══════════════════════════════════════════════════════════════════

const AI_KEYWORDS = [
  'ai model', 'chatbot', 'llm', 'gpt', 'claude', 'gemini', 'anthropic',
  'openai', 'google ai', 'meta ai', 'llama', 'mistral', 'deepseek',
  'arena', 'leaderboard', 'benchmark', 'elo', 'lmsys',
  'chatbot arena', 'top ai', '#1 ai', 'best ai model',
];

let lmsysCache = null;
let lmsysCacheTime = 0;
const LMSYS_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

function isAIModelMarket(question) {
  const q = question.toLowerCase();
  return AI_KEYWORDS.some(kw => q.includes(kw));
}

async function scrapeLMSYSLeaderboard() {
  // Check cache
  if (lmsysCache && Date.now() - lmsysCacheTime < LMSYS_CACHE_TTL) {
    return lmsysCache;
  }

  try {
    // Scrape from the HuggingFace static page (the leaderboard embeds data)
    // First try the rankings page which has the table
    const r = await httpGet('https://lmarena-ai.github.io/chatbot-arena-leaderboard/leaderboard_table_20250901.csv', 8000);
    if (r.status === 200 && r.data.includes(',')) {
      const lines = r.data.trim().split('\n');
      const headers = lines[0].split(',');
      const models = [];
      for (let i = 1; i < Math.min(lines.length, 30); i++) {
        const cols = lines[i].split(',');
        models.push({
          rank: i,
          model: cols[0] || '',
          elo: parseFloat(cols[1]) || 0,
          votes: parseInt(cols[2]) || 0,
          org: cols[3] || '',
        });
      }
      lmsysCache = models;
      lmsysCacheTime = Date.now();
      return models;
    }
  } catch (e) {
    console.error('[LMSYS] CSV fetch failed:', e.message);
  }

  // Fallback: scrape the arena.ai page via their Next.js page data
  try {
    const r = await httpGet('https://arena.ai/leaderboard', 10000);
    if (r.status !== 200) return null;
    
    // Extract model data from script tags (Next.js embeds it)
    const scriptMatch = r.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (scriptMatch) {
      const nextData = JSON.parse(scriptMatch[1]);
      // Navigate the Next.js data structure to find leaderboard data
      const props = nextData?.props?.pageProps;
      if (props?.leaderboard || props?.models) {
        const models = (props.leaderboard || props.models).slice(0, 20).map((m, i) => ({
          rank: i + 1,
          model: m.name || m.model || '',
          elo: m.elo || m.rating || m.score || 0,
          org: m.org || m.organization || '',
        }));
        lmsysCache = models;
        lmsysCacheTime = Date.now();
        return models;
      }
    }

    // Last resort: regex extract model names and elo scores from raw HTML
    const eloMatches = [...r.data.matchAll(/(?:"model"|"name"):\s*"([^"]+)".*?(?:"elo"|"rating"|"score"):\s*(\d+)/g)];
    if (eloMatches.length > 0) {
      const models = eloMatches.slice(0, 20).map((m, i) => ({
        rank: i + 1,
        model: m[1],
        elo: parseInt(m[2]),
      }));
      lmsysCache = models;
      lmsysCacheTime = Date.now();
      return models;
    }
  } catch (e) {
    console.error('[LMSYS] arena.ai scrape failed:', e.message);
  }

  return null;
}

function extractModelName(question) {
  const q = question.toLowerCase();
  const models = {
    'claude': 'Anthropic', 'gpt': 'OpenAI', 'gemini': 'Google',
    'llama': 'Meta', 'mistral': 'Mistral', 'deepseek': 'DeepSeek',
    'qwen': 'Alibaba', 'command': 'Cohere', 'grok': 'xAI',
  };
  for (const [name, org] of Object.entries(models)) {
    if (q.includes(name)) return { model: name, org };
  }
  return null;
}

async function enrichWithLMSYS(question) {
  if (!isAIModelMarket(question)) return null;

  const modelMatch = extractModelName(question);
  const leaderboard = await scrapeLMSYSLeaderboard();

  const result = {
    source: 'lmsys',
    leaderboardAvailable: !!leaderboard,
    topModels: leaderboard ? leaderboard.slice(0, 5) : null,
  };

  if (modelMatch && leaderboard) {
    // Find the specific model's ranking
    const found = leaderboard.find(m => 
      m.model.toLowerCase().includes(modelMatch.model) ||
      (m.org && m.org.toLowerCase().includes(modelMatch.org.toLowerCase()))
    );
    if (found) {
      result.queriedModel = modelMatch.model;
      result.modelRank = found.rank;
      result.modelElo = found.elo;
      result.isTop1 = found.rank === 1;
      result.isTop3 = found.rank <= 3;
      result.isTop5 = found.rank <= 5;
    }
  }

  // Also check for "most liked" / "#1" type questions
  if (leaderboard && leaderboard.length > 0) {
    result.currentLeader = leaderboard[0];
    result.leaderEloGap = leaderboard.length > 1 
      ? leaderboard[0].elo - leaderboard[1].elo 
      : 0;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// UNIFIED ENRICHMENT — Call all relevant sources for a market
// ═══════════════════════════════════════════════════════════════════

async function enrichMarket(question) {
  const enrichments = {};
  const errors = [];

  // Run applicable enrichers in parallel
  const promises = [];

  // OddsBlaze (sports)
  if (ODDSBLAZE_KEY && detectSport(question)) {
    promises.push(
      enrichWithOddsBlaze(question)
        .then(r => { if (r) enrichments.odds = r; })
        .catch(e => errors.push(`odds: ${e.message}`))
    );
  }

  // Congress.gov (legislation)
  if (CONGRESS_API_KEY && isLegislationMarket(question)) {
    promises.push(
      enrichWithCongress(question)
        .then(r => { if (r) enrichments.congress = r; })
        .catch(e => errors.push(`congress: ${e.message}`))
    );
  }

  // LMSYS (AI models)
  if (isAIModelMarket(question)) {
    promises.push(
      enrichWithLMSYS(question)
        .then(r => { if (r) enrichments.lmsys = r; })
        .catch(e => errors.push(`lmsys: ${e.message}`))
    );
  }

  await Promise.all(promises);

  if (errors.length > 0) {
    enrichments._errors = errors;
  }

  return Object.keys(enrichments).length > 0 ? enrichments : null;
}

// ═══════════════════════════════════════════════════════════════════
// ENRICHMENT → EDGE ADJUSTMENT
// ═══════════════════════════════════════════════════════════════════

/**
 * Adjusts edge estimate based on enrichment data.
 * Returns { adjustedConfidence, adjustmentReason } or null if no adjustment.
 */
function adjustEdgeFromEnrichment(enrichments, currentConfidence, outcome) {
  if (!enrichments) return null;
  
  let adjustment = 0;
  const reasons = [];

  // OddsBlaze: if sportsbook consensus strongly agrees with our signal
  if (enrichments.odds) {
    const { consensus, numBooks } = enrichments.odds;
    // Find the relevant team's implied probability
    const probs = Object.values(consensus);
    const maxProb = Math.max(...probs);
    if (numBooks >= 3 && maxProb > 0.7) {
      // Strong sportsbook consensus
      if (outcome === 'Yes' && maxProb > 0.7) {
        adjustment += 0.1;
        reasons.push(`sportsbook consensus ${(maxProb*100).toFixed(0)}% (${numBooks} books)`);
      }
    }
  }

  // Congress: if bill has recent action
  if (enrichments.congress) {
    const c = enrichments.congress;
    if (c.statusDate) {
      const daysSinceAction = (Date.now() - new Date(c.statusDate).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceAction < 3) {
        adjustment += 0.05;
        reasons.push(`recent legislative action (${daysSinceAction.toFixed(0)}d ago): ${(c.status || '').slice(0, 60)}`);
      }
    }
  }

  // LMSYS: if we can confirm model ranking
  if (enrichments.lmsys) {
    const l = enrichments.lmsys;
    if (l.isTop1) {
      adjustment += 0.1;
      reasons.push(`model is #1 on LMSYS (Elo ${l.modelElo})`);
    } else if (l.isTop3) {
      adjustment += 0.05;
      reasons.push(`model is top 3 on LMSYS (rank #${l.modelRank})`);
    }
  }

  if (adjustment === 0) return null;

  return {
    adjustedConfidence: Math.min(0.95, currentConfidence + adjustment),
    adjustment,
    reasons,
  };
}

module.exports = {
  enrichMarket,
  adjustEdgeFromEnrichment,
  // Individual enrichers (for testing)
  enrichWithOddsBlaze,
  enrichWithCongress,
  enrichWithLMSYS,
  // Detection helpers
  detectSport,
  isLegislationMarket,
  isAIModelMarket,
};
