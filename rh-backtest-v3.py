#!/usr/bin/env python3
"""Resolution Hunter Backtest v3 — with sports/esports filter.
Uses concurrent fetching and skips crypto up/down micro-markets."""
import json, re, sys, time, urllib.request
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

def log(msg):
    print(msg, flush=True)

RH_MIN = 0.95
RH_MAX = 0.98
RH_SPEND = 10.0

SLUG_FILTER = re.compile(
    r'esports|valorant|counter-strike|cs2|tennis|nba|nfl|mma|ufc|soccer|football|dota|'
    r'league-of-legends|lol-|r6siege|codmw|cricket|boxing|rugby|hockey|nhl|mlb|baseball|'
    r'basketball|a-league|serie-a|la-liga|premier-league|bundesliga|ligue-1|eredivisie|'
    r'copa|champions-league|europa-league|ncaa|cbb-|cwbb-|sea-|bun-|efa-|fl1-|ere-|'
    r'por-|es2-|fr2-|lal-|chi1-|elc-', re.IGNORECASE)

QUESTION_FILTER = re.compile(
    r'vs\.|vs |winner|match|game \d|map handicap|spread:|o/u \d|both teams|total games|score in',
    re.IGNORECASE)

# Skip crypto up/down micro-markets (not relevant to RH strategy and there are 80k+ of them)
CRYPTO_UPDOWN = re.compile(r'up.or.down|updown', re.IGNORECASE)

def is_sports(market):
    slug = market.get('slug', '')
    question = market.get('question', '')
    return bool(SLUG_FILTER.search(slug) or QUESTION_FILTER.search(question))

def is_crypto_updown(market):
    slug = market.get('slug', '')
    question = market.get('question', '')
    return bool(CRYPTO_UPDOWN.search(slug) or CRYPTO_UPDOWN.search(question))

def fetch_page(offset, limit, cutoff_date):
    url = f"https://gamma-api.polymarket.com/markets?closed=true&limit={limit}&offset={offset}&order=closedTime&ascending=false&end_date_min={cutoff_date}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except Exception as e:
        log(f"Error at offset {offset}: {e}")
        return []

def fetch_markets():
    all_markets = []
    offset = 0
    limit = 500
    cutoff = datetime.now(timezone.utc).timestamp() - 30 * 86400
    cutoff_date = datetime.fromtimestamp(cutoff, tz=timezone.utc).strftime('%Y-%m-%d')
    skipped_crypto = 0
    
    while True:
        data = fetch_page(offset, limit, cutoff_date)
        if not data:
            break
        
        too_old = False
        for m in data:
            closed_time = m.get('closedTime') or m.get('endDate') or m.get('updatedAt', '')
            if closed_time:
                try:
                    ts = datetime.fromisoformat(closed_time.replace('Z', '+00:00')).timestamp()
                    if ts < cutoff:
                        too_old = True
                        break
                except:
                    pass
            
            # Skip crypto up/down to save memory and time
            if is_crypto_updown(m):
                skipped_crypto += 1
                continue
            all_markets.append(m)
        
        if offset % 5000 == 0:
            log(f"  offset={offset}, kept={len(all_markets)}, crypto_skipped={skipped_crypto}")
        
        if too_old or len(data) < limit:
            break
        offset += limit
        time.sleep(0.1)
    
    log(f"Total kept: {len(all_markets)}, crypto up/down skipped: {skipped_crypto}")
    return all_markets

def analyze_market(market):
    outcomes_raw = market.get('outcomePrices', '[]')
    if isinstance(outcomes_raw, str):
        try:
            resolution_prices = [float(x) for x in json.loads(outcomes_raw)]
        except:
            return []
    else:
        resolution_prices = [float(x) for x in outcomes_raw]
    
    if not resolution_prices or len(resolution_prices) < 2:
        return []
    
    # Must be resolved (one outcome = 1)
    if not any(p >= 0.99 for p in resolution_prices):
        return []
    
    ltp = market.get('lastTradePrice')
    if ltp is None:
        return []
    ltp = float(ltp)
    
    outcome_labels = market.get('outcomes', '[]')
    if isinstance(outcome_labels, str):
        try:
            outcome_labels = json.loads(outcome_labels)
        except:
            outcome_labels = []
    
    trades = []
    
    # Check first outcome: pre-res price = ltp
    yes_price = ltp
    yes_won = resolution_prices[0] >= 0.99
    if RH_MIN <= yes_price <= RH_MAX:
        shares = RH_SPEND / yes_price
        pnl = (shares * 1.0 - RH_SPEND) if yes_won else -RH_SPEND
        trades.append({
            'market': market.get('question', ''),
            'slug': market.get('slug', ''),
            'outcome_label': outcome_labels[0] if outcome_labels else 'YES',
            'price': yes_price,
            'pnl': round(pnl, 4),
            'win': yes_won
        })
    
    # Check second outcome: pre-res price ≈ 1 - ltp
    no_price = round(1.0 - ltp, 4)
    no_won = resolution_prices[1] >= 0.99 if len(resolution_prices) > 1 else False
    if RH_MIN <= no_price <= RH_MAX:
        shares = RH_SPEND / no_price
        pnl = (shares * 1.0 - RH_SPEND) if no_won else -RH_SPEND
        trades.append({
            'market': market.get('question', ''),
            'slug': market.get('slug', ''),
            'outcome_label': outcome_labels[1] if len(outcome_labels) > 1 else 'NO',
            'price': no_price,
            'pnl': round(pnl, 4),
            'win': no_won
        })
    
    return trades

