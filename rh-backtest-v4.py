#!/usr/bin/env python3
"""Resolution Hunter Backtest v4 — 96-98¢ range + expanded category/content filters"""
import json, time, sys, os, re
from datetime import datetime, timezone, timedelta
from urllib.request import urlopen, Request

sys.stdout.reconfigure(line_buffering=True)

RH_MIN = 0.96
RH_MAX = 0.98
RH_SPEND = 10.0
DAYS_BACK = 30
NOW = datetime.now(timezone.utc)
CUTOFF = NOW - timedelta(days=DAYS_BACK)

# === EXPANDED FILTERS ===

# Category-level skip (from Gamma API 'category' field)
SKIP_CATEGORIES = re.compile(
    r'sports|esports|gaming|mma|boxing|wrestling|racing|motorsport',
    re.IGNORECASE
)

# Slug-level skip — sports/esports patterns (expanded from v3)
SKIP_SLUGS = re.compile(
    r'esports|valorant|counter-strike|cs2|tennis|nba|nfl|mma|ufc|'
    r'soccer|football|dota|league-of-legends|lol-|r6siege|codmw|'
    r'cricket|boxing|rugby|hockey|nhl|mlb|baseball|basketball|'
    r'a-league|serie-a|la-liga|premier-league|bundesliga|ligue-1|'
    r'eredivisie|copa|champions-league|europa-league|ncaa|'
    r'cbb-|cwbb-|sea-|bun-|efa-|fl1-|ere-|por-|es2-|fr2-|lal-|chi1-|elc-|'
    # NEW: expanded sports coverage
    r'bbl|apex.legends|jack.sock|overwatch|rocket.league|fortnite|'
    r'pubg|rainbow.six|call.of.duty|fifa|f1-|moto-?gp|wwe|aew|'
    r'pga|lpga|atp-|wta-|grand.slam|wimbledon|us.open|'
    r'world.cup|olympics|super.bowl|stanley.cup|world.series|'
    r'arg-|mex-|bra-|ita-|esp-|eng-|ger-|fra-|tur-|'
    r'val-|dota2-|lol-|cs2-|r6-|rl-|'
    # Match patterns: team-vs-team slugs
    r'-spread-|-total-\d|-btts|-handicap-|-draw$',
    re.IGNORECASE
)

# Question-level skip — match patterns + volatile single-data-point markets
SKIP_QUESTIONS = re.compile(
    # Sports/match patterns
    r'vs\.|vs |winner|match|game \d|map handicap|spread:|o\/u \d|'
    r'both teams|total games|score in|home win|away win|'
    # Team names as outcomes
    r'Bears|Bulldogs|Tigers|Eagles|Hawks|Lions|Panthers|Warriors|'
    r'Spartans|Badgers|Crimson|Ramblers|Bobcats|Saints|Cougars|'
    r'Peacocks|Pioneers|Big Green|Quakers|Billikens|'
    # NEW: Earnings/financial
    r'earnings|revenue beat|EPS beat|quarterly results|'
    # NEW: ETF flows
    r'ETF (in|out)flows|ETF flows|net (in|out)flows|'
    # NEW: Crypto price targets (token + dollar amount)
    r'(Bitcoin|BTC|Ethereum|ETH|Solana|SOL|XRP|Doge|DOGE|ADA|DOT|AVAX|MATIC|LINK|UNI|AAVE)'
    r'.*(above|below|over|under|close at|finish at|hit)\s*\$|'
    # NEW: Stock price targets (ticker + above/below + dollar)
    r'(AAPL|MSFT|NVDA|GOOGL|AMZN|META|TSLA|NFLX|AMD|INTC|PLTR|'
    r'OPEN|BA|DIS|UBER|COIN|HOOD|GME|AMC|PYPL|SQ|SHOP|SNAP|PINS|'
    r'RBLX|ABNB|DASH|RIVN|LCID|NIO|F|GM|WMT|TGT|COST|KO|PEP)'
    r'.*(above|below|close|finish)\s*(at\s*)?\$|'
    # Match "Will X close above/below $Y"
    r'close (above|below|at) \$\d|finish.*(above|below) \$\d|'
    # NEW: Person-says-word-during-event
    r'(say|mention|utter|use the word)\b.*\b(during|at|in the)\b|'
    r'(State of the Union|SOTU|debate|press conference|speech|interview).*\b(say|mention)\b|'
    # NEW: Tweet count / social media activity
    r'(tweets?|posts?) from|number of (tweets|posts)|how many (tweets|posts)|'
    # Up/Down daily markets (coin flip territory at 50/50)
    r'Up or Down',
    re.IGNORECASE
)

