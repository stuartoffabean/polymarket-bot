#!/usr/bin/env node
/**
 * Paper Trade Resolution Checker
 * 
 * Checks all open paper trades for market resolution:
 * 1. Fetches current YES price from CLOB
 * 2. If YES ≥ 0.95 → market resolved YES
 * 3. If YES ≤ 0.05 → market resolved NO  
 * 4. Calculates P&L based on resolution vs our position
 * 5. Updates paper trade JSON files
 * 
 * Usage: node resolve-paper.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const RESOLVE_THRESHOLD = 0.95; // YES ≥ 0.95 = resolved YES, ≤ 0.05 = resolved NO

function fetchPrice(tokenId) {
  return new Promise((resolve) => {
    const url = `https://clob.polymarket.com/price?token_id=${encodeURIComponent(tokenId)}&side=buy`;
    const req = https.get(url, { headers: { 'User-Agent': 'PaperTradeResolver/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve(parseFloat(JSON.parse(data).price || 0));
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

// Small delay between requests to avoid rate limiting
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function resolveFile(filePath, dryRun) {
  if (!fs.existsSync(filePath)) return { checked: 0, resolved: 0, results: [] };

  const log = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const trades = log.paperTrades || [];
  
  // Open trades = no resolution OR resolution is null/None
  const openTrades = trades.filter(t => 
    !t.resolution || t.resolution === 'None' || t.resolution === null
  );

  if (openTrades.length === 0) {
    console.log(`  No open trades in ${path.basename(filePath)}`);
    return { checked: 0, resolved: 0, results: [] };
  }

  // Dedupe token lookups (multiple trades can share same YES token)
  const tokenPrices = new Map();
  const uniqueTokens = [...new Set(openTrades.map(t => t.yesToken).filter(Boolean))];
  
  console.log(`  Fetching prices for ${uniqueTokens.length} unique tokens...`);
  
  for (const token of uniqueTokens) {
    const price = await fetchPrice(token);
    if (price !== null) tokenPrices.set(token, price);
    await sleep(100); // Rate limit
  }

  let resolved = 0;
  const results = [];

  for (const trade of openTrades) {
    const yesPrice = tokenPrices.get(trade.yesToken);
    if (yesPrice === undefined || yesPrice === null) continue;

    let marketResolution = null;
    if (yesPrice >= RESOLVE_THRESHOLD) {
      marketResolution = 'YES';
    } else if (yesPrice <= (1 - RESOLVE_THRESHOLD)) {
      marketResolution = 'NO';
    } else {
      continue; // Market still open
    }

    // Determine win/loss
    const isNo = (trade.action || '').includes('NO');
    const weBought = isNo ? 'NO' : 'YES';
    const won = marketResolution === weBought;

    // P&L calculation
    // If we won: we get $1 per share, minus what we paid
    // If we lost: we lose our total cost
    const shares = trade.shares || 0;
    const totalCost = trade.totalCost || (shares * trade.entryPrice);
    const pnl = won
      ? Math.round((shares * 1.0 - totalCost) * 100) / 100  // Win: $1/share - cost
      : Math.round(-totalCost * 100) / 100;                   // Loss: lose entire cost

    const label = trade.question || `${trade.city || ''} ${trade.bucket || ''}`.trim();
    const resultStr = won ? 'WIN' : 'LOSS';

    console.log(`  ${won ? '✅' : '❌'} ${label}: ${resultStr} $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (bought ${weBought} @ ${trade.entryPrice}, resolved ${marketResolution})`);

    if (!dryRun) {
      trade.resolution = resultStr;
      trade.dollarPnl = pnl;
      trade.exitPrice = won ? 1.0 : 0.0;
      trade.exitReason = 'MARKET_RESOLVED';
      trade.exitTimestamp = new Date().toISOString();
      trade.marketResolution = marketResolution;
    }

    resolved++;
    results.push({ label, result: resultStr, pnl, weBought, marketResolution });
  }

  if (!dryRun && resolved > 0) {
    fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
  }

  return { checked: openTrades.length, resolved, results };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`📊 Paper Trade Resolution Checker ${dryRun ? '(DRY RUN)' : ''}\n`);

  const weatherFile = path.join(__dirname, 'weather-v2-paper.json');
  const directionalFile = path.join(__dirname, 'directional-paper.json');

  let totalResolved = 0;
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;

  console.log('--- Weather ---');
  const w = await resolveFile(weatherFile, dryRun);
  console.log(`  Checked: ${w.checked}, Resolved: ${w.resolved}\n`);

  console.log('--- Directional ---');
  const d = await resolveFile(directionalFile, dryRun);
  console.log(`  Checked: ${d.checked}, Resolved: ${d.resolved}\n`);

  const allResults = [...w.results, ...d.results];
  for (const r of allResults) {
    totalResolved++;
    totalPnl += r.pnl;
    if (r.result === 'WIN') wins++; else losses++;
  }

  if (totalResolved > 0) {
    console.log('=== SUMMARY ===');
    console.log(`Resolved: ${totalResolved} trades`);
    console.log(`Wins: ${wins}, Losses: ${losses} (${totalResolved > 0 ? Math.round(wins/totalResolved*100) : 0}% win rate)`);
    console.log(`P&L: $${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`);
  } else {
    console.log('No markets resolved yet.');
  }
}

main().catch(console.error);
