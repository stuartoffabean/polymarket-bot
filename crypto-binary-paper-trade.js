/**
 * Crypto Binary Paper Trade Test
 * 
 * Runs crypto-binary-scanner every 60 seconds for 30+ minutes
 * Logs all opportunities that WOULD have been executed
 * Reports: frequency, spreads, potential profit
 * 
 * DO NOT execute real trades.
 */

const { runCryptoBinaryScan } = require('./crypto-binary-scanner');
const fs = require('fs');
const path = require('path');

const PAPER_TRADE_LOG = path.join(__dirname, 'crypto-binary-paper-trades.json');
const SCAN_INTERVAL_MS = 60 * 1000; // 1 minute
const TEST_DURATION_MS = 35 * 60 * 1000; // 35 minutes

const paperTrades = [];
let scanCount = 0;
let arbCount = 0;

async function runPaperTest() {
  const startTime = Date.now();
  const endTime = startTime + TEST_DURATION_MS;
  
  console.log('═══════════════════════════════════════════════════════');
  console.log('CRYPTO BINARY PAPER TRADE TEST');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log('Duration: 35 minutes');
  console.log('Scan interval: 60 seconds');
  console.log('Expected scans: ~35');
  console.log('');
  console.log('Starting at:', new Date().toISOString());
  console.log('Will end at:', new Date(endTime).toISOString());
  console.log('');
  console.log('─'.repeat(60));
  console.log('');
  
  while (Date.now() < endTime) {
    scanCount++;
    const scanStart = Date.now();
    
    console.log(`[SCAN ${scanCount}] ${new Date().toISOString()}`);
    
    try {
      const results = await runCryptoBinaryScan({
        log: (tag, msg) => {
          if (msg.includes('🎯 ARB')) {
            console.log(`  ${msg}`);
          }
        },
      });
      
      if (results.error) {
        console.log(`  ❌ Error: ${results.error}`);
        continue;
      }
      
      // Log opportunities
      const viableArbs = results.opportunities.filter(o => 
        o.arbOpportunity && o.minDepth >= 50
      );
      
      if (viableArbs.length > 0) {
        arbCount++;
        console.log(`  ✅ ${viableArbs.length} ARB OPPORTUNITY(IES) FOUND`);
        
        viableArbs.forEach(opp => {
          const shares = Math.min(opp.minDepth, 100); // Simulated position size
          const cost = shares * opp.askSum;
          const payout = shares * 1.0;
          const profit = payout - cost;
          
          const trade = {
            scanNumber: scanCount,
            timestamp: new Date().toISOString(),
            market: opp.market,
            slug: opp.slug,
            yesAsk: opp.yesAsk,
            noAsk: opp.noAsk,
            askSum: opp.askSum,
            spread: opp.spread,
            shares,
            cost: +cost.toFixed(2),
            payout: +payout.toFixed(2),
            profit: +profit.toFixed(2),
            profitPct: +((profit / cost) * 100).toFixed(2),
            hoursToEnd: opp.hoursToEnd,
            minDepth: opp.minDepth,
            executed: false, // Paper trade only
          };
          
          paperTrades.push(trade);
          
          console.log(`    • ${opp.market.slice(0, 40)}`);
          console.log(`      Sum: $${opp.askSum} | Profit: $${profit.toFixed(2)} (${trade.profitPct}%) | Shares: ${shares}`);
        });
      } else {
        console.log(`  📊 No arbs | Markets: ${results.summary.marketsScanned} | Avg spread: ${results.summary.avgSpread}%`);
        
        if (results.opportunities.length > 0) {
          const best = results.opportunities[0];
          console.log(`      Best: ${best.market.slice(0, 35)} | Sum: $${best.askSum} | Spread: ${best.spread}%`);
        }
      }
      
    } catch (e) {
      console.log(`  ❌ Scan failed: ${e.message}`);
    }
    
    // Save progress
    const report = {
      testStarted: new Date(startTime).toISOString(),
      testDuration: '35 minutes',
      scansCompleted: scanCount,
      arbOpportunities: arbCount,
      trades: paperTrades,
      summary: {
        totalScans: scanCount,
        scansWithArbs: arbCount,
        totalPaperTrades: paperTrades.length,
        avgProfitPerTrade: paperTrades.length > 0
          ? +(paperTrades.reduce((sum, t) => sum + t.profit, 0) / paperTrades.length).toFixed(2)
          : 0,
        totalPotentialProfit: +paperTrades.reduce((sum, t) => sum + t.profit, 0).toFixed(2),
      },
    };
    
    fs.writeFileSync(PAPER_TRADE_LOG, JSON.stringify(report, null, 2));
    
    // Wait for next scan
    const scanDuration = Date.now() - scanStart;
    const waitTime = Math.max(0, SCAN_INTERVAL_MS - scanDuration);
    
    if (Date.now() + waitTime < endTime) {
      console.log(`  ⏱️  Next scan in ${Math.round(waitTime / 1000)}s\n`);
      await new Promise(r => setTimeout(r, waitTime));
    }
  }
  
  // Final report
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('PAPER TRADE TEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log(`Total scans: ${scanCount}`);
  console.log(`Scans with arb opportunities: ${arbCount}`);
  console.log(`Total paper trades logged: ${paperTrades.length}`);
  console.log('');
  
  if (paperTrades.length > 0) {
    const totalProfit = paperTrades.reduce((sum, t) => sum + t.profit, 0);
    const avgProfit = totalProfit / paperTrades.length;
    const avgProfitPct = paperTrades.reduce((sum, t) => sum + t.profitPct, 0) / paperTrades.length;
    
    console.log('PROFIT ANALYSIS:');
    console.log(`  Total potential profit: $${totalProfit.toFixed(2)}`);
    console.log(`  Avg profit per trade: $${avgProfit.toFixed(2)} (${avgProfitPct.toFixed(2)}%)`);
    console.log(`  Opportunities per hour: ${(arbCount / (TEST_DURATION_MS / 3600000)).toFixed(1)}`);
    console.log('');
    
    console.log('SAMPLE TRADES:');
    paperTrades.slice(0, 5).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.market.slice(0, 50)}`);
      console.log(`     Cost: $${t.cost} | Profit: $${t.profit} (${t.profitPct}%) | ${t.hoursToEnd}h to resolution`);
    });
  } else {
    console.log('❌ NO ARB OPPORTUNITIES DETECTED');
    console.log('');
    console.log('This suggests:');
    console.log('  • Daily crypto binaries are efficiently priced');
    console.log('  • Arb opportunities are rare (< 1 per 35 minutes)');
    console.log('  • Capital velocity from these markets will be LOW');
  }
  
  console.log('');
  console.log(`Full results saved to: ${PAPER_TRADE_LOG}`);
  console.log('');
}

// Run test
if (require.main === module) {
  runPaperTest().catch(e => {
    console.error('Paper trade test failed:', e);
    process.exit(1);
  });
}

module.exports = { runPaperTest };