def should_skip(market):
    """Returns (skip: bool, reason: str)"""
    slug = market.get("slug", "")
    question = market.get("question", "") or market.get("title", "")
    category = market.get("category", "")
    
    if SKIP_CATEGORIES.search(category):
        return True, f"category:{category}"
    if SKIP_SLUGS.search(slug):
        return True, f"slug:{slug[:40]}"
    if SKIP_QUESTIONS.search(question):
        return True, f"question:{question[:60]}"
    return False, ""


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
            continue
        op = m.get("outcomePrices")
        if not op:
            continue
        all_markets.append(m)
        added += 1
    
    print(f"  offset={offset}, batch={len(data)}, added={added}, old={old_count}, total={len(all_markets)}", flush=True)
    
    if old_count > 80:
        consecutive_old += 1
        if consecutive_old >= 3:
            break
    else:
        consecutive_old = 0
    
    offset += 100
    time.sleep(0.3)

print(f"\nTotal resolved markets in window: {len(all_markets)}", flush=True)

# Step 2: Analyze with filters
trades = []
filtered_out = {"category": 0, "slug": 0, "question": 0}
filter_examples = []  # track what got filtered for debugging
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
    
    pre_yes = yes_final - odc
    pre_no = 1.0 - pre_yes
    
    if pre_yes < 0 or pre_yes > 1 or pre_no < 0 or pre_no > 1:
        continue
    
    # Check if any outcome is in our price range BEFORE filtering
    has_eligible = False
    for outcome, price in [("YES", pre_yes), ("NO", pre_no)]:
        if RH_MIN <= price <= RH_MAX:
            has_eligible = True
            break
    
    if not has_eligible:
        continue
    
    # Apply filters
    skip, reason = should_skip(m)
    if skip:
        bucket = reason.split(":")[0]
        filtered_out[bucket] = filtered_out.get(bucket, 0) + 1
        if len(filter_examples) < 30:
            # Check if this would have been a win or loss
            for outcome, price, won in [("YES", pre_yes, yes_won), ("NO", pre_no, not yes_won)]:
                if RH_MIN <= price <= RH_MAX:
                    filter_examples.append({
                        "market": (m.get("question", "?"))[:100],
                        "reason": reason[:60],
                        "price": round(price, 4),
                        "won": won,
                        "pnl": round(((1.0 - price) * (RH_SPEND / price)) if won else (-RH_SPEND), 2),
                    })
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
            
            if price < 0.97: tier = "96-97"
            elif price < 0.98: tier = "97-98"
            else: tier = "98"  # shouldn't happen with max=0.98
            
            trades.append({
                "market": question[:120],
                "outcome": outcome,
                "buyPrice": round(price, 4),
                "won": won,
                "pnl": round(pnl, 4),
                "shares": round(shares, 4),
                "tier": tier,
                "category": category,
                "slug": (m.get("slug", ""))[:80],
                "endDate": m.get("endDate", ""),
            })

print(f"Skipped (no price change data): {skipped_no_change}", flush=True)
print(f"Filtered out: {json.dumps(filtered_out)}", flush=True)
print(f"Total RH-eligible trades after filters: {len(trades)}", flush=True)

if not trades:
    print("NO TRADES FOUND - backtest empty", flush=True)
    result = {
        "version": "v4",
        "parameters": {"RH_MIN": RH_MIN, "RH_MAX": RH_MAX, "RH_SPEND": RH_SPEND, "days": DAYS_BACK},
        "error": "no eligible trades found",
        "markets_analyzed": len(all_markets),
        "filtered_out": filtered_out,
        "filter_examples": filter_examples[:10],
    }
    with open("/data/workspace/polymarket-bot/resolution-hunter-backtest-v4.json", "w") as f:
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

loss_examples = sorted(losses, key=lambda t: t["pnl"])[:15]

# Check filter accuracy — how many filtered trades would have been wins vs losses
filter_wins = sum(1 for e in filter_examples if e["won"])
filter_losses = sum(1 for e in filter_examples if not e["won"])
filter_pnl = sum(e["pnl"] for e in filter_examples)

