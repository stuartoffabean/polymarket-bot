/**
 * POLYMARKET COPY TRADING LATENCY MONITOR
 * 
 * Watches top trader wallets and measures price movement after their trades.
 * Run for 48 hours to assess whether copy trading adds fatal latency.
 * 
 * Usage: node copy-trade-monitor.js
 */

const { ethers } = require('ethers');
const fs = require('fs').promises;
const path = require('path');

// ===== CONFIGURATION =====
const CONFIG = {
  // Top 3 most active wallets to monitor (from leaderboard analysis)
  WALLETS_TO_MONITOR: [
    '0x492442eab586f242b53bda933fd5de859c8a3782', // Rank #1: $35.4M volume
    '0xdb27bf2ac5d428a9c63dbc914611036855a6c56e', // DrPufferfish: $24.9M volume
    '0x63ce342161250d705dc0b16df89036c8e5f9ba9a'  // 0x8dxd: $41.5M volume
  ],

  // Polygon RPC endpoint
  POLYGON_RPC: 'https://polygon-rpc.com',
  
  // Polymarket CLOB API (with fallback proxy)
  CLOB_API: 'https://clob.polymarket.com',
  CLOB_PROXY: 'https://proxy-rosy-sigma-25.vercel.app',
  
  // Polymarket Gamma API
  GAMMA_API: 'https://gamma-api.polymarket.com',
  
  // Price check intervals (seconds after trade detection)
  PRICE_CHECK_INTERVALS: [30, 60, 300], // 30s, 1min, 5min
  
  // Output file
  OUTPUT_FILE: path.join(__dirname, 'latency-data.json'),
  
  // Polymarket CTF Exchange contract address (mainnet Polygon)
  CTF_EXCHANGE_ADDRESS: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  
  // Polymarket CTF Exchange ABI (simplified - just events we need)
  CTF_EXCHANGE_ABI: [
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)'
  ]
};

// ===== STATE =====
let provider;
let contract;
let monitoredTrades = [];
let activeChecks = new Map(); // orderHash -> timeout IDs

// ===== INITIALIZATION =====
async function init() {
  console.log('🚀 Polymarket Copy Trading Latency Monitor');
  console.log('==========================================\n');
  console.log('Monitored Wallets:');
  CONFIG.WALLETS_TO_MONITOR.forEach((wallet, i) => {
    console.log(`  ${i + 1}. ${wallet}`);
  });
  console.log(`\nPolygon RPC: ${CONFIG.POLYGON_RPC}`);
  console.log(`Output: ${CONFIG.OUTPUT_FILE}\n`);
  
  // Initialize provider
  provider = new ethers.JsonRpcProvider(CONFIG.POLYGON_RPC);
  
  // Initialize contract
  contract = new ethers.Contract(
    CONFIG.CTF_EXCHANGE_ADDRESS,
    CONFIG.CTF_EXCHANGE_ABI,
    provider
  );
  
  // Load existing data if available
  try {
    const data = await fs.readFile(CONFIG.OUTPUT_FILE, 'utf-8');
    monitoredTrades = JSON.parse(data);
    console.log(`📂 Loaded ${monitoredTrades.length} existing trade records\n`);
  } catch (err) {
    console.log('📝 Starting fresh log\n');
    monitoredTrades = [];
  }
  
  console.log('⏳ Listening for trades...\n');
}

// ===== MARKET DATA FETCHING =====
async function getMarketInfo(tokenId) {
  try {
    // Try primary CLOB API
    const response = await fetch(`${CONFIG.CLOB_API}/book?token_id=${tokenId}`);
    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    console.error(`⚠️  Primary CLOB API failed: ${err.message}`);
  }
  
  try {
    // Fallback to proxy
    const response = await fetch(`${CONFIG.CLOB_PROXY}/book?token_id=${tokenId}`);
    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    console.error(`⚠️  Proxy CLOB API failed: ${err.message}`);
  }
  
  return null;
}

async function getCurrentPrice(tokenId) {
  const bookData = await getMarketInfo(tokenId);
  if (!bookData || !bookData.bids || !bookData.asks) {
    return null;
  }
  
  // Calculate mid-price
  const bestBid = bookData.bids.length > 0 ? parseFloat(bookData.bids[0].price) : 0;
  const bestAsk = bookData.asks.length > 0 ? parseFloat(bookData.asks[0].price) : 1;
  
  return {
    bid: bestBid,
    ask: bestAsk,
    mid: (bestBid + bestAsk) / 2,
    spread: bestAsk - bestBid
  };
}

