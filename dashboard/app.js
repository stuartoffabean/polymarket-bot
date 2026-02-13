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
let pnlTimeline = JSON.parse(localStorage.getItem('stuart_pnl_timeline') || '[]');
const MAX_TIMELINE = 2880; // 24hrs at 30s intervals

// DOM
const $ = s => document.querySelector(s);
const statusDot = $('#statusDot');
const statusLabel = $('#statusLabel');
const bankrollEl = $('#bankroll');
const pnlTodayEl = $('#pnlToday');
const pnlTotalEl = $('#pnlTotal');
// uptimeEl removed — replaced with cash + total portfolio
const killBtn = $('#killBtn');
const ledgerBody = $('#ledgerBody');
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
        renderLedger();
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
        value: totalValue
    });
    if (pnlTimeline.length > MAX_TIMELINE) pnlTimeline.shift();
    // Persist to localStorage so data survives refresh
    try { localStorage.setItem('stuart_pnl_timeline', JSON.stringify(pnlTimeline)); } catch(e) {}
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
        const cls = p.pnl > 0.01 ? 'positive' : p.pnl < -0.01 ? 'negative' : 'flat';
        const sideColor = (p.outcome||'').toLowerCase() === 'yes' ? 'green' : 'red';
        return `<div class="pos-card ${cls}">
            <div class="pos-header">
                <div class="pos-market">${esc(p.market)}</div>
                <div class="pos-pnl ${upnl.cls}">${upnl.text}</div>
            </div>
            <div class="pos-price-row">
                <span class="${sideColor}">${(p.outcome||'—').toUpperCase()}</span>
                <span>${p.size}sh</span>
                <span class="pos-arrow">·</span>
                <span>${(p.avgPrice*100).toFixed(0)}¢</span>
                <span class="pos-arrow">→</span>
                <span class="pos-live ${upnl.cls}">${(p.currentBid*100).toFixed(1)}¢</span>
            </div>
            <div class="pos-details">
                <div>Cost: <span>${fmtUsd(p.costBasis)}</span></div>
                <div>Value: <span>${fmtUsd(p.currentValue)}</span></div>
                <div>P&L: <span class="${upnl.cls}">${p.pnlPct}%</span></div>
            </div>
        </div>`;
    }).join('');
}

// ── Update top bar stats ──
function updateTopBar() {
    const {totalValue, totalCost, totalPnl, positions} = computePortfolio();
    const ledger = snapshot?.ledger || {};
    const tradeHistory = snapshot?.tradeHistory || {};
    const cash = snapshot?.cash || 0;
    // Use tradeHistory (from data-api) for realized P&L — it has complete trade history
    const realizedPnl = parseFloat(tradeHistory.totalRealizedPnl) || parseFloat(ledger.totalRealizedPnl) || 0;
    const combinedPnl = totalPnl + realizedPnl;
    const totalPortfolio = totalValue + cash;

    // Total portfolio (positions + cash)
    const totalPortfolioEl = document.getElementById('totalPortfolio');
    if (totalPortfolioEl) {
        totalPortfolioEl.textContent = fmtUsd(totalPortfolio);
        // Color based on total P&L (realized + unrealized) — chain truth only
        const cls = combinedPnl >= 0 ? 'green' : 'red';
        totalPortfolioEl.className = 'stat-value mono ' + cls;
    }

    // Position value
    bankrollEl.textContent = fmtUsd(totalValue);
    
    // Cash
    const cashEl = document.getElementById('cashBalance');
    if (cashEl) cashEl.textContent = fmtUsd(cash);
    
    // Total P&L (realized + unrealized) — main display
    const combined = fmtPnl(combinedPnl);
    pnlTotalEl.textContent = combined.text;
    pnlTotalEl.className = 'stat-value mono ' + combined.cls;
    
    // Realized P&L
    const realizedEl = document.getElementById('realizedPnl');
    if (realizedEl) {
        const rPnl = fmtPnl(realizedPnl);
        realizedEl.textContent = rPnl.text;
        realizedEl.className = 'stat-value mono ' + rPnl.cls;
    }

    // Total P&L (realized + unrealized)
    const totalPnlEl = document.getElementById('totalPnl');
    if (totalPnlEl) {
        const tPnl = fmtPnl(combinedPnl);
        totalPnlEl.textContent = tPnl.text;
        totalPnlEl.className = 'stat-value mono ' + tPnl.cls;
    }
}

// ── Trade Ledger ──
let currentLedgerTab = 'open';

