// ── State ──
let pnlChart = null;
let currentRange = '24h';
let killArmed = false;
let killTimer = null;
let ws = null;
let wsRetryMs = 1000;

// ── DOM refs ──
const $ = (s) => document.querySelector(s);
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

// ── Helpers ──
const fmt = (n, decimals = 2) => {
    if (n == null) return '—';
    const v = Number(n);
    return (v >= 0 ? '+' : '') + v.toFixed(decimals);
};
const fmtUsd = (n) => {
    if (n == null) return '—';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtPnl = (n) => {
    if (n == null) return { text: '—', cls: '' };
    const v = Number(n);
    return { text: (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2), cls: v >= 0 ? 'green' : 'red' };
};
const fmtTime = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};
const fmtUptime = (seconds) => {
    if (!seconds) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
};

// ── API ──
// Data sources: GitHub raw for static data, WS proxy for real-time prices
const GITHUB_RAW = 'https://raw.githubusercontent.com/stuartoffabean/polymarket-bot/main';
const STATE_URL = `${GITHUB_RAW}/live-snapshot.json`;
const PNL_URL = `${GITHUB_RAW}/pnl-history.json`;
const WS_PROXY = 'wss://polymarket-dashboard-ws-production.up.railway.app';
const WS_PROXY_HTTP = 'https://polymarket-dashboard-ws-production.up.railway.app';

// Live price cache from WebSocket
let livePriceCache = {};

async function api(path) {
    // Route P&L and snapshot to GitHub-hosted static files
    if (path.startsWith('/api/pnl')) {
        try {
            const r = await fetch(PNL_URL + '?t=' + Date.now());
            if (!r.ok) throw new Error(r.statusText);
            return await r.json();
        } catch(e) {
            console.warn('PNL fetch from GitHub failed:', e.message);
            return null;
        }
    }
    if (path === '/api/status') {
        try {
            const r = await fetch(STATE_URL + '?t=' + Date.now());
            if (!r.ok) throw new Error(r.statusText);
            const snap = await r.json();
            const portfolio = snap.portfolio || {};
            const risk = snap.risk || {};
            let mode = 'NORMAL';
            if (risk.emergencyMode) mode = 'EMERGENCY';
            else if (risk.survivalMode) mode = 'SURVIVAL';
            else if (risk.circuitBreakerTripped) mode = 'PAUSED';
            const totalValue = (snap.positions || []).reduce((s, p) => s + (parseFloat(p.currentValue) || 0), 0);
            const totalCost = (snap.positions || []).reduce((s, p) => s + (parseFloat(p.costBasis) || 0), 0);
            return {
                status: risk.emergencyMode ? 'halted' : 'active',
                mode,
                bankroll: portfolio.startingCapital || 433,
                portfolio_value: totalValue,
                pnl_today: 0,
                pnl_total: totalValue - totalCost,
                uptime_seconds: snap.infrastructure?.uptime || null,
                strategies_active: snap.positions?.length || 0,
                wsConnected: snap.infrastructure?.wsConnected,
                autoExecute: risk.autoExecuteEnabled,
                lastSnapshot: snap.timestamp,
            };
        } catch(e) {
            console.warn('Status fetch failed:', e.message);
            return null;
        }
    }
    if (path === '/api/positions') {
        try {
            const r = await fetch(STATE_URL + '?t=' + Date.now());
            if (!r.ok) throw new Error(r.statusText);
            const snap = await r.json();
            return (snap.positions || []).map(p => ({
                market: p.outcome,
                side: p.outcome,
                size: p.size,
                entry_price: p.avgPrice,
                current_price: p.currentBid || p.avgPrice,
                unrealized_pnl: parseFloat(p.pnl) || 0,
                pnlPct: p.pnlPct,
                cost: parseFloat(p.costBasis) || 0,
                stopLoss: p.stopLoss,
                takeProfit: p.takeProfit,
            }));
        } catch(e) { return null; }
    }
    if (path === '/api/orders') {
        try {
            const r = await fetch(STATE_URL + '?t=' + Date.now());
            if (!r.ok) throw new Error(r.statusText);
            const snap = await r.json();
            return (snap.orders || []).map(o => ({
                id: o.id || o.order_id,
                market: o.asset_id?.slice(0, 16) + '...',
                side: o.side?.toLowerCase() || 'buy',
                price: parseFloat(o.price) * 100,
                size: parseFloat(o.original_size || o.size || 0),
                status: o.status || 'LIVE',
            }));
        } catch(e) { return null; }
    }
    if (path === '/api/trades') {
        try {
            const r = await fetch(STATE_URL + '?t=' + Date.now());
            if (!r.ok) throw new Error(r.statusText);
            const snap = await r.json();
            return (snap.trades || []).map(t => ({
                time: t.timestamp || t.time,
                market: t.market || t.outcome || '—',
                side: t.side?.toLowerCase() || 'buy',
                price: parseFloat(t.price) * 100,
                size: parseFloat(t.size || t.cost || 0),
                pnl: parseFloat(t.pnl) || 0,
            }));
        } catch(e) { return null; }
    }
    if (path === '/api/strategies') {
        try {
            const r = await fetch(STATE_URL + '?t=' + Date.now());
            if (!r.ok) throw new Error(r.statusText);
            const snap = await r.json();
            return (snap.strategies || []).map(s => ({
                id: s.name,
                name: s.name,
                trades: s.trades || 0,
                win_rate: s.winRate || 0,
                pnl: s.pnl || 0,
                enabled: s.enabled !== false,
            }));
        } catch(e) { return null; }
    }
    if (path.startsWith('/api/pnl')) {
        try {
            const r = await fetch(PNL_URL + '?t=' + Date.now());
            if (!r.ok) throw new Error(r.statusText);
            const data = await r.json();
            return {
                points: (data.points || []).map(p => ({
                    time: p.timestamp,
                    value: p.pnl || 0,
                })),
                startingCapital: data.startingCapital || 433,
            };
        } catch(e) { return null; }
    }
    // Fallback
    console.warn(`API ${path}: no handler, skipping`);
    return null;
}

