// ── STUART Dashboard — Live Price Polling via CLOB Proxy ──

// Config
const GITHUB_RAW = 'https://raw.githubusercontent.com/stuartoffabean/polymarket-bot/main';
const STATE_URL = `${GITHUB_RAW}/live-snapshot.json`;
const PNL_URL = `${GITHUB_RAW}/pnl-history.json`;
const PROXY = 'https://proxy-rosy-sigma-25.vercel.app';
const POLL_INTERVAL = 30000; // 30s price polls
const SNAPSHOT_INTERVAL = 120000; // 2min snapshot refresh

// State
let pnlChart = null;
let currentRange = '24h';
let killArmed = false;
let killTimer = null;
let snapshot = null;
let livePrices = {}; // tokenId -> { bid, ask }
let pnlTimeline = []; // {time, totalValue, totalPnl} for live chart
const MAX_TIMELINE = 720; // 6hrs at 30s intervals

// DOM
const $ = s => document.querySelector(s);
const statusDot = $('#statusDot');
const statusLabel = $('#statusLabel');
const bankrollEl = $('#bankroll');
const pnlTodayEl = $('#pnlToday');
const pnlTotalEl = $('#pnlTotal');
const uptimeEl = $('#uptime');
const killBtn = $('#killBtn');
const tradesBody = $('#tradesBody');
const positionsEl = $('#positions');
const strategiesEl = $('#strategies');
const ordersEl = $('#orders');
const activityFeed = $('#activityFeed');
const wsBadge = $('#wsBadge');
const overlay = document.getElementById('connectingOverlay');

// Helpers
const fmtUsd = n => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
const fmtPnl = n => {
    if (n == null) return {text:'—', cls:''};
    const v = Number(n);
    return {text: (v>=0?'+$':'-$') + Math.abs(v).toFixed(2), cls: v>=0?'green':'red'};
};
const fmtTime = ts => {
    if (!ts) return '—';
    return new Date(ts).toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
};
const esc = s => { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; };

// ── Fetch snapshot from GitHub ──
async function loadSnapshot() {
    try {
        const r = await fetch(STATE_URL + '?t=' + Date.now());
        if (!r.ok) throw new Error(r.statusText);
        snapshot = await r.json();
        renderTrades();
        renderStrategies();
        renderOrders();
        addActivity({text: 'Snapshot refreshed', type: 'info'});
    } catch(e) {
        console.warn('Snapshot fetch failed:', e.message);
    }
}

// ── Poll live prices from CLOB via proxy ──
async function pollPrices() {
    if (!snapshot) return;
    
    // Collect all unique token IDs (dedupe by prefix since some may be truncated)
    const tokenIds = new Set();
    const seenPrefixes = new Set();
    for (const src of [...(snapshot.positions || []).map(p => p.fullAssetId), ...(snapshot.trades || []).map(t => t.tokenId)]) {
        if (!src) continue;
        const prefix = src.slice(0, 20);
        if (seenPrefixes.has(prefix)) continue;
        seenPrefixes.add(prefix);
        tokenIds.add(src);
    }
    
    if (tokenIds.size === 0) return;
    
    // Fetch prices in parallel
    const promises = [...tokenIds].map(async tokenId => {
        try {
            const [buyR, sellR] = await Promise.all([
                fetch(`${PROXY}/price?token_id=${tokenId}&side=buy`),
                fetch(`${PROXY}/price?token_id=${tokenId}&side=sell`)
            ]);
            const buy = await buyR.json();
            const sell = await sellR.json();
            livePrices[tokenId] = {
                bid: parseFloat(buy.price) || 0,
                ask: parseFloat(sell.price) || 0,
                time: Date.now()
            };
        } catch(e) {
            console.warn(`Price fetch failed for ${tokenId.slice(0,20)}:`, e.message);
        }
    });
    
    await Promise.all(promises);
    
    // Update everything with live prices
    renderPositions();
    updateTopBar();
    recordPnlPoint();
    updateChart();
    
    // Update badge
    wsBadge.className = 'ws-badge connected';
    wsBadge.textContent = '● POLLING';
    statusDot.className = 'status-dot active';
    statusLabel.textContent = 'LIVE';
    
    // Hide overlay on first successful poll
    if (overlay && !overlay.classList.contains('hidden')) {
        overlay.classList.add('hidden');
        setTimeout(() => overlay.style.display = 'none', 500);
    }
}

