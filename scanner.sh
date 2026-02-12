#!/bin/bash
# Polymarket Scanner - fetch markets and CLOB prices

OUTPUT_DIR="/data/workspace/polymarket-bot"

# Step 1: Fetch all markets
echo "Fetching markets..."
curl -s "https://gamma-api.polymarket.com/markets?closed=false&order=volume24hr&ascending=false&limit=50&end_date_min=2026-02-12&end_date_max=2026-02-19" > "$OUTPUT_DIR/raw-markets.json"

# Step 2: Process with node
node -e '
const fs = require("fs");
const https = require("https");
const http = require("http");

const markets = JSON.parse(fs.readFileSync("/data/workspace/polymarket-bot/raw-markets.json", "utf8"));

// Filter volume > 50K
const filtered = markets.filter(m => m.volume24hr > 50000);
console.log(`Found ${filtered.length} markets with volume24hr > $50K`);

async function fetchPrice(tokenId, side) {
  return new Promise((resolve) => {
    const url = `https://clob.polymarket.com/price?token_id=${tokenId}&side=${side}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({price: null}); }
      });
    }).on("error", () => resolve({price: null}));
  });
}

async function fetchMidpoint(tokenId) {
  return new Promise((resolve) => {
    const url = `https://clob.polymarket.com/midpoint?token_id=${tokenId}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({mid: null}); }
      });
    }).on("error", () => resolve({mid: null}));
  });
}

async function run() {
  const results = [];
  
  for (const m of filtered) {
    let tokenIds;
    try {
      tokenIds = JSON.parse(m.clobTokenIds);
    } catch(e) {
      console.log(`Skipping ${m.slug} - no token IDs`);
      continue;
    }
    
    if (tokenIds.length < 2) continue;
    
    const yesToken = tokenIds[0];
    const noToken = tokenIds[1];
    
    console.log(`Fetching prices for ${m.slug}...`);
    
    const [yesBuy, yesSell, noBuy, noSell] = await Promise.all([
      fetchPrice(yesToken, "buy"),
      fetchPrice(yesToken, "sell"),
      fetchPrice(noToken, "buy"),
      fetchPrice(noToken, "sell"),
    ]);
    
    const yb = parseFloat(yesBuy.price) || null;
    const ys = parseFloat(yesSell.price) || null;
    const nb = parseFloat(noBuy.price) || null;
    const ns = parseFloat(noSell.price) || null;
    
    const sumBuy = (yb && nb) ? +(yb + nb).toFixed(4) : null;
    const spread = (ys && yb) ? +(ys - yb).toFixed(4) : null;
    const arbSignal = sumBuy !== null && Math.abs(sumBuy - 1.0) > 0.015;
    
    results.push({
      slug: m.slug,
      question: m.question,
      end_date: m.endDate,
      volume24hr: Math.round(m.volume24hr),
      liquidity: Math.round(m.liquidityNum || 0),
      outcomePrices: m.outcomePrices,
      YES_buy: yb,
      YES_sell: ys,
      NO_buy: nb,
      NO_sell: ns,
      spread: spread,
      sumYesBuyNoBuy: sumBuy,
      arbitrage: arbSignal,
      bestBid: m.bestBid,
      bestAsk: m.bestAsk,
    });
    
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }
  
  fs.writeFileSync("/data/workspace/polymarket-bot/scanner-output.json", JSON.stringify(results, null, 2));
  console.log(`\nDone. Saved ${results.length} markets to scanner-output.json`);
  
  // Generate summary
  let md = "# Polymarket Scanner Summary\n";
  md += `**Scan time:** ${new Date().toISOString()}\n`;
  md += `**Markets scanned:** ${results.length} (volume24hr > $50K, closing Feb 12-19)\n\n`;
  
  // Arbitrage opportunities
  const arbs = results.filter(r => r.arbitrage);
  md += "## 🚨 Arbitrage Signals\n\n";
  if (arbs.length === 0) {
    md += "No significant arbitrage detected (all YES+NO sums within 1.5% of 1.00)\n\n";
  } else {
    for (const a of arbs) {
      md += `- **${a.question}** (${a.slug}): YES_buy=${a.YES_buy} + NO_buy=${a.NO_buy} = **${a.sumYesBuyNoBuy}** (deviation: ${+(a.sumYesBuyNoBuy - 1.0).toFixed(4)})\n`;
    }
    md += "\n";
  }
  
  // All markets table
  md += "## All Markets\n\n";
  md += "| Market | End Date | Vol24h | Liq | YES buy | NO buy | Sum | Spread | Arb? |\n";
  md += "|--------|----------|--------|-----|---------|--------|-----|--------|------|\n";
  for (const r of results) {
    md += `| ${r.question} | ${r.end_date?.slice(0,10)} | $${(r.volume24hr/1000).toFixed(0)}K | $${(r.liquidity/1000).toFixed(0)}K | ${r.YES_buy} | ${r.NO_buy} | ${r.sumYesBuyNoBuy} | ${r.spread} | ${r.arbitrage ? "⚠️" : "✅"} |\n`;
  }
  
  md += "\n## Notable Markets (Non-Sports)\n\n";
  const nonSports = results.filter(r => !r.slug.startsWith("nba-") && !r.slug.startsWith("nhl-") && !r.slug.startsWith("ncaa"));
  for (const r of nonSports) {
    md += `### ${r.question}\n`;
    md += `- **Slug:** ${r.slug}\n`;
    md += `- **End:** ${r.end_date}\n`;
    md += `- **Volume 24h:** $${r.volume24hr.toLocaleString()}\n`;
    md += `- **YES buy:** ${r.YES_buy} | **YES sell:** ${r.YES_sell}\n`;
    md += `- **NO buy:** ${r.NO_buy} | **NO sell:** ${r.NO_sell}\n`;
    md += `- **Sum (YES+NO buy):** ${r.sumYesBuyNoBuy}\n\n`;
  }
  
  fs.writeFileSync("/data/workspace/polymarket-bot/scanner-summary.md", md);
  console.log("Saved scanner-summary.md");
}

run().catch(e => console.error(e));
'
