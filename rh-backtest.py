#!/usr/bin/env python3
"""Resolution Hunter Backtest"""
import json, time, sys, os
from datetime import datetime, timezone, timedelta
from urllib.request import urlopen, Request

sys.stdout.reconfigure(line_buffering=True)

RH_MIN = 0.95
RH_MAX = 0.995
RH_SPEND = 15.0
DAYS_BACK = 30
NOW = datetime.now(timezone.utc)
CUTOFF = NOW - timedelta(days=DAYS_BACK)

def fetch_json(url, retries=3):
    for attempt in range(retries):
        try:
            req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:
            if attempt == retries - 1:
                print(f"FAIL {url}: {e}", flush=True)
                return None
            time.sleep(2)

def parse_dt(s):
    if not s: return None
    try:
        s = s.replace('Z', '+00:00')
        if '+' not in s and s.count('-') <= 2:
            s += '+00:00'
        return datetime.fromisoformat(s)
    except:
        return None

# Step 1: Pull resolved markets
print("Fetching resolved markets...", flush=True)
all_markets = []
offset = 0
consecutive_old = 0

while offset < 10000:
    url = f"https://gamma-api.polymarket.com/markets?closed=true&limit=100&offset={offset}&order=endDate&ascending=false"
    data = fetch_json(url)
    if not data or len(data) == 0:
        print(f"  No more data at offset {offset}", flush=True)
        break
    
    added = 0
    old_count = 0
    for m in data:
        ct = m.get("closedTime") or m.get("endDate")
        dt = parse_dt(ct)
        if not dt:
            continue
        if dt < CUTOFF:
            old_count += 1
            continue
        if dt > NOW:
            continue  # future endDate but closed early - skip if no closedTime
        # Must be resolved
        op = m.get("outcomePrices")
        if not op:
            continue
        all_markets.append(m)
        added += 1
    
    print(f"  offset={offset}, batch={len(data)}, added={added}, old={old_count}, total={len(all_markets)}", flush=True)
    
    if old_count > 80:
        consecutive_old += 1
        if consecutive_old >= 3:
            print("  3 consecutive mostly-old batches, stopping", flush=True)
            break
    else:
        consecutive_old = 0
    
    offset += 100
    time.sleep(0.3)

print(f"\nTotal resolved markets in window: {len(all_markets)}", flush=True)

# Step 2: Analyze
trades = []
skipped_no_change = 0
for m in all_markets:
    op_raw = m.get("outcomePrices")
    odc_raw = m.get("oneDayPriceChange")
    
    if not op_raw:
        continue
    
    try:
        if isinstance(op_raw, str):
            outcome_prices = json.loads(op_raw)
        else:
            outcome_prices = list(op_raw)
        outcome_prices = [float(x) for x in outcome_prices]
    except:
        continue
    
    if len(outcome_prices) < 2:
        continue
    
    yes_final = outcome_prices[0]
    
    # Must be clearly resolved
    if not (yes_final > 0.95 or yes_final < 0.05):
        continue
    
    yes_won = yes_final > 0.5
    
    if odc_raw is None:
        skipped_no_change += 1
        continue
    
    try:
        odc = float(odc_raw)
    except:
        skipped_no_change += 1
        continue
    
    # Reconstruct pre-resolution YES price
    pre_yes = yes_final - odc
    pre_no = 1.0 - pre_yes
    
    if pre_yes < 0 or pre_yes > 1 or pre_no < 0 or pre_no > 1:
        continue
    
    category = (m.get("category") or m.get("groupSlug") or "unknown")
    question = m.get("question", "?")
    
    for outcome, price, won in [("YES", pre_yes, yes_won), ("NO", pre_no, not yes_won)]:
        if RH_MIN <= price <= RH_MAX:
            shares = RH_SPEND / price
            if won:
                pnl = (1.0 - price) * shares
            else:
                pnl = -price * shares
            
            if price < 0.96: tier = "95-96"
            elif price < 0.97: tier = "96-97"
            elif price < 0.98: tier = "97-98"
            elif price < 0.99: tier = "98-99"
            else: tier = "99-99.5"
            
            trades.append({
                "market": question[:120],
                "outcome": outcome,
                "buyPrice": round(price, 4),
                "won": won,
                "pnl": round(pnl, 4),
                "shares": round(shares, 4),
                "tier": tier,
                "category": category,
                "endDate": m.get("endDate", ""),
            })

print(f"Skipped (no price change data): {skipped_no_change}", flush=True)
print(f"Total RH-eligible trades: {len(trades)}", flush=True)

if not trades:
    print("NO TRADES FOUND - cannot complete backtest", flush=True)
    result = {"error": "no eligible trades found", "markets_analyzed": len(all_markets), "skipped_no_change": skipped_no_change}
    with open("/data/workspace/polymarket-bot/resolution-hunter-backtest.json", "w") as f:
        json.dump(result, f, indent=2)
    sys.exit(0)

