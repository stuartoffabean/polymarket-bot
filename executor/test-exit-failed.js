#!/usr/bin/env node
/**
 * Integration test for the exit-failed persistence fix.
 * Tests: GET /exit-failed, POST /clear-exit-failed, /status includes exitFailed
 * 
 * Run against a live ws-feed on port 3003:
 *   node executor/test-exit-failed.js
 * 
 * Or with a custom port:
 *   FEED_PORT=3003 node executor/test-exit-failed.js
 */

const http = require('http');

const FEED_PORT = process.env.FEED_PORT || 3003;
const BASE = `http://localhost:${FEED_PORT}`;

let passed = 0;
let failed = 0;

function httpReq(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: FEED_PORT,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

async function run() {
  console.log(`\n🧪 Exit-Failed Persistence Tests (port ${FEED_PORT})\n`);

  // Test 1: GET /exit-failed returns valid response
  console.log('Test 1: GET /exit-failed');
  try {
    const res = await httpReq('GET', '/exit-failed');
    assert(res.status === 200, `Status 200 (got ${res.status})`);
    assert(typeof res.body.count === 'number', `count is a number (${res.body.count})`);
    assert(Array.isArray(res.body.assets), 'assets is an array');
  } catch (e) {
    assert(false, `Request failed: ${e.message}`);
  }

  // Test 2: /status includes exitFailedCount
  console.log('\nTest 2: /status includes exitFailed info');
  try {
    const res = await httpReq('GET', '/status');
    assert(res.status === 200, `Status 200 (got ${res.status})`);
    assert(typeof res.body.risk.exitFailedCount === 'number', `exitFailedCount present (${res.body.risk.exitFailedCount})`);
    assert(Array.isArray(res.body.risk.exitFailedAssets), 'exitFailedAssets is an array');
  } catch (e) {
    assert(false, `Request failed: ${e.message}`);
  }

  // Test 3: POST /clear-exit-failed with empty body clears all
  console.log('\nTest 3: POST /clear-exit-failed (clear all)');
  try {
    const res = await httpReq('POST', '/clear-exit-failed', {});
    assert(res.status === 200, `Status 200 (got ${res.status})`);
    assert(res.body.ok === true, 'ok: true');
    assert(typeof res.body.clearedCount === 'number', `clearedCount is a number (${res.body.clearedCount})`);
  } catch (e) {
    assert(false, `Request failed: ${e.message}`);
  }

  // Test 4: After clear, count should be 0
  console.log('\nTest 4: Verify count is 0 after clear');
  try {
    const res = await httpReq('GET', '/exit-failed');
    assert(res.body.count === 0, `count is 0 (got ${res.body.count})`);
    assert(res.body.assets.length === 0, `assets array is empty`);
  } catch (e) {
    assert(false, `Request failed: ${e.message}`);
  }

  // Test 5: POST /clear-exit-failed with specific assetId
  console.log('\nTest 5: POST /clear-exit-failed with specific assetId');
  try {
    const fakeAssetId = 'test_' + Date.now();
    const res = await httpReq('POST', '/clear-exit-failed', { assetId: fakeAssetId });
    assert(res.status === 200, `Status 200 (got ${res.status})`);
    assert(res.body.ok === true, 'ok: true');
    assert(res.body.cleared === false, `cleared: false for non-existent asset`);
  } catch (e) {
    assert(false, `Request failed: ${e.message}`);
  }

  // Summary
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('⚠️  Some tests failed — ws-feed may not be running or endpoint is broken');
    process.exit(1);
  } else {
    console.log('✅ All tests passed');
    process.exit(0);
  }
}

run().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
