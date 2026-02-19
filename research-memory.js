#!/usr/bin/env node
/**
 * Research Memory — Vector-backed knowledge store for directional trading
 * 
 * Stores research findings with Gemini embeddings, retrieves relevant context
 * for future scans. Time-decayed similarity scoring prevents stale data pollution.
 * 
 * Design principles:
 * - Store RAW FACTS only, never our own predictions/theses (prevents echo chamber)
 * - Time decay: 24h half-life, sports markets decay faster (6h after game ends)
 * - Tag everything for future outcome-weighted retrieval (Option B prep)
 * - Flat JSON file storage (hundreds of vectors, not millions)
 * - Gemini embeddings via API (free tier)
 * 
 * Usage:
 *   const rm = new ResearchMemory();
 *   await rm.store({ marketId, question, facts: [...], sources: [...] });
 *   const context = await rm.retrieve(question, { maxResults: 5, maxAgeHours: 48 });
 *   rm.markResolved(marketId, outcome, actualPrice);
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const MEMORY_FILE = path.join(__dirname, 'research-memory.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`;

// Time decay config
const DEFAULT_HALF_LIFE_HOURS = 24;
const SPORTS_HALF_LIFE_HOURS = 6;
const MAX_ENTRIES = 2000;      // Prune beyond this
const PRUNE_THRESHOLD = 0.01;  // Remove entries with decay weight below this

class ResearchMemory {
  constructor(memoryFile = MEMORY_FILE) {
    this.memoryFile = memoryFile;
    this.data = this._load();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.memoryFile, 'utf8'));
    } catch {
      return { entries: [], meta: { created: new Date().toISOString(), totalStored: 0, totalPruned: 0 } };
    }
  }

  _save() {
    fs.writeFileSync(this.memoryFile, JSON.stringify(this.data, null, 2));
  }

  /**
   * Get embedding vector from Gemini API
   */
  async _embed(text) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    
    // Truncate to avoid token limits
    const truncated = text.slice(0, 2000);
    
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: truncated }] }
      });
      
      const parsed = new URL(GEMINI_EMBED_URL);
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(d);
            if (json.embedding && json.embedding.values) {
              resolve(json.embedding.values);
            } else {
              reject(new Error(`Embed failed: ${d.slice(0, 200)}`));
            }
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end(body);
    });
  }

  /**
   * Cosine similarity between two vectors
   */
  _cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
  }

  /**
   * Time decay weight: e^(-hours_old / half_life)
   */
  _decayWeight(timestampMs, halfLifeHours = DEFAULT_HALF_LIFE_HOURS) {
    const hoursOld = (Date.now() - timestampMs) / (1000 * 60 * 60);
    return Math.exp(-hoursOld * Math.LN2 / halfLifeHours);
  }

  /**
   * Store research findings for a market.
   * 
   * @param {Object} entry
   * @param {string} entry.marketId - Polymarket conditionId
   * @param {string} entry.question - Market question text
   * @param {string} entry.category - Market category (sports|politics|crypto|ai|economics|other)
   * @param {string[]} entry.facts - Raw factual findings (NOT predictions/theses)
   * @param {string[]} entry.sources - Which data sources succeeded
   * @param {boolean} entry.complete - Whether all sources responded
   * @param {Object} entry.prices - Current prices at time of research { yesAsk, noAsk, gammaMid }
   * @param {number} entry.hoursToResolution - Hours until market resolves
   * @param {string} [entry.endDate] - Market resolution date
   */
  async store(entry) {
    // Build embedding text: question + category context + facts
    const embedText = [
      `${entry.category || 'other'}: ${entry.question}`,
      ...entry.facts.slice(0, 10),
    ].join('\n');

    const embedding = await this._embed(embedText);

    const record = {
      id: `rm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      timestampISO: new Date().toISOString(),
      marketId: entry.marketId,
      question: entry.question,
      category: entry.category || 'other',
      facts: entry.facts,
      sources: entry.sources,
      complete: entry.complete !== false,
      prices: entry.prices || null,
      hoursToResolution: entry.hoursToResolution || null,
      endDate: entry.endDate || null,
      embedding,
      // Option B prep: filled on resolution
      prediction: null,       // { action, thesis, confidence } — set by scanner if it trades
      resolved: false,
      outcome: null,          // WIN/LOSS
      actualOutcome: null,    // YES/NO (what actually happened)
    };

    this.data.entries.push(record);
    this.data.meta.totalStored++;
    
    // Prune if over limit
    this._prune();
    
    this._save();
    return record.id;
  }

  /**
   * Attach prediction info to stored research (for Option B tracking)
   */
  attachPrediction(marketId, prediction) {
    const entries = this.data.entries.filter(e => e.marketId === marketId && !e.resolved);
    for (const entry of entries) {
      entry.prediction = prediction; // { action: 'BUY_YES', thesis: '...', confidence: 0.7, entryPrice: 0.63 }
    }
    this._save();
  }

  /**
   * Mark a market as resolved (for outcome tracking)
   */
  markResolved(marketId, outcome, details = {}) {
    const entries = this.data.entries.filter(e => e.marketId === marketId);
    for (const entry of entries) {
      entry.resolved = true;
      entry.outcome = entry.prediction ? 
        (outcome === entry.prediction.action.replace('BUY_', '').toLowerCase() ? 'WIN' : 'LOSS') : null;
      entry.actualOutcome = outcome; // 'yes' or 'no'
      entry.resolvedAt = Date.now();
      if (details.actualPrice !== undefined) entry.actualPrice = details.actualPrice;
    }
    this._save();
  }

  /**
   * Retrieve relevant research for a market question.
   * 
   * Returns research entries ranked by: similarity × freshness_weight
   * Priority: exact marketId matches first, then semantic similarity
   * 
   * @param {string} question - Market question to search for
   * @param {Object} options
   * @param {number} options.maxResults - Max entries to return (default 5)
   * @param {number} options.maxAgeHours - Ignore entries older than this (default 48)
   * @param {string} options.marketId - Boost exact market matches
   * @param {string} options.category - Category hint for decay tuning
   * @returns {Object[]} Ranked research entries with scores
   */
  async retrieve(question, options = {}) {
    const { maxResults = 5, maxAgeHours = 48, marketId = null, category = 'other' } = options;
    
    if (this.data.entries.length === 0) return [];
    
    const queryEmbedding = await this._embed(`${category}: ${question}`);
    const now = Date.now();
    const cutoff = now - maxAgeHours * 60 * 60 * 1000;
    const halfLife = category === 'sports' ? SPORTS_HALF_LIFE_HOURS : DEFAULT_HALF_LIFE_HOURS;

    const scored = [];
    
    for (const entry of this.data.entries) {
      // Age filter
      if (entry.timestamp < cutoff) continue;
      
      // Similarity
      const similarity = this._cosineSim(queryEmbedding, entry.embedding);
      
      // Time decay
      const decay = this._decayWeight(entry.timestamp, halfLife);
      
      // Market ID boost: exact match gets 2x, same event gets 1.5x
      let marketBoost = 1.0;
      if (marketId && entry.marketId === marketId) marketBoost = 2.0;
      
      // Effective score
      const score = similarity * decay * marketBoost;
      
      scored.push({
        ...entry,
        _score: score,
        _similarity: similarity,
        _decay: decay,
        _marketBoost: marketBoost,
        _hoursAgo: Math.round((now - entry.timestamp) / (1000 * 60 * 60) * 10) / 10,
      });
    }

    // Sort by score descending
    scored.sort((a, b) => b._score - a._score);

    // Return top results (strip embeddings to save space)
    return scored.slice(0, maxResults).map(e => ({
      id: e.id,
      question: e.question,
      category: e.category,
      facts: e.facts,
      sources: e.sources,
      complete: e.complete,
      prices: e.prices,
      prediction: e.prediction,
      resolved: e.resolved,
      outcome: e.outcome,
      hoursAgo: e._hoursAgo,
      score: Math.round(e._score * 1000) / 1000,
      similarity: Math.round(e._similarity * 1000) / 1000,
      decay: Math.round(e._decay * 1000) / 1000,
      marketBoost: e._marketBoost,
    }));
  }

  /**
   * Get stats about the memory store
   */
  stats() {
    const entries = this.data.entries;
    const resolved = entries.filter(e => e.resolved);
    const withPredictions = entries.filter(e => e.prediction);
    const wins = resolved.filter(e => e.outcome === 'WIN');
    
    return {
      totalEntries: entries.length,
      activeEntries: entries.filter(e => !e.resolved).length,
      resolvedEntries: resolved.length,
      withPredictions: withPredictions.length,
      wins: wins.length,
      losses: resolved.length - wins.length,
      winRate: resolved.length > 0 ? Math.round(wins.length / resolved.length * 100) : null,
      categories: [...new Set(entries.map(e => e.category))],
      oldestEntry: entries.length > 0 ? entries[0].timestampISO : null,
      newestEntry: entries.length > 0 ? entries[entries.length - 1].timestampISO : null,
      ...this.data.meta,
    };
  }

  /**
   * Prune old/decayed entries to keep memory lean
   */
  _prune() {
    const before = this.data.entries.length;
    
    // Remove entries with near-zero decay weight (unless they have outcome data)
    this.data.entries = this.data.entries.filter(e => {
      if (e.resolved && e.prediction) return true; // Keep resolved trades for learning
      const decay = this._decayWeight(e.timestamp);
      return decay >= PRUNE_THRESHOLD;
    });

    // If still over limit, remove oldest non-resolved entries
    if (this.data.entries.length > MAX_ENTRIES) {
      const resolved = this.data.entries.filter(e => e.resolved);
      const active = this.data.entries.filter(e => !e.resolved);
      active.sort((a, b) => b.timestamp - a.timestamp); // Newest first
      this.data.entries = [...active.slice(0, MAX_ENTRIES - resolved.length), ...resolved];
    }

    const pruned = before - this.data.entries.length;
    if (pruned > 0) {
      this.data.meta.totalPruned += pruned;
    }
  }

  /**
   * Compress resolved entries into lessons (for long-term memory)
   * Call periodically (e.g., daily) to keep the file lean
   */
  compressResolved() {
    const resolved = this.data.entries.filter(e => e.resolved && e.prediction);
    if (resolved.length < 10) return null; // Not enough data yet
    
    const lessons = {
      timestamp: new Date().toISOString(),
      totalTrades: resolved.length,
      wins: resolved.filter(e => e.outcome === 'WIN').length,
      losses: resolved.filter(e => e.outcome === 'LOSS').length,
      byCategory: {},
    };

    for (const entry of resolved) {
      const cat = entry.category;
      if (!lessons.byCategory[cat]) {
        lessons.byCategory[cat] = { trades: 0, wins: 0, avgFactCount: 0, avgSourceCount: 0 };
      }
      const c = lessons.byCategory[cat];
      c.trades++;
      if (entry.outcome === 'WIN') c.wins++;
      c.avgFactCount += entry.facts.length;
      c.avgSourceCount += entry.sources.length;
    }

    // Average out
    for (const cat of Object.keys(lessons.byCategory)) {
      const c = lessons.byCategory[cat];
      c.avgFactCount = Math.round(c.avgFactCount / c.trades * 10) / 10;
      c.avgSourceCount = Math.round(c.avgSourceCount / c.trades * 10) / 10;
      c.winRate = Math.round(c.wins / c.trades * 100);
    }

    return lessons;
  }
}

// ═══════════════════════════════════════════════════════════════
// CLI — test/inspect
// ═══════════════════════════════════════════════════════════════

if (require.main === module) {
  const rm = new ResearchMemory();
  const cmd = process.argv[2];

  if (cmd === 'stats') {
    console.log(JSON.stringify(rm.stats(), null, 2));
  } else if (cmd === 'search' && process.argv[3]) {
    rm.retrieve(process.argv.slice(3).join(' ')).then(results => {
      console.log(`Found ${results.length} results:\n`);
      for (const r of results) {
        console.log(`[${r.hoursAgo}h ago] score=${r.score} sim=${r.similarity} decay=${r.decay}`);
        console.log(`  Q: ${r.question.slice(0, 70)}`);
        console.log(`  Facts: ${r.facts.slice(0, 2).join(' | ').slice(0, 120)}`);
        console.log(`  Sources: ${r.sources.join(', ')}`);
        if (r.prices) console.log(`  Prices then: YES=${r.prices.yesAsk} NO=${r.prices.noAsk}`);
        console.log('');
      }
    }).catch(e => console.error(e));
  } else {
    console.log('Usage: node research-memory.js [stats|search <query>]');
    console.log(`Current: ${rm.stats().totalEntries} entries`);
  }
}

module.exports = { ResearchMemory };
