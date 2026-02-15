#!/usr/bin/env node
/**
 * Redeem resolved positions on Polymarket CTF.
 * For NegRisk markets, calls redeemPositions on the CTF contract directly.
 * 
 * Usage: node redeem.js [conditionId]
 * If no conditionId, scans all positions for redeemable ones.
 */

require('dotenv').config();
const { ethers } = require('ethers');

// Contract addresses on Polygon
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // Gnosis CTF
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e on Polygon
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'; // NegRisk adapter

// CTF ABI (only what we need)
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
];

// NegRisk Adapter ABI
const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] calldata indexSets) external',
];

const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
];

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY not set in .env');

  const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new ethers.Wallet(pk, provider);
  console.log('Wallet:', wallet.address);

  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

  // Bangladesh BNP market
  const conditionId = process.argv[2] || '0x36f83a594b8d82801794bad2063f2861a99aebe28cf2cb55c3fd722d1a6d071b';
  const tokenId = '77587680906182806497450061873126722297392583495948543397251590274471719007220';
  
  console.log('\n--- Market Info ---');
  console.log('ConditionId:', conditionId);
  console.log('TokenId (YES):', tokenId);

  // Check if condition is resolved
  const denominator = await ctf.payoutDenominator(conditionId);
  console.log('Payout denominator:', denominator.toString());
  
  if (denominator.eq(0)) {
    console.log('❌ Condition NOT resolved yet on CTF contract. Cannot redeem.');
    console.log('The market may be closed on CLOB but not yet resolved on-chain.');
    
    // Check if this is a NegRisk market — resolution goes through NegRisk adapter
    console.log('\nChecking NegRisk adapter...');
    // For NegRisk, the actual conditionId on CTF might be different
    // NegRisk wraps conditions — need to check the adapter
    
    // Let's check our token balance
    const balance = await ctf.balanceOf(wallet.address, tokenId);
    console.log('Our token balance:', ethers.utils.formatUnits(balance, 6), '(raw:', balance.toString(), ')');
    
    // Check USDC balance before
    const usdcBal = await usdc.balanceOf(wallet.address);
    console.log('USDC.e balance:', ethers.utils.formatUnits(usdcBal, 6));
    
    return;
  }

  // Check payouts
  const payout0 = await ctf.payoutNumerators(conditionId, 0);
  const payout1 = await ctf.payoutNumerators(conditionId, 1);
  console.log('Payout numerators: [', payout0.toString(), ',', payout1.toString(), ']');

  // Check our token balance
  const balance = await ctf.balanceOf(wallet.address, tokenId);
  console.log('Our YES token balance:', balance.toString());
  
  if (balance.eq(0)) {
    console.log('No tokens to redeem.');
    return;
  }

  // Check USDC balance before
  const usdcBefore = await usdc.balanceOf(wallet.address);
  console.log('USDC.e before:', ethers.utils.formatUnits(usdcBefore, 6));

  // Redeem — indexSets [1] = first outcome (YES), [2] = second outcome (NO), [1,2] = both
  console.log('\n🔄 Redeeming positions...');
  const parentCollectionId = ethers.constants.HashZero;
  const indexSets = [1, 2]; // Redeem both YES and NO positions

  const tx = await ctf.redeemPositions(USDC_ADDRESS, parentCollectionId, conditionId, indexSets, {
    gasLimit: 300000,
  });
  console.log('TX hash:', tx.hash);
  console.log('Waiting for confirmation...');
  
  const receipt = await tx.wait();
  console.log('✅ Confirmed in block', receipt.blockNumber);
  console.log('Gas used:', receipt.gasUsed.toString());

  // Check USDC balance after
  const usdcAfter = await usdc.balanceOf(wallet.address);
  console.log('USDC.e after:', ethers.utils.formatUnits(usdcAfter, 6));
  console.log('💰 Received:', ethers.utils.formatUnits(usdcAfter.sub(usdcBefore), 6), 'USDC.e');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
