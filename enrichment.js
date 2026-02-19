#!/usr/bin/env node
/**
 * External Data Enrichment Module for Event Scanner
 * 
 * Sources:
 * 1. OddsBlaze — sportsbook consensus odds (requires API key, $29/mo)
 * 2. Congress.gov — bill/legislation status tracking (free, 5000 req/hr)
 * 3. LMSYS/LMArena — AI model leaderboard scraper (free, scrapes HF + arena.ai)
 * 4. FRED — Federal Reserve Economic Data (free, 120 req/min)
 * 5. Metaculus — Prediction market consensus (free API)
 * 6. NewsAPI — Breaking news headlines for any topic (free tier, 500 req/day)
 * 
 * Each enricher: takes a market question, returns structured signal or null.
 */

const https = require('https');
const http = require('http');
const { smartFetch } = require('./lib/clawpod-fetch');

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

// Wrapper to maintain backward compatibility with httpGet interface
async function smartHttpGet(url, timeoutMs = 10000, headers = {}) {
  try {
    const result = await smartFetch(url, { timeout: timeoutMs });
    return {
      status: result.status || (result.ok ? 200 : 500),
      data: result.data || '',
    };
  } catch (error) {
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 1. ODDSBLAZE — Sportsbook Odds Cross-Reference
// ═══════════════════════════════════════════════════════════════════

const ODDSBLAZE_KEY = process.env.ODDSBLAZE_API_KEY || '';
const ODDSBLAZE_BASE = 'https://odds.oddsblaze.com';

// Sport keyword mapping for OddsBlaze league IDs
const SPORT_KEYWORDS = {
  'nfl': 'nfl', 'nba': 'nba', 'mlb': 'mlb', 'nhl': 'nhl', 'mls': 'mls',
  'ncaa basketball': 'ncaab', 'college basketball': 'ncaab', 'ncaab': 'ncaab',
  'ncaa football': 'ncaaf', 'college football': 'ncaaf', 'ncaaf': 'ncaaf',
  'premier league': 'epl', 'champions league': 'ucl', 'la liga': 'laliga',
  'serie a': 'seriea', 'bundesliga': 'bundesliga', 'ligue 1': 'ligue1',
  'ufc': 'ufc', 'mma': 'ufc', 'boxing': 'boxing',
  'tennis': 'tennis', 'pga': 'pga', 'f1': 'f1',
  'super bowl': 'nfl', 'world cup': 'fifa',
  'olympics': null,
  'hockey': 'nhl', 'football': 'nfl', 'basketball': 'nba',
  'baseball': 'mlb', 'soccer': 'epl',
};

// Team names → sport mapping for games like "Nets vs. Cavaliers" with no sport keyword
const NBA_TEAMS = ['lakers','celtics','warriors','76ers','sixers','hawks','pacers','wizards','nets','cavaliers','cavs','rockets','hornets','knicks','bulls','heat','suns','bucks','nuggets','clippers','mavericks','mavs','grizzlies','pelicans','pistons','raptors','kings','spurs','timberwolves','wolves','blazers','thunder','jazz','magic','trail blazers'];
const NFL_TEAMS = ['chiefs','eagles','cowboys','49ers','niners','bills','ravens','bengals','dolphins','jets','patriots','steelers','packers','lions','bears','vikings','rams','chargers','broncos','raiders','commanders','texans','colts','jaguars','titans','saints','falcons','panthers','buccaneers','bucs','cardinals','seahawks','giants'];
const NHL_TEAMS = ['bruins','maple leafs','leafs','canadiens','habs','rangers','islanders','devils','flyers','penguins','capitals','caps','hurricanes','blue jackets','panthers','lightning','red wings','sabres','senators','blackhawks','wild','jets','avalanche','stars','predators','blues','flames','oilers','canucks','kraken','golden knights','coyotes','sharks','ducks','kings'];
const MLB_TEAMS = ['yankees','red sox','mets','dodgers','cubs','white sox','astros','braves','phillies','padres','guardians','orioles','rays','mariners','blue jays','twins','brewers','cardinals','reds','giants','diamondbacks','rockies','pirates','royals','tigers','athletics','nationals','marlins','angels','rangers'];

function detectSport(question) {
  const q = question.toLowerCase();
  // Check explicit sport keywords first
  for (const [keyword, sport] of Object.entries(SPORT_KEYWORDS)) {
    if (q.includes(keyword)) return { keyword, sport };
  }
  // Check team names
  if (NBA_TEAMS.some(t => q.includes(t))) return { keyword: 'nba-team', sport: 'nba' };
  if (NFL_TEAMS.some(t => q.includes(t))) return { keyword: 'nfl-team', sport: 'nfl' };
  if (NHL_TEAMS.some(t => q.includes(t))) return { keyword: 'nhl-team', sport: 'nhl' };
  if (MLB_TEAMS.some(t => q.includes(t))) return { keyword: 'mlb-team', sport: 'mlb' };
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
    const teams = extractTeamsOrPlayers(question);
    if (teams.length === 0) return null;

    // OddsBlaze: one sportsbook per call, uses probability format for easy parsing
    // Query multiple books for consensus
    const sportsbooks = ['pinnacle', 'draftkings', 'fanduel', 'betmgm', 'bovada'];
    const allOdds = {}; // teamName -> [probabilities]
    let matchedGame = null;
    let booksQueried = 0;

    for (const book of sportsbooks) {
      try {
        const url = `${ODDSBLAZE_BASE}/?key=${ODDSBLAZE_KEY}&sportsbook=${book}&league=${sportMatch.sport}&market=Moneyline&price=probability&main=true`;
        const r = await httpGet(url);
        if (r.status !== 200) continue;
        const data = JSON.parse(r.data);
        const events = data.events || [];
        
        for (const ev of events) {
          const awayName = ev.teams?.away?.name || '';
          const homeName = ev.teams?.home?.name || '';
          const evName = `${awayName} ${homeName}`.toLowerCase();
          // Match any team word (e.g., "Charlotte" matches "Charlotte 49ers")
          const matched = teams.filter(t => {
            const tl = t.toLowerCase();
            if (evName.includes(tl)) return true;
            // Try individual words from team name
            return tl.split(' ').some(w => w.length > 3 && evName.includes(w));
          });
          if (matched.length === 0) continue;
          
          matchedGame = { name: `${awayName} @ ${homeName}`, start: ev.date || null, matched };
          
          // OddsBlaze odds are in events[].odds[] array
          const odds = ev.odds || [];
          for (const o of odds) {
            const name = o.name || '';
            const rawPrice = String(o.price || '').replace('%', '');
            const prob = parseFloat(rawPrice) || 0;
            if (!name || !prob) continue;
            // price comes as "94.29%" string — parse to 0-1 range
            const probVal = prob > 1 ? prob / 100 : prob;
            if (!allOdds[name]) allOdds[name] = [];
            allOdds[name].push(probVal);
          }
          booksQueried++;
          break; // Found the game in this book
        }
        await sleep(300); // Rate limit between sportsbook queries
      } catch (e) {
        console.error(`[ODDSBLAZE] ${book}:`, e.message);
      }
    }

    if (!matchedGame || Object.keys(allOdds).length === 0) return null;

    // Average across books for consensus probability
    const consensus = {};
    for (const [name, probs] of Object.entries(allOdds)) {
      consensus[name] = +(probs.reduce((a, b) => a + b, 0) / probs.length).toFixed(4);
    }

    return {
      source: 'oddsblaze',
      sport: sportMatch.sport,
      game: matchedGame.name,
      matchedTeams: matchedGame.matched,
      consensus,
      numBooks: booksQueried,
      gameTime: matchedGame.start,
    };
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
    const r = await smartHttpGet('https://lmarena-ai.github.io/chatbot-arena-leaderboard/leaderboard_table_20250901.csv', 8000);
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
    const r = await smartHttpGet('https://arena.ai/leaderboard', 10000);
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
// 4. FRED — Federal Reserve Economic Data
// ═══════════════════════════════════════════════════════════════════

const FRED_API_KEY = process.env.FRED_API_KEY || '';

const ECON_KEYWORDS = {
  'fed rate': 'FEDFUNDS',
  'federal funds': 'FEDFUNDS',
  'interest rate': 'FEDFUNDS',
  'rate cut': 'FEDFUNDS',
  'rate hike': 'FEDFUNDS',
  'inflation': 'CPIAUCSL',
  'cpi': 'CPIAUCSL',
  'consumer price': 'CPIAUCSL',
  'unemployment': 'UNRATE',
  'jobless': 'UNRATE',
  'jobs report': 'PAYEMS',
  'nonfarm payroll': 'PAYEMS',
  'non-farm payroll': 'PAYEMS',
  'payrolls': 'PAYEMS',
  'gdp': 'GDP',
  'recession': 'GDP',
  'economic growth': 'GDP',
  'retail sales': 'RSAFS',
  'consumer spending': 'PCE',
  'pce': 'PCE',
  'housing starts': 'HOUST',
  'home sales': 'EXHOSLUSM495S',
  'treasury yield': 'DGS10',
  '10-year': 'DGS10',
  '2-year': 'DGS2',
  'yield curve': 'T10Y2Y',
  'oil price': 'DCOILWTICO',
  'crude oil': 'DCOILWTICO',
};

function detectEconSeries(question) {
  const q = question.toLowerCase();
  for (const [keyword, seriesId] of Object.entries(ECON_KEYWORDS)) {
    if (q.includes(keyword)) return { keyword, seriesId };
  }
  return null;
}

async function enrichWithFRED(question) {
  if (!FRED_API_KEY) return null;
  const match = detectEconSeries(question);
  if (!match) return null;

  try {
    // Get latest observations
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${match.seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=12`;
    const r = await httpGet(url);
    if (r.status !== 200) return null;
    const data = JSON.parse(r.data);

    const obs = (data.observations || []).filter(o => o.value !== '.');
    if (obs.length === 0) return null;

    const latest = parseFloat(obs[0].value);
    const prev = obs.length > 1 ? parseFloat(obs[1].value) : null;
    const change = prev !== null ? latest - prev : null;
    const changePct = prev !== null && prev !== 0 ? ((latest - prev) / prev * 100) : null;

    // Trend: last 6 observations
    const recent = obs.slice(0, 6).map(o => parseFloat(o.value)).reverse();
    const trend = recent.length >= 3
      ? (recent[recent.length - 1] > recent[0] ? 'rising' : recent[recent.length - 1] < recent[0] ? 'falling' : 'flat')
      : null;

    return {
      source: 'fred',
      seriesId: match.seriesId,
      keyword: match.keyword,
      latest: { value: latest, date: obs[0].date },
      previous: prev !== null ? { value: prev, date: obs[1]?.date } : null,
      change,
      changePct: changePct !== null ? +changePct.toFixed(2) : null,
      trend,
      recentValues: recent,
    };
  } catch (e) {
    console.error('[FRED]', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 5. METACULUS — Prediction Market Consensus
// ═══════════════════════════════════════════════════════════════════

const METACULUS_API_KEY = process.env.METACULUS_API_KEY || '';

async function enrichWithMetaculus(question) {
  if (!METACULUS_API_KEY) return null;

  // Search Metaculus for similar questions (v2 API)
  const searchTerms = question
    .replace(/^(Will|Does|Is|Are|Has|Have|Can|Could|Should|Would)\s+/i, '')
    .replace(/\?$/, '')
    .slice(0, 80);

  try {
    const url = `https://www.metaculus.com/api2/questions/?search=${encodeURIComponent(searchTerms)}&limit=5&status=open&type=binary`;
    const r = await httpGet(url, 10000, {
      'Authorization': `Token ${METACULUS_API_KEY}`,
    });
    if (r.status !== 200) return null;
    const data = JSON.parse(r.data);

    const results = data.results || [];
    if (results.length === 0) return null;

    // Score relevance by title similarity (simple word overlap)
    const qWords = new Set(question.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const scored = results.map(q => {
      const tWords = new Set((q.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const overlap = [...qWords].filter(w => tWords.has(w)).length;
      return { ...q, relevance: overlap / Math.max(qWords.size, 1) };
    }).sort((a, b) => b.relevance - a.relevance);

    const best = scored[0];
    if (best.relevance < 0.2) return null; // Too dissimilar

    // Fetch individual question for prediction data
    let communityPred = null;
    let numForecasters = best.nr_forecasters || best.forecasts_count || 0;
    try {
      const qr = await httpGet(`https://www.metaculus.com/api2/questions/${best.id}/`, 8000, {
        'Authorization': `Token ${METACULUS_API_KEY}`,
      });
      if (qr.status === 200) {
        const qData = JSON.parse(qr.data);
        communityPred = qData.community_prediction?.full?.q2 
          || qData.community_prediction?.q2
          || qData.community_prediction
          || null;
        numForecasters = qData.nr_forecasters || qData.forecasts_count || numForecasters;
        // Handle case where community_prediction is a direct number
        if (typeof communityPred === 'object' && communityPred !== null) {
          communityPred = communityPred.q2 || communityPred.median || null;
        }
      }
    } catch (e) { /* individual fetch failed, proceed without prediction */ }

    return {
      source: 'metaculus',
      matchedQuestion: best.title?.slice(0, 100),
      metaculusId: best.id,
      communityPrediction: communityPred,
      numForecasters,
      relevanceScore: +best.relevance.toFixed(2),
      url: `https://www.metaculus.com/questions/${best.id}/`,
    };
  } catch (e) {
    console.error('[METACULUS]', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 6. NEWSAPI — Breaking News Headlines
// ═══════════════════════════════════════════════════════════════════

const NEWSAPI_KEY = process.env.NEWSAPI_KEY || '';

/**
 * Extract search keywords from a market question.
 * Strips common words, returns 2-4 most relevant terms.
 */
function extractNewsKeywords(question) {
  const stopWords = new Set([
    'will', 'the', 'be', 'in', 'on', 'of', 'a', 'an', 'to', 'for', 'and', 'or',
    'by', 'from', 'at', 'is', 'it', 'this', 'that', 'with', 'has', 'have', 'do',
    'does', 'did', 'not', 'no', 'yes', 'was', 'were', 'been', 'being', 'are',
    'before', 'after', 'between', 'more', 'than', 'most', 'how', 'many', 'much',
    'what', 'when', 'where', 'who', 'which', 'win', 'reach', 'dip', 'price',
    'highest', 'lowest', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december', 'january',
    '2025', '2026', '2027',
  ]);
  const words = question
    .replace(/[^a-zA-Z0-9\s'-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()))
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  // Return top 3-4 unique keywords
  const unique = [...new Set(words)];
  return unique.slice(0, 4).join(' ');
}

/**
 * Search NewsAPI for recent headlines related to a market question.
 * Returns: { source, query, articles: [{ title, source, publishedAt, url }], articleCount }
 */
async function enrichWithNewsAPI(question) {
  if (!NEWSAPI_KEY) return null;
  
  const keywords = extractNewsKeywords(question);
  if (!keywords || keywords.split(' ').length < 1) return null;

  try {
    const query = encodeURIComponent(keywords);
    const url = `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&pageSize=5&language=en&apiKey=${NEWSAPI_KEY}`;
    const resp = await httpGet(url, 8000);
    if (resp.status !== 200) return null;
    
    const data = JSON.parse(resp.data);
    if (!data.articles || data.articles.length === 0) return null;

    const articles = data.articles.map(a => ({
      title: a.title,
      source: a.source?.name,
      publishedAt: a.publishedAt,
      description: a.description?.slice(0, 150),
      url: a.url,
    }));

    // Check recency — if most recent article is >3 days old, less useful
    const mostRecent = new Date(articles[0].publishedAt);
    const hoursAgo = (Date.now() - mostRecent.getTime()) / (1000 * 60 * 60);

    return {
      source: 'newsapi',
      query: keywords,
      articleCount: data.totalResults,
      articles,
      mostRecentHoursAgo: Math.round(hoursAgo),
      isBreaking: hoursAgo < 6,
      isFresh: hoursAgo < 24,
    };
  } catch (e) {
    console.error('[NEWSAPI]', e.message);
    return null;
  }
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

  // FRED (economic data)
  if (FRED_API_KEY && detectEconSeries(question)) {
    promises.push(
      enrichWithFRED(question)
        .then(r => { if (r) enrichments.fred = r; })
        .catch(e => errors.push(`fred: ${e.message}`))
    );
  }

  // Metaculus (prediction consensus)
  if (METACULUS_API_KEY) {
    promises.push(
      enrichWithMetaculus(question)
        .then(r => { if (r) enrichments.metaculus = r; })
        .catch(e => errors.push(`metaculus: ${e.message}`))
    );
  }

  // NewsAPI (breaking news context)
  if (NEWSAPI_KEY) {
    promises.push(
      enrichWithNewsAPI(question)
        .then(r => { if (r) enrichments.news = r; })
        .catch(e => errors.push(`news: ${e.message}`))
    );
  }

  await Promise.all(promises);

  if (errors.length > 0) {
    enrichments._errors = errors;
  }

  // Always log enrichment attempt for visibility
  const sources = Object.keys(enrichments).filter(k => k !== '_errors');
  const attempted = promises.length;
  if (sources.length > 0) {
    console.log(`[ENRICH] "${question.slice(0, 60)}" — ${sources.length}/${attempted} sources matched: ${sources.join(', ')}`);
  } else if (attempted > 0) {
    console.log(`[ENRICH] "${question.slice(0, 60)}" — 0/${attempted} sources matched`);
  }
  // If no enrichers were applicable, no log (expected for most markets)

  return Object.keys(enrichments).filter(k => k !== '_errors').length > 0 ? enrichments : null;
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

  // FRED: if economic data confirms direction
  if (enrichments.fred) {
    const f = enrichments.fred;
    if (f.trend) {
      adjustment += 0.05;
      reasons.push(`FRED ${f.seriesId}: ${f.latest.value} (${f.trend}), change: ${f.changePct != null ? f.changePct + '%' : 'N/A'}`);
    }
  }

  // NewsAPI: breaking news boost
  if (enrichments.news) {
    const n = enrichments.news;
    if (n.isBreaking && n.articleCount >= 3) {
      adjustment += 0.07;
      reasons.push(`breaking news (${n.articleCount} articles, latest ${n.mostRecentHoursAgo}h ago): "${n.articles[0]?.title?.slice(0, 80)}"`);
    } else if (n.isFresh && n.articleCount >= 5) {
      adjustment += 0.03;
      reasons.push(`fresh news coverage (${n.articleCount} articles): "${n.articles[0]?.title?.slice(0, 80)}"`);
    }
  }

  // Metaculus: cross-platform prediction consensus
  if (enrichments.metaculus) {
    const m = enrichments.metaculus;
    if (m.communityPrediction != null && m.numForecasters >= 20 && m.relevanceScore >= 0.3) {
      // If Metaculus consensus aligns with our signal direction, boost confidence
      const metaProb = m.communityPrediction;
      if ((outcome === 'Yes' && metaProb > 0.6) || (outcome === 'No' && metaProb < 0.4)) {
        adjustment += 0.08;
        reasons.push(`Metaculus consensus ${(metaProb*100).toFixed(0)}% (${m.numForecasters} forecasters, relevance ${m.relevanceScore})`);
      }
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
  enrichWithFRED,
  enrichWithMetaculus,
  enrichWithNewsAPI,
  // Detection helpers
  detectSport,
  isLegislationMarket,
  isAIModelMarket,
  detectEconSeries,
};
