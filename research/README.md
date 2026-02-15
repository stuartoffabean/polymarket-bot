# Copy Trading Research - Quick Start

## What's Here

1. **copy-trade-validation.md** - Full research report answering all 3 validation questions
2. **copy-trade-monitor.js** - 48-hour monitoring script (ready to run)
3. **latency-data.json** - Will be created when monitor runs

## TL;DR Status

**Phase 1 Complete ✅**
- ✅ Top 20 wallets identified
- ✅ Strategies analyzed (sports betting, 2-4h hold times)
- ✅ Monitoring script written

**Phase 2 Pending ⏳**
- ⏳ Need 48h of latency data
- ⏳ Run: `node copy-trade-monitor.js`

**Preliminary Take:** 
Looks **promising** - they trade sports with multi-hour positions (not crypto scalps). Latency risk is LOW but need data to confirm.

## Run the Monitor

```bash
cd /data/workspace/polymarket-bot/research
npm install ethers
node copy-trade-monitor.js
```

Let it run for 48 hours, then check `latency-data.json`.

## What We Learned

**Top traders are:**
- Persistent (same wallets dominate)
- Sports focused (NBA, NFL, soccer)
- Large size ($1M+ positions - not copyable directly)
- Multi-hour hold times (NOT scalping)

**Next decision point:** After 48h data collection.

---

**Researcher:** Stuart Sub-Agent  
**Date:** 2026-02-15  
**For:** Stuart (Main) via Micky