async function getMarketDetails(tokenId) {
  try {
    const response = await fetch(`${CONFIG.GAMMA_API}/markets?token_id=${tokenId}`);
    if (response.ok) {
      const data = await response.json();
      return data[0] || null;
    }
  } catch (err) {
    console.error(`⚠️  Failed to fetch market details: ${err.message}`);
  }
  return null;
}

// ===== TRADE MONITORING =====
async function handleOrderFilled(orderHash, maker, taker, makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee, event) {
  const makerLower = maker.toLowerCase();
  const takerLower = taker.toLowerCase();
  
  // Check if either maker or taker is a monitored wallet
  const monitoredWallet = CONFIG.WALLETS_TO_MONITOR.find(
    w => w.toLowerCase() === makerLower || w.toLowerCase() === takerLower
  );
  
  if (!monitoredWallet) {
    return;
  }
  
  const block = await event.getBlock();
  const timestamp = new Date(block.timestamp * 1000).toISOString();
  
  // Determine which token they bought
  const isMaker = monitoredWallet.toLowerCase() === makerLower;
  const tokenBought = isMaker ? makerAssetId.toString() : takerAssetId.toString();
  
  console.log(`\n🔔 TRADE DETECTED`);
  console.log(`   Wallet: ${monitoredWallet}`);
  console.log(`   Token: ${tokenBought}`);
  console.log(`   Time: ${timestamp}`);
  console.log(`   Tx: ${event.transactionHash}`);
  
  // Get market details
  const marketDetails = await getMarketDetails(tokenBought);
  const marketName = marketDetails ? marketDetails.question : 'Unknown';
  
  console.log(`   Market: ${marketName}`);
  
  // Get initial price
  const initialPrice = await getCurrentPrice(tokenBought);
  
  if (!initialPrice) {
    console.log(`   ⚠️  Could not fetch initial price`);
    return;
  }
  
  console.log(`   Price at trade: ${initialPrice.mid.toFixed(4)} (spread: ${(initialPrice.spread * 100).toFixed(2)}%)`);
  
  // Create trade record
  const tradeRecord = {
    orderHash: orderHash,
    wallet: monitoredWallet,
    tokenId: tokenBought,
    market: marketName,
    timestamp: timestamp,
    txHash: event.transactionHash,
    blockNumber: event.blockNumber,
    initialPrice: initialPrice,
    priceChecks: []
  };
  
  // Schedule price checks
  for (const interval of CONFIG.PRICE_CHECK_INTERVALS) {
    setTimeout(async () => {
      await checkPriceMovement(tradeRecord, interval);
    }, interval * 1000);
  }
  
  monitoredTrades.push(tradeRecord);
  await saveData();
}

async function checkPriceMovement(tradeRecord, secondsAfter) {
  const currentPrice = await getCurrentPrice(tradeRecord.tokenId);
  
  if (!currentPrice) {
    console.log(`   ⚠️  Could not fetch price at +${secondsAfter}s`);
    return;
  }
  
  const priceChange = currentPrice.mid - tradeRecord.initialPrice.mid;
  const priceChangePct = (priceChange / tradeRecord.initialPrice.mid) * 100;
  
  const check = {
    secondsAfter: secondsAfter,
    timestamp: new Date().toISOString(),
    price: currentPrice,
    priceChange: priceChange,
    priceChangePct: priceChangePct
  };
  
  tradeRecord.priceChecks.push(check);
  
  console.log(`   ⏱️  +${secondsAfter}s: ${currentPrice.mid.toFixed(4)} (${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%)`);
  
  await saveData();
}

async function saveData() {
  try {
    await fs.writeFile(
      CONFIG.OUTPUT_FILE,
      JSON.stringify(monitoredTrades, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.error(`❌ Failed to save data: ${err.message}`);
  }
}

// ===== MAIN =====
async function main() {
  await init();
  
  // Listen for OrderFilled events
  contract.on('OrderFilled', handleOrderFilled);
  
  // Log heartbeat every 5 minutes
  setInterval(() => {
    console.log(`\n💓 Monitoring active | ${monitoredTrades.length} trades logged | ${new Date().toISOString()}`);
  }, 5 * 60 * 1000);
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down...');
    await saveData();
    console.log(`📊 Final count: ${monitoredTrades.length} trades logged`);
    console.log(`💾 Data saved to: ${CONFIG.OUTPUT_FILE}`);
    process.exit(0);
  });
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