// ── Status ──
async function updateStatus() {
    const data = await api('/api/status');
    if (!data) {
        statusDot.className = 'status-dot';
        statusLabel.textContent = 'OFFLINE';
        return;
    }
    const active = data.status === 'active' || data.status === 'running';
    statusDot.className = 'status-dot ' + (active ? 'active' : 'halted');
    statusLabel.textContent = (data.status || 'UNKNOWN').toUpperCase();
    bankrollEl.textContent = fmtUsd(data.bankroll);

    const today = fmtPnl(data.pnl_today);
    pnlTodayEl.textContent = today.text;
    pnlTodayEl.className = 'stat-value mono ' + today.cls;

    const total = fmtPnl(data.pnl_total);
    pnlTotalEl.textContent = total.text;
    pnlTotalEl.className = 'stat-value mono ' + total.cls;

    uptimeEl.textContent = fmtUptime(data.uptime_seconds);
}

// ── P&L Chart ──
function initChart() {
    const ctx = $('#pnlChart').getContext('2d');
    pnlChart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: '#00ff88', borderWidth: 2, pointRadius: 0, tension: .3, fill: { target: 'origin', above: 'rgba(0,255,136,.06)', below: 'rgba(255,68,68,.06)' } }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false, backgroundColor: '#1a1a2e', titleFont: { family: 'JetBrains Mono' }, bodyFont: { family: 'JetBrains Mono' }, callbacks: { label: (c) => '$' + c.parsed.y.toFixed(2) } } },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#666', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 8 } },
                y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#666', font: { family: 'JetBrains Mono', size: 10 }, callback: (v) => '$' + v } }
            },
            interaction: { mode: 'nearest', axis: 'x', intersect: false }
        }
    });
}

async function updateChart() {
    const data = await api(`/api/pnl?range=${currentRange}`);
    if (!data || !data.points) return;
    pnlChart.data.labels = data.points.map(p => {
        const d = new Date(p.time);
        return currentRange === '1h' || currentRange === '24h'
            ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
            : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });
    pnlChart.data.datasets[0].data = data.points.map(p => p.value);
    pnlChart.update('none');
}