// ── Compute portfolio from live prices ──
function computePortfolio() {
    if (!snapshot) return {totalValue: 0, totalCost: 0, totalPnl: 0, positions: []};
    
    // Build trade lookup by token prefix (first 20 chars) for market name resolution
    const tradeByPrefix = {};
    for (const t of (snapshot.trades || [])) {
        if (t.tokenId) tradeByPrefix[t.tokenId.slice(0, 20)] = t;
    }
    
    // Use trades as the canonical source — they have market names and all 5 positions
    const allPositions = [];
    const seenPrefixes = new Set();
    
    for (const t of (snapshot.trades || [])) {
        if (!t.tokenId) continue;
        const prefix = t.tokenId.slice(0, 20);
        if (seenPrefixes.has(prefix)) continue;
        seenPrefixes.add(prefix);
        
        // Find matching ws-feed position for live data
        const wsPos = (snapshot.positions || []).find(p => 
            p.fullAssetId && p.fullAssetId.slice(0, 20) === prefix
        );
        
        // Try live price, then ws-feed bid, then entry price
        const livePrice = findLivePrice(t.tokenId) || (wsPos ? findLivePrice(wsPos.fullAssetId) : null);
        const currentBid = livePrice || (wsPos ? parseFloat(wsPos.currentBid) : null) || parseFloat(t.price) || 0;
        const size = parseInt(t.shares) || (wsPos ? wsPos.size : 0);
        const avgPrice = parseFloat(t.price) || (wsPos ? parseFloat(wsPos.avgPrice) : 0);
        const costBasis = parseFloat(t.size) || (wsPos ? parseFloat(wsPos.costBasis) : (size * avgPrice));
        const currentValue = size * currentBid;
        const pnl = currentValue - costBasis;
        
        allPositions.push({
            tokenId: t.tokenId,
            market: t.market || '—',
            outcome: t.outcome || (wsPos ? wsPos.outcome : 'Yes'),
            size, avgPrice, costBasis, currentBid, currentValue, pnl,
            pnlPct: costBasis > 0 ? ((pnl / costBasis) * 100).toFixed(1) : '0.0',
            stopLoss: wsPos ? wsPos.stopLoss : null,
            takeProfit: wsPos ? wsPos.takeProfit : null,
            hasLivePrice: !!livePrice
        });
    }
    
    const totalValue = allPositions.reduce((s, p) => s + p.currentValue, 0);
    const totalCost = allPositions.reduce((s, p) => s + p.costBasis, 0);
    return {totalValue, totalCost, totalPnl: totalValue - totalCost, positions: allPositions};
}

// Find live price matching a token ID (exact or prefix match)
function findLivePrice(tokenId) {
    if (!tokenId) return null;
    // Exact match first
    if (livePrices[tokenId]) return livePrices[tokenId].bid;
    // Prefix match (20 chars)
    const prefix = tokenId.slice(0, 20);
    for (const [id, p] of Object.entries(livePrices)) {
        if (id.slice(0, 20) === prefix) return p.bid;
    }
    return null;
}

// ── Record P&L data point for live chart ──
function recordPnlPoint() {
    const {totalValue, totalPnl} = computePortfolio();
    if (totalValue === 0) return;
    pnlTimeline.push({
        time: new Date().toISOString(),
        value: totalValue,
        pnl: totalPnl
    });
    if (pnlTimeline.length > MAX_TIMELINE) pnlTimeline.shift();
}

// ── Render positions with live prices ──
function renderPositions() {
    const {positions} = computePortfolio();
    if (positions.length === 0) {
        positionsEl.innerHTML = '<div class="empty">No positions</div>';
        return;
    }
    
    positionsEl.innerHTML = positions.map(p => {
        const upnl = fmtPnl(p.pnl);
        const priceChange = livePrices[p.tokenId] ? '' : ' (stale)';
        const positive = p.pnl >= 0;
        return `<div class="position-card ${positive ? 'positive' : 'negative'}">
            <div class="market">${esc(p.market)}</div>
            <div>
                <div class="detail">Side: <span class="${(p.outcome||'').toLowerCase()==='yes'?'green':'red'}">${(p.outcome||'—').toUpperCase()}</span></div>
                <div class="detail">Size: <span>${p.size} shares</span> (${fmtUsd(p.costBasis)})</div>
                <div class="detail">Entry: <span>${(p.avgPrice*100).toFixed(0)}¢</span> → Now: <span class="live-price">${(p.currentBid*100).toFixed(1)}¢${priceChange}</span></div>
            </div>
            <div class="upnl ${upnl.cls}">${upnl.text} (${p.pnlPct}%)</div>
        </div>`;
    }).join('');
}

