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
async function api(path) {
    try {
        const r = await fetch(path);
        if (!r.ok) throw new Error(r.statusText);
        return await r.json();
    } catch (e) {
        console.warn(`API ${path}:`, e.message);
        return null;
    }
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

// ── Activity Feed (WebSocket) ──
function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/api/ws`);
    ws.onopen = () => { wsBadge.className = 'ws-badge connected'; wsBadge.textContent = '● LIVE'; wsRetryMs = 1000; };
    ws.onclose = () => { wsBadge.className = 'ws-badge'; wsBadge.textContent = '● OFF'; setTimeout(connectWs, wsRetryMs); wsRetryMs = Math.min(wsRetryMs * 2, 30000); };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            addActivity(msg);
        } catch { addActivity({ text: e.data }); }
    };
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

// ── Stuart's Log ──
const LOG_URL = 'https://raw.githubusercontent.com/stuartoffabean/polymarket-bot/main/stuart-log.json';
const logToggle = document.getElementById('logToggle');
const logChevron = document.getElementById('logChevron');
const logBody = document.getElementById('logBody');
const logEntries = document.getElementById('logEntries');

if (logToggle) {
    logToggle.addEventListener('click', () => {
        logBody.classList.toggle('collapsed');
        logChevron.classList.toggle('collapsed');
    });
}

async function loadLog() {
    try {
        const r = await fetch(LOG_URL + '?t=' + Date.now());
        if (!r.ok) throw new Error(r.statusText);
        const entries = await r.json();
        if (!logEntries) return;
        if (!entries || entries.length === 0) {
            logEntries.innerHTML = '<div style="color:var(--dim);padding:20px;text-align:center;font-size:.78rem">No log entries yet</div>';
            return;
        }
        const sorted = [...entries].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 50);
        logEntries.innerHTML = sorted.map(e => {
            const d = new Date(e.time);
            const timeStr = d.toLocaleDateString('en-US', {month:'short', day:'numeric'}) + ' ' +
                d.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:false});
            const tag = e.tag || 'info';
            return `<div class="log-entry">
                <div class="log-time">${timeStr}<span class="log-tag ${tag}">${tag.toUpperCase()}</span></div>
                <div class="log-text">${esc(e.text)}</div>
            </div>`;
        }).join('');
    } catch (e) {
        if (logEntries) logEntries.innerHTML = '<div style="color:var(--dim);padding:20px;text-align:center;font-size:.78rem">No log entries yet</div>';
    }
}

// ── Init ──
function pollAll() {
    updateStatus();
    updateChart();
    updateTrades();
    updatePositions();
    updateStrategies();
    updateOrders();
}

initChart();
pollAll();
loadLog();
connectWs();
setInterval(pollAll, 5000);
setInterval(loadLog, 120000);