// ── Trades ──
async function updateTrades() {
    const data = await api('/api/trades');
    if (!data || !Array.isArray(data)) return;
    tradesBody.innerHTML = data.slice(0, 50).map(t => {
        const pnl = fmtPnl(t.pnl);
        const cls = (t.pnl != null && Number(t.pnl) >= 0) ? 'win' : 'loss';
        return `<tr class="${cls}">
            <td>${fmtTime(t.time)}</td>
            <td>${esc(t.market || '—')}</td>
            <td><span class="side-${t.side === 'buy' ? 'buy' : 'sell'}">${(t.side || '—').toUpperCase()}</span></td>
            <td class="r">${Number(t.price || 0).toFixed(2)}¢</td>
            <td class="r">$${Number(t.size || 0).toFixed(2)}</td>
            <td class="r">${pnl.text}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">No trades yet</td></tr>';
}

// ── Positions ──
async function updatePositions() {
    const data = await api('/api/positions');
    if (!data || !Array.isArray(data)) { positionsEl.innerHTML = '<div class="empty">No positions</div>'; return; }
    positionsEl.innerHTML = data.map(p => {
        const upnl = fmtPnl(p.unrealized_pnl);
        return `<div class="position-card">
            <div class="market">${esc(p.market || '—')}</div>
            <div>
                <div class="detail">Side: <span class="${p.side === 'yes' ? 'green' : 'red'}">${(p.side || '—').toUpperCase()}</span></div>
                <div class="detail">Size: <span>$${Number(p.size || 0).toFixed(2)}</span></div>
                <div class="detail">Entry: <span>${Number(p.entry_price || 0).toFixed(1)}¢</span> → Now: <span>${Number(p.current_price || 0).toFixed(1)}¢</span></div>
            </div>
            <div class="upnl ${upnl.cls}">${upnl.text}</div>
        </div>`;
    }).join('') || '<div class="empty">No positions</div>';
}

// ── Strategies ──
async function updateStrategies() {
    const data = await api('/api/strategies');
    if (!data || !Array.isArray(data)) { strategiesEl.innerHTML = '<div class="empty">No strategies</div>'; return; }
    strategiesEl.innerHTML = data.map(s => {
        const pnl = fmtPnl(s.pnl);
        return `<div class="strategy-card">
            <div>
                <div class="name">${esc(s.name || '—')}</div>
                <div class="stats">
                    Trades: <span>${s.trades ?? 0}</span>
                    WR: <span>${(Number(s.win_rate || 0) * 100).toFixed(0)}%</span>
                    P&L: <span class="${pnl.cls}">${pnl.text}</span>
                </div>
            </div>
            <div class="toggle ${s.enabled ? 'on' : ''}" data-strategy="${esc(s.id || s.name)}"></div>
        </div>`;
    }).join('') || '<div class="empty">No strategies</div>';
}

// ── Orders ──
async function updateOrders() {
    const data = await api('/api/orders');
    if (!data || !Array.isArray(data)) { ordersEl.innerHTML = '<div class="empty">No open orders</div>'; return; }
    ordersEl.innerHTML = data.map(o => {
        return `<div class="order-row">
            <div class="info">
                <span class="${o.side === 'buy' ? 'green' : 'red'}">${(o.side || '—').toUpperCase()}</span>
                <span>${esc(o.market || '—')}</span>
                <span>${Number(o.price || 0).toFixed(1)}¢</span>
                <span>$${Number(o.size || 0).toFixed(2)}</span>
            </div>
            <button class="cancel-btn" data-order="${esc(o.id || '')}">CANCEL</button>
        </div>`;
    }).join('') || '<div class="empty">No open orders</div>';
}

// ── Real-Time State ──
let prevPriceCache = {};
let wsConnected = false;
let firstDataReceived = false;
const overlay = document.getElementById('connectingOverlay');

// Show loading skeletons on startup
function showSkeletons() {
    positionsEl.innerHTML = [1,2,3].map(() => `
        <div class="skeleton-card">
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-line"></div>
        </div>
    `).join('');
    strategiesEl.innerHTML = [1,2].map(() => `
        <div class="skeleton-card">
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-line"></div>
        </div>
    `).join('');
    ordersEl.innerHTML = `<div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div>`;
}

// ── Activity Feed (WebSocket) ──
function connectWs() {
    ws = new WebSocket(WS_PROXY);
    ws.onopen = () => {
        wsConnected = true;
        wsBadge.className = 'ws-badge connected';
        wsBadge.textContent = '● LIVE';
        wsRetryMs = 1000;
        statusDot.className = 'status-dot active';
        statusLabel.textContent = 'LIVE';
        addActivity({ text: 'Connected to real-time feed', type: 'info' });
    };
    ws.onclose = () => {
        wsConnected = false;
        wsBadge.className = 'ws-badge';
        wsBadge.textContent = '● OFF';
        statusDot.className = 'status-dot';
        statusLabel.textContent = 'RECONNECTING';
        setTimeout(connectWs, wsRetryMs);
        wsRetryMs = Math.min(wsRetryMs * 2, 30000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'prices' || msg.type === 'snapshot') {
                prevPriceCache = { ...livePriceCache };
                livePriceCache = msg.prices || {};
                updatePositionsFromWs();
                updateLivePnl();

                // Hide overlay on first data
                if (!firstDataReceived) {
                    firstDataReceived = true;
                    overlay.classList.add('hidden');
                    setTimeout(() => overlay.style.display = 'none', 500);
                }
                return;
            }
            addActivity(msg);
        } catch { addActivity({ text: e.data }); }
    };
}

function updatePositionsFromWs() {
    const prices = Object.values(livePriceCache);
    const prevPrices = Object.values(prevPriceCache);
    const withMarket = prices.filter(p => p.market);
    if (withMarket.length === 0) return;

    // Build lookup for flash detection
    const prevMap = {};
    for (const [id, p] of Object.entries(prevPriceCache)) {
        prevMap[id] = p;
    }

    // Update or create position cards smoothly
    const existingCards = positionsEl.querySelectorAll('.position-card');
    const needsRebuild = existingCards.length !== withMarket.length || existingCards.length === 0;

    if (needsRebuild) {
        positionsEl.innerHTML = '';
    }

    Object.entries(livePriceCache).forEach(([id, p], i) => {
        if (!p.market) return;
        const prev = prevMap[id];
        const priceChanged = prev && prev.bid !== p.bid;
        const priceUp = prev && p.bid > prev.bid;
        const priceDown = prev && p.bid < prev.bid;
        const upnl = fmtPnl(p.pnl);
        const currentPrice = p.bid || 0;
        const pnlPositive = (p.pnl || 0) >= 0;

        let card = needsRebuild ? null : positionsEl.children[i];

        if (!card || needsRebuild) {
            card = document.createElement('div');
            card.className = `position-card ${pnlPositive ? 'positive' : 'negative'}`;
            card.dataset.assetId = id;
            card.innerHTML = `
                <div class="market">${esc(p.market)}</div>
                <div>
                    <div class="detail">Side: <span class="${(p.outcome || '').toLowerCase() === 'yes' ? 'green' : 'red'}">${(p.outcome || '—').toUpperCase()}</span></div>
                    <div class="detail">Size: <span>${p.size || 0} shares</span> ($${(p.costBasis || 0).toFixed(2)})</div>
                    <div class="detail">Entry: <span>${((p.avgPrice || 0) * 100).toFixed(0)}¢</span> → Now: <span class="live-price">${(currentPrice * 100).toFixed(1)}¢</span></div>
                </div>
                <div class="upnl ${upnl.cls}">${upnl.text}</div>
            `;
            positionsEl.appendChild(card);
        } else {
            // Smooth update — only change values, don't rebuild DOM
            const priceEl = card.querySelector('.live-price');
            const upnlEl = card.querySelector('.upnl');

            if (priceEl) {
                const newText = `${(currentPrice * 100).toFixed(1)}¢`;
                if (priceEl.textContent !== newText) {
                    priceEl.textContent = newText;
                }
            }
            if (upnlEl) {
                upnlEl.textContent = upnl.text;
                upnlEl.className = `upnl ${upnl.cls}`;
            }
            card.className = `position-card ${pnlPositive ? 'positive' : 'negative'}`;

            // Flash on price change
            if (priceChanged) {
                card.classList.remove('flash-up', 'flash-down');
                void card.offsetWidth; // force reflow
                card.classList.add(priceUp ? 'flash-up' : 'flash-down');
                addActivity({
                    text: `${p.market}: ${(prev.bid * 100).toFixed(1)}¢ → ${(currentPrice * 100).toFixed(1)}¢`,
                    type: priceUp ? 'trade' : 'alert',
                    time: new Date().toISOString()
                });
            }
        }
    });
}

function smoothUpdate(el, newText, newClass) {
    if (el.textContent === newText && (!newClass || el.className.includes(newClass))) return;
    el.classList.add('value-updating');
    requestAnimationFrame(() => {
        el.textContent = newText;
        if (newClass) el.className = newClass;
        requestAnimationFrame(() => {
            el.classList.remove('value-updating');
            el.classList.add('value-updated');
        });
    });
}

function updateLivePnl() {
    const prices = Object.values(livePriceCache).filter(p => p.market);
    let totalPnl = 0;
    let totalValue = 0;
    for (const p of prices) {
        totalPnl += p.pnl || 0;
        totalValue += p.currentValue || 0;
    }
    const pnl = fmtPnl(totalPnl);
    smoothUpdate(pnlTotalEl, pnl.text, 'stat-value mono ' + pnl.cls);
    bankrollEl.textContent = fmtUsd(433);

    // Count positions for uptime slot (repurpose)
    uptimeEl.textContent = `${prices.length} positions`;
}

function addActivity(msg) {
    const div = document.createElement('div');
    const type = msg.type || 'info';
    div.className = 'entry ' + (type === 'trade' ? 'trade' : type === 'alert' || type === 'risk' ? 'alert' : type === 'error' ? 'error' : '');
    const ts = fmtTime(msg.time || new Date().toISOString());
    div.innerHTML = `<span class="ts">${ts}</span>${esc(msg.text || msg.message || JSON.stringify(msg))}`;
    activityFeed.appendChild(div);
    // Keep max 200 entries
    while (activityFeed.children.length > 200) activityFeed.removeChild(activityFeed.firstChild);
    activityFeed.scrollTop = activityFeed.scrollHeight;
}

// ── Kill Switch ──
killBtn.addEventListener('click', () => {
    if (!killArmed) {
        killArmed = true;
        killBtn.textContent = '⚠ CONFIRM KILL';
        killBtn.classList.add('confirm');
        killTimer = setTimeout(() => { killArmed = false; killBtn.textContent = '⏻ KILL SWITCH'; killBtn.classList.remove('confirm'); }, 5000);
        return;
    }
    clearTimeout(killTimer);
    killArmed = false;
    killBtn.textContent = 'KILLING...';
    killBtn.classList.remove('confirm');
    fetch('/api/kill', { method: 'POST' }).then(() => {
        killBtn.textContent = '☠ KILLED';
        updateStatus();
    }).catch(() => { killBtn.textContent = '⏻ KILL SWITCH'; });
});

// ── Strategy toggle delegation ──
strategiesEl.addEventListener('click', (e) => {
    const toggle = e.target.closest('.toggle');
    if (!toggle) return;
    const id = toggle.dataset.strategy;
    const enable = !toggle.classList.contains('on');
    fetch(`/api/strategies/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enable }) })
        .then(() => updateStrategies());
});

// ── Order cancel delegation ──
ordersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.cancel-btn');
    if (!btn) return;
    const id = btn.dataset.order;
    fetch(`/api/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => updateOrders());
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

// ── XSS escape ──
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── Init ──
function pollAll() {
    updateStatus();
    updateChart();
    updateTrades();
    updatePositions();
    updateStrategies();
    updateOrders();
}

// ── Init ──
showSkeletons();
initChart();
connectWs();
// Poll GitHub data less frequently now (trades, strategies, orders, chart)
// Positions update in real-time via WebSocket
pollAll();
setInterval(pollAll, 30000);