def main():
    log("Fetching markets (30-day window, excluding crypto up/down)...")
    markets = fetch_markets()
    log(f"Fetched {len(markets)} non-crypto markets")
    
    resolved = []
    for m in markets:
        try:
            prices = json.loads(m.get('outcomePrices', '[]')) if isinstance(m.get('outcomePrices'), str) else m.get('outcomePrices', [])
            prices = [float(p) for p in prices]
            if any(p >= 0.99 for p in prices):
                resolved.append(m)
        except:
            pass
    log(f"Resolved markets: {len(resolved)}")
    
    trades_all = []
    trades_filtered = []
    sports_filtered_count = 0
    sports_filtered_trades = []
    
    for m in resolved:
        results = analyze_market(m)
        for t in results:
            trades_all.append(t)
            if is_sports(m):
                sports_filtered_count += 1
                sports_filtered_trades.append({
                    'market': t['market'][:80],
                    'slug': m.get('slug', ''),
                    'price': t['price'],
                    'win': t['win'],
                    'pnl': t['pnl']
                })
            else:
                trades_filtered.append(t)
    
    wins = [t for t in trades_filtered if t['win']]
    losses = [t for t in trades_filtered if not t['win']]
    total = len(trades_filtered)
    net_pnl = round(sum(t['pnl'] for t in trades_filtered), 2)
    
    tiers = {'95-96': [], '96-97': [], '97-98': []}
    for t in trades_filtered:
        p = t['price']
        if p < 0.96:
            tiers['95-96'].append(t)
        elif p < 0.97:
            tiers['96-97'].append(t)
        else:
            tiers['97-98'].append(t)
    
    tier_stats = {}
    for name, tt in tiers.items():
        w = len([t for t in tt if t['win']])
        l = len([t for t in tt if not t['win']])
        tier_stats[name] = {
            'trades': len(tt),
            'wins': w,
            'losses': l,
            'pnl': round(sum(t['pnl'] for t in tt), 2)
        }
    
    sports_wins = len([t for t in sports_filtered_trades if t.get('win')])
    sports_losses = len([t for t in sports_filtered_trades if not t.get('win')])
    
    hit_rate = round(len(wins) / total * 100, 2) if total else 0
    
    result = {
        "version": "v3",
        "filter": "sports/esports excluded + crypto up/down excluded from scan",
        "parameters": {"RH_MIN": RH_MIN, "RH_MAX": RH_MAX, "RH_SPEND": RH_SPEND, "days": 30},
        "summary": {
            "total_markets_scanned": len(markets),
            "resolved_markets": len(resolved),
            "total_qualifying_before_filter": len(trades_all),
            "sports_filtered_out": sports_filtered_count,
            "total_trades": total,
            "wins": len(wins),
            "losses": len(losses),
            "hit_rate_pct": hit_rate,
            "net_pnl": net_pnl,
            "avg_win": round(sum(t['pnl'] for t in wins) / len(wins), 4) if wins else 0,
            "avg_loss": round(sum(t['pnl'] for t in losses) / len(losses), 4) if losses else 0
        },
        "tier_breakdown": tier_stats,
        "remaining_losses": [t for t in trades_filtered if not t['win']],
        "sports_filter_impact": {
            "trades_removed": sports_filtered_count,
            "of_which_wins": sports_wins,
            "of_which_losses": sports_losses,
            "examples": sports_filtered_trades[:15]
        },
        "comparison_to_v2": {
            "v2_trades": 311, "v3_trades": total,
            "v2_losses": 4, "v3_losses": len(losses),
            "v2_pnl": 69.01, "v3_pnl": net_pnl,
            "v2_hit_rate": 98.71, "v3_hit_rate": hit_rate
        },
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    
    with open('/data/workspace/polymarket-bot/resolution-hunter-backtest-v3.json', 'w') as f:
        json.dump(result, f, indent=2)
    
    log(f"\n{'='*60}")
    log(f"RESOLUTION HUNTER BACKTEST v3 RESULTS")
    log(f"{'='*60}")
    log(f"Total qualifying (unfiltered): {len(trades_all)}")
    log(f"Sports filtered out: {sports_filtered_count} ({sports_wins}W/{sports_losses}L)")
    log(f"Remaining trades: {total}")
    log(f"Wins: {len(wins)} | Losses: {len(losses)} | Hit rate: {hit_rate}%")
    log(f"Net P&L: ${net_pnl}")
    log(f"\nTier breakdown:")
    for name, s in tier_stats.items():
        log(f"  {name}: {s['trades']} trades, {s['wins']}W/{s['losses']}L, ${s['pnl']}")
    if losses:
        log(f"\nRemaining losses:")
        for t in losses:
            log(f"  {t['market'][:70]} | {t['outcome_label']} @ {t['price']} | ${t['pnl']}")
    log(f"\nvs V2: {311}→{total} trades, {4}→{len(losses)} losses, ${69.01}→${net_pnl}")

if __name__ == '__main__':
    main()