function renderLedger() {
    if (!snapshot) return;
    const ledger = snapshot.ledger || {};
    const ledgerBody = document.getElementById('ledgerBody');
    const ledgerHead = document.getElementById('ledgerHead');
    if (!ledgerBody) return;

    if (currentLedgerTab === 'open') {
        ledgerHead.innerHTML = `<tr><th>Market</th><th class="r">Side</th><th class="r">Size</th><th class="r">Entry</th><th class="r">Current</th><th class="r">P&L</th></tr>`;
        // Use ledger openPositions (includes personal wallet) enriched with live prices
        const ledgerOpen = ledger.openPositions || [];
        const {positions: livePositions} = computePortfolio();
        
        // Build merged list: ledger positions with live price overlay
        const rows = ledgerOpen.map(lp => {
            const prefix = (lp.asset_id || '').slice(0, 20);
            // Find matching live position for current price
            const live = livePositions.find(p => p.tokenId && p.tokenId.slice(0, 20) === prefix);
            const wsPos = (snapshot.positions || []).find(p => p.fullAssetId && p.fullAssetId.slice(0, 20) === prefix);
            
            const avgPrice = parseFloat(lp.avgPrice) || 0;
            const size = lp.size || 0;
            const costBasis = parseFloat(lp.costBasis) || (size * avgPrice);
            const currentBid = live?.currentBid || (wsPos ? parseFloat(wsPos.currentBid) : null) || findLivePrice(lp.asset_id) || avgPrice;
            const currentValue = size * currentBid;
            const pnl = currentValue - costBasis;
            const pnlPct = costBasis > 0 ? ((pnl / costBasis) * 100).toFixed(1) : '0.0';
            const src = '';
            
            return { market: lp.market + src, outcome: lp.outcome, size, avgPrice, currentBid, pnl, pnlPct };
        });
        
        ledgerBody.innerHTML = rows.map(p => {
            const pnl = fmtPnl(p.pnl);
            const sideColor = (p.outcome||'').toLowerCase() === 'yes' ? 'green' : 'red';
            return `<tr>
                <td>${esc(p.market)}</td>
                <td class="r"><span class="${sideColor}">${(p.outcome||'—').toUpperCase()}</span></td>
                <td class="r">${p.size}sh</td>
                <td class="r">${(p.avgPrice*100).toFixed(0)}¢</td>
                <td class="r">${(p.currentBid*100).toFixed(1)}¢</td>
                <td class="r"><span class="${pnl.cls}">${pnl.text} (${p.pnlPct}%)</span></td>
            </tr>`;
        }).join('') || '<tr><td colspan="6" class="empty">No open positions</td></tr>';
    } else if (currentLedgerTab === 'closed') {
        ledgerHead.innerHTML = `<tr><th>Market</th><th class="r">Side</th><th class="r">Bought</th><th class="r">Avg Buy</th><th class="r">Avg Sell</th><th class="r">Realized P&L</th></tr>`;
        const closed = ledger.closedPositions || [];
        ledgerBody.innerHTML = closed.map(p => {
            const pnl = fmtPnl(parseFloat(p.realizedPnl));
            const sideColor = (p.outcome||'').toLowerCase() === 'yes' ? 'green' : 'red';
            return `<tr>
                <td>${esc(p.market || p.asset_id?.slice(0,12)+'...')}</td>
                <td class="r"><span class="${sideColor}">${(p.outcome||'—').toUpperCase()}</span></td>
                <td class="r">${p.totalBought}sh</td>
                <td class="r">${(parseFloat(p.avgBuyPrice)*100).toFixed(0)}¢</td>
                <td class="r">${(parseFloat(p.avgSellPrice)*100).toFixed(0)}¢</td>
                <td class="r"><span class="${pnl.cls}">${pnl.text} (${p.realizedPnlPct}%)</span></td>
            </tr>`;
        }).join('') || '<tr><td colspan="6" class="empty">No closed trades yet</td></tr>';
    } else if (currentLedgerTab === 'log') {
        ledgerHead.innerHTML = `<tr><th>Time</th><th>Market</th><th class="r">Side</th><th class="r">Size</th><th class="r">Price</th><th class="r">Action</th></tr>`;
        const log = ledger.tradeLog || [];
        ledgerBody.innerHTML = log.map(t => {
            const sideClass = t.side === 'BUY' ? 'green' : 'red';
            return `<tr>
                <td>${fmtTime(t.time)}</td>
                <td>${esc(t.market || t.asset_id?.slice(0,12)+'...')}</td>
                <td class="r"><span class="${(t.outcome||'').toLowerCase() === 'yes' ? 'green' : 'red'}">${(t.outcome||'—').toUpperCase()}</span></td>
                <td class="r">${t.size}</td>
                <td class="r">${(t.price*100).toFixed(1)}¢</td>
                <td class="r"><span class="${sideClass}">${t.side}</span></td>
            </tr>`;
        }).join('') || '<tr><td colspan="6" class="empty">No trade log entries</td></tr>';
    }
}

// Legacy compat
function renderTrades() { renderLedger(); }

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

// ── Ledger tab buttons ──
document.querySelectorAll('.ledger-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.ledger-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentLedgerTab = btn.dataset.tab;
        renderLedger();
    });
});

// ── Stuart's Log ──
const LOG_URL = `${GITHUB_RAW}/stuart-log.json`;
const logToggle = document.getElementById('logToggle');
const logChevron = document.getElementById('logChevron');
const logBody = document.getElementById('logBody');
const logEntries = document.getElementById('logEntries');

logToggle.addEventListener('click', () => {
    logBody.classList.toggle('collapsed');
    logChevron.classList.toggle('collapsed');
});

async function loadLog() {
    try {
        const r = await fetch(LOG_URL + '?t=' + Date.now());
        if (!r.ok) throw new Error(r.statusText);
        const entries = await r.json();
        renderLog(entries);
    } catch(e) {
        logEntries.innerHTML = '<div class="empty">No log entries yet</div>';
    }
}

function renderLog(entries) {
    if (!entries || entries.length === 0) {
        logEntries.innerHTML = '<div class="empty">No log entries yet</div>';
        return;
    }
    // Show newest first, max 50
    const sorted = [...entries].sort((a,b) => new Date(b.time) - new Date(a.time)).slice(0, 50);
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
}

// ── Init ──
initChart();
loadLog();

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
// Refresh log every 2min
setInterval(loadLog, SNAPSHOT_INTERVAL);