wins = [t for t in trades if t["won"]]
losses = [t for t in trades if not t["won"]]
total_pnl = sum(t["pnl"] for t in trades)

# Tier breakdown
tiers = {}
for t in trades:
    tier = t["tier"]
    if tier not in tiers:
        tiers[tier] = {"trades": 0, "wins": 0, "losses": 0, "pnl": 0.0}
    tiers[tier]["trades"] += 1
    tiers[tier]["wins"] += int(t["won"])
    tiers[tier]["losses"] += int(not t["won"])
    tiers[tier]["pnl"] += t["pnl"]

# Category breakdown
cats = {}
for t in trades:
    c = t["category"]
    if c not in cats:
        cats[c] = {"trades": 0, "wins": 0, "losses": 0, "pnl": 0.0}
    cats[c]["trades"] += 1
    cats[c]["wins"] += int(t["won"])
    cats[c]["losses"] += int(not t["won"])
    cats[c]["pnl"] += t["pnl"]

avg_win = sum(t["pnl"] for t in wins) / len(wins) if wins else 0
avg_loss = sum(t["pnl"] for t in losses) / len(losses) if losses else 0
wins_per_loss = abs(avg_loss / avg_win) if avg_win else float('inf')

loss_examples = sorted(losses, key=lambda t: t["pnl"])[:10]

result = {
    "parameters": {"RH_MIN": RH_MIN, "RH_MAX": RH_MAX, "RH_SPEND": RH_SPEND, "days": DAYS_BACK},
    "summary": {
        "total_markets_analyzed": len(all_markets),
        "total_trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "hit_rate_pct": round(len(wins)/len(trades)*100, 2),
        "gross_pnl": round(total_pnl, 2),
        "net_pnl": round(total_pnl, 2),
        "avg_win": round(avg_win, 4),
        "avg_loss": round(avg_loss, 4),
        "wins_needed_per_loss": round(wins_per_loss, 1),
    },
    "tier_breakdown": {k: {kk: round(vv, 2) if isinstance(vv, float) else vv for kk, vv in v.items()} for k, v in sorted(tiers.items())},
    "category_breakdown": dict(sorted(
        {k: {kk: round(vv, 2) if isinstance(vv, float) else vv for kk, vv in v.items()} for k, v in cats.items()}.items(),
        key=lambda x: -x[1]["trades"]
    )),
    "worst_losses": [{"market": t["market"], "outcome": t["outcome"], "price": t["buyPrice"], "pnl": round(t["pnl"], 2)} for t in loss_examples],
    "recommendation": "DISABLE" if total_pnl <= 0 else "ENABLE_WITH_CAUTION" if wins_per_loss > 15 else "ENABLE",
    "timestamp": NOW.isoformat(),
}

with open("/data/workspace/polymarket-bot/resolution-hunter-backtest.json", "w") as f:
    json.dump(result, f, indent=2)

if total_pnl <= 0:
    with open("/data/workspace/polymarket-bot/RH_DISABLED", "w") as f:
        f.write(f"Resolution Hunter disabled. Net P&L: ${total_pnl:.2f}\n")

# Print summary
print("\n" + "="*60, flush=True)
print("RESOLUTION HUNTER BACKTEST RESULTS", flush=True)
print("="*60, flush=True)
print(f"Markets analyzed: {len(all_markets)}", flush=True)
print(f"Eligible trades: {len(trades)}", flush=True)
print(f"Wins: {len(wins)} | Losses: {len(losses)}", flush=True)
print(f"Hit rate: {len(wins)/len(trades)*100:.1f}%", flush=True)
print(f"Net P&L: ${total_pnl:.2f}", flush=True)
print(f"Avg win: ${avg_win:.4f} | Avg loss: ${avg_loss:.4f}", flush=True)
print(f"Wins needed per loss: {wins_per_loss:.1f}", flush=True)
print(f"\nTier breakdown:", flush=True)
for tier in sorted(tiers.keys()):
    d = tiers[tier]
    hr = d["wins"]/d["trades"]*100 if d["trades"] else 0
    print(f"  {tier}¢: {d['trades']}t, {hr:.0f}% hit, ${d['pnl']:.2f}", flush=True)
print(f"\nTop categories:", flush=True)
for cat, d in sorted(cats.items(), key=lambda x: -x[1]["trades"])[:8]:
    hr = d["wins"]/d["trades"]*100 if d["trades"] else 0
    print(f"  {cat}: {d['trades']}t, {hr:.0f}% hit, ${d['pnl']:.2f}", flush=True)
if loss_examples:
    print(f"\nWorst losses:", flush=True)
    for t in loss_examples[:5]:
        print(f"  ${t['pnl']:.2f} | {t['outcome']}@{t['buyPrice']} | {t['market'][:80]}", flush=True)
print(f"\nRECOMMENDATION: {result['recommendation']}", flush=True)