result = {
    "version": "v4",
    "parameters": {"RH_MIN": RH_MIN, "RH_MAX": RH_MAX, "RH_SPEND": RH_SPEND, "days": DAYS_BACK},
    "summary": {
        "total_markets_analyzed": len(all_markets),
        "total_trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "hit_rate_pct": round(len(wins)/len(trades)*100, 2),
        "net_pnl": round(total_pnl, 2),
        "avg_win": round(avg_win, 4),
        "avg_loss": round(avg_loss, 4),
        "wins_needed_per_loss": round(wins_per_loss, 1),
    },
    "filter_stats": {
        "total_filtered": sum(filtered_out.values()),
        "by_type": filtered_out,
        "sampled_filtered_wins": filter_wins,
        "sampled_filtered_losses": filter_losses,
        "sampled_filtered_pnl": round(filter_pnl, 2),
        "filter_examples": filter_examples[:15],
    },
    "tier_breakdown": {k: {kk: round(vv, 2) if isinstance(vv, float) else vv for kk, vv in v.items()} for k, v in sorted(tiers.items())},
    "category_breakdown": dict(sorted(
        {k: {kk: round(vv, 2) if isinstance(vv, float) else vv for kk, vv in v.items()} for k, v in cats.items()}.items(),
        key=lambda x: -x[1]["trades"]
    )),
    "worst_losses": [{"market": t["market"], "outcome": t["outcome"], "price": t["buyPrice"], "pnl": round(t["pnl"], 2), "slug": t.get("slug","")[:60], "category": t.get("category","")} for t in loss_examples],
    "recommendation": "DISABLE" if total_pnl <= 0 else "ENABLE",
    "timestamp": NOW.isoformat(),
}

with open("/data/workspace/polymarket-bot/resolution-hunter-backtest-v4.json", "w") as f:
    json.dump(result, f, indent=2)

# Print summary
print("\n" + "="*60, flush=True)
print("RESOLUTION HUNTER v4 BACKTEST RESULTS", flush=True)
print(f"Parameters: {RH_MIN}-{RH_MAX} range, ${RH_SPEND} spend", flush=True)
print("="*60, flush=True)
print(f"Markets analyzed: {len(all_markets)}", flush=True)
print(f"Filtered out: {sum(filtered_out.values())} (cat={filtered_out.get('category',0)}, slug={filtered_out.get('slug',0)}, question={filtered_out.get('question',0)})", flush=True)
print(f"Eligible trades: {len(trades)}", flush=True)
print(f"Wins: {len(wins)} | Losses: {len(losses)}", flush=True)
print(f"Hit rate: {len(wins)/len(trades)*100:.1f}%", flush=True)
print(f"Net P&L: ${total_pnl:.2f}", flush=True)
print(f"Avg win: ${avg_win:.4f} | Avg loss: ${avg_loss:.4f}", flush=True)
print(f"Wins needed per loss: {wins_per_loss:.1f}", flush=True)
print(f"\nFilter accuracy (sample of {len(filter_examples)}):", flush=True)
print(f"  Filtered wins: {filter_wins} | Filtered losses: {filter_losses}", flush=True)
print(f"  Filtered P&L: ${filter_pnl:.2f} (positive = filter removed profitable trades)", flush=True)
print(f"\nTier breakdown:", flush=True)
for tier in sorted(tiers.keys()):
    d = tiers[tier]
    hr = d["wins"]/d["trades"]*100 if d["trades"] else 0
    print(f"  {tier}¢: {d['trades']}t, {hr:.0f}% hit, ${d['pnl']:.2f}", flush=True)
print(f"\nTop categories:", flush=True)
for cat, d in sorted(cats.items(), key=lambda x: -x[1]["trades"])[:10]:
    hr = d["wins"]/d["trades"]*100 if d["trades"] else 0
    print(f"  {cat}: {d['trades']}t, {hr:.0f}% hit, ${d['pnl']:.2f}", flush=True)
if loss_examples:
    print(f"\nAll losses ({len(losses)}):", flush=True)
    for t in loss_examples:
        print(f"  ${t['pnl']:.2f} | {t['outcome']}@{t['buyPrice']} | {t['category']} | {t['market'][:80]}", flush=True)
print(f"\nRECOMMENDATION: {result['recommendation']}", flush=True)