// ── Update top bar stats ──
function updateTopBar() {
    const {totalValue, totalCost, totalPnl, positions} = computePortfolio();
    bankrollEl.textContent = fmtUsd(433);
    
    // Position value
    pnlTodayEl.textContent = fmtUsd(totalValue);
    pnlTodayEl.className = 'stat-value mono';
    
    // Unrealized P&L
    const total = fmtPnl(totalPnl);
    pnlTotalEl.textContent = total.text;
    pnlTotalEl.className = 'stat-value mono ' + total.cls;
    
    // Deployed capital
    uptimeEl.textContent = fmtUsd(totalCost) + ` (${positions.length})`;
}

// ── Trades ──
function renderTrades() {
    if (!snapshot) return;
    const trades = snapshot.trades || [];
    tradesBody.innerHTML = trades.map(t => {
        // Only show realized P&L (from closed trades). Open positions = no P&L here.
        const isOpen = !t.closed;
        const realizedPnl = t.closed ? (parseFloat(t.realizedPnl) || 0) : null;
        const p = realizedPnl != null ? fmtPnl(realizedPnl) : {text: 'OPEN', cls: 'open'};
        return `<tr>
            <td>${fmtTime(t.timestamp)}</td>
            <td>${esc(t.market || '—')}</td>
            <td><span class="side-${(t.side||'buy').toLowerCase()}">${(t.side||'BUY').toUpperCase()}</span></td>
            <td class="r">${((parseFloat(t.price)||0)*100).toFixed(0)}¢</td>
            <td class="r">${t.shares || 0} × ${((parseFloat(t.price)||0)*100).toFixed(0)}¢ = ${fmtUsd(t.size || t.cost)}</td>
            <td class="r" style="color:${isOpen ? '#888' : (realizedPnl >= 0 ? '#00ff88' : '#ff4444')}">${p.text}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">No trades yet</td></tr>';
}

// ── Strategies ──
function renderStrategies() {
    if (!snapshot) return;
    const strats = snapshot.strategies || [];
    strategiesEl.innerHTML = strats.map(s => {
        const pnl = fmtPnl(s.pnl);
        return `<div class="strategy-card">
            <div>
                <div class="name">${esc(s.name || '—')}</div>
                <div class="stats">
                    Trades: <span>${s.trades??0}</span>
                    WR: <span>${((s.winRate||0)*100).toFixed(0)}%</span>
                    P&L: <span class="${pnl.cls}">${pnl.text}</span>
                </div>
            </div>
        </div>`;
    }).join('') || '<div class="empty">No strategies</div>';
}

// ── Orders ──
function renderOrders() {
    if (!snapshot) return;
    const orders = snapshot.orders || [];
    ordersEl.innerHTML = orders.map(o => {
        return `<div class="order-row">
            <div class="info">
                <span class="${(o.side||'').toLowerCase()==='buy'?'green':'red'}">${(o.side||'—').toUpperCase()}</span>
                <span>${esc((o.asset_id||'').slice(0,16)+'...')}</span>
                <span>${(parseFloat(o.price||0)*100).toFixed(1)}¢</span>
                <span>${o.original_size||o.size||0} shares</span>
            </div>
        </div>`;
    }).join('') || '<div class="empty">No open orders</div>';
}

// ── P&L Chart ──
function initChart() {
    const ctx = $('#pnlChart').getContext('2d');
    pnlChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                data: [],
                borderColor: '#00ff88',
                borderWidth: 2,
                pointRadius: 0,
                tension: .3,
                fill: {
                    target: 'origin',
                    above: 'rgba(0,255,136,.06)',
                    below: 'rgba(255,68,68,.06)'
                }
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index', intersect: false,
                    backgroundColor: '#1a1a2e',
                    titleFont: { family: 'JetBrains Mono' },
                    bodyFont: { family: 'JetBrains Mono' },
                    callbacks: { label: c => '$' + c.parsed.y.toFixed(2) }
                }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#666', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 8 } },
                y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#666', font: { family: 'JetBrains Mono', size: 10 }, callback: v => '$' + v.toFixed(2) } }
            },
            interaction: { mode: 'nearest', axis: 'x', intersect: false }
        }
    });
}

let historicalPoints = []; // loaded once from GitHub
let historyLoaded = false;

async function loadHistory() {
    if (historyLoaded) return;
    try {
        const r = await fetch(PNL_URL + '?t=' + Date.now());
        if (!r.ok) return;
        const data = await r.json();
        historicalPoints = (data.points || [])
            .filter(p => p.timestamp && p.positionValue > 0)
            .map(p => ({ time: p.timestamp, value: p.positionValue }));
        historyLoaded = true;
    } catch(e) {}
}

async function updateChart() {
    // Load historical data if not yet loaded
    await loadHistory();
    
    // Merge historical + live into one timeline
    const all = [...historicalPoints, ...pnlTimeline];
    
    // Dedupe by rounding to nearest minute (avoid overlapping points)
    const seen = new Set();
    const deduped = all.filter(p => {
        const key = new Date(p.time).getTime();
        const minuteKey = Math.floor(key / 60000);
        if (seen.has(minuteKey)) return false;
        seen.add(minuteKey);
        return true;
    });
    
    // Sort by time
    deduped.sort((a, b) => new Date(a.time) - new Date(b.time));
    
    // Filter by range
    const now = Date.now();
    let points = deduped;
    if (currentRange === '1h') points = points.filter(p => now - new Date(p.time).getTime() < 3600000);
    else if (currentRange === '24h') points = points.filter(p => now - new Date(p.time).getTime() < 86400000);
    else if (currentRange === '7d') points = points.filter(p => now - new Date(p.time).getTime() < 604800000);
    
    if (points.length === 0) return;
    
    // Format labels based on range
    const useDate = currentRange === '7d' || currentRange === 'all';
    pnlChart.data.labels = points.map(p => {
        const d = new Date(p.time);
        return useDate 
            ? d.toLocaleDateString('en-US', {month:'short', day:'numeric'}) + ' ' + d.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:false})
            : fmtTime(p.time);
    });
    pnlChart.data.datasets[0].data = points.map(p => p.value);
    pnlChart.update('none');
}

// ── Activity Feed ──
function addActivity(msg) {
    const div = document.createElement('div');
    const type = msg.type || 'info';
    div.className = 'entry ' + (type === 'trade' ? 'trade' : type === 'alert' ? 'alert' : type === 'error' ? 'error' : '');
    div.innerHTML = `<span class="ts">${fmtTime(new Date().toISOString())}</span>${esc(msg.text || '')}`;
    activityFeed.appendChild(div);
    while (activityFeed.children.length > 100) activityFeed.removeChild(activityFeed.firstChild);
    activityFeed.scrollTop = activityFeed.scrollHeight;
}

// ── Kill Switch (non-functional on static dashboard) ──
killBtn.addEventListener('click', () => {
    if (!killArmed) {
        killArmed = true;
        killBtn.textContent = '⚠ CONFIRM';
        killBtn.classList.add('confirm');
        killTimer = setTimeout(() => { killArmed = false; killBtn.textContent = '⏻ KILL SWITCH'; killBtn.classList.remove('confirm'); }, 5000);
        return;
    }
    clearTimeout(killTimer);
    killArmed = false;
    killBtn.textContent = 'N/A (static)';
});

// ── Time range buttons ──
document.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentRange = btn.dataset.range;
        updateChart();
    });
});

// ── Init ──
initChart();

// Show loading state
positionsEl.innerHTML = [1,2,3].map(() => '<div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div>').join('');

// Load snapshot first, then start polling prices
loadSnapshot().then(() => {
    pollPrices();
    addActivity({text: 'Dashboard started — polling prices every 30s', type: 'info'});
});

// Poll prices every 30s
setInterval(pollPrices, POLL_INTERVAL);
// Refresh snapshot every 2min
setInterval(loadSnapshot, SNAPSHOT_INTERVAL);
