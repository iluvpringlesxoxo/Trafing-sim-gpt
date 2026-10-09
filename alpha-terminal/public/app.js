const state = {
  user: null, portfolio: null, markets: [], marketData: null, watchlist: [],
  orders: [], trades: [], history: [], leaderboard: [], notifications: [],
  currentView: 'dashboard', selectedSymbol: 'BTCUSDT', interval: '1h',
  orderSide: 'buy', orderType: 'market', lowerTab: 'positions',
  orderDraft: { quantity: '', limitPrice: '', triggerPrice: '' },
  marketSearch: '', marketFilter: 'ALL', marketSort: 'volume', startingCapital: '10000',
  candles: [], chartLoading: false, lastRefreshAt: 0, profilePublic: true,
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const content = () => $('#pageContent');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}
function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function money(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const maximumFractionDigits = Math.abs(n) > 0 && Math.abs(n) < 0.01 ? Math.max(4, digits) : digits;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits }).format(n);
}
function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(abs > 0 && abs < 0.01 ? 6 : 2);
}
function compactMoney(value) {
  const n = num(value, NaN);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return money(n, abs > 0 && abs < .01 ? 5 : 2);
}
function price(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const digits = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 3 : Math.abs(n) >= .01 ? 4 : 8;
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits }).format(n);
}
function pct(value, withSign = true) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${withSign && n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function signedMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`;
}
function signClass(value) {
  const n = Number(value);
  return n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral';
}
function marketBySymbol(symbol) { return state.markets.find((item) => item.symbol === symbol) || null; }
function coinGlyph(symbol) {
  const glyph = { BTCUSDT: '₿', ETHUSDT: '◆', SOLUSDT: '◎', XRPUSDT: '✕', BNBUSDT: '◆', DOGEUSDT: 'Ð', ADAUSDT: 'A', AVAXUSDT: '▲', LINKUSDT: '⬡', LTCUSDT: 'Ł', DOTUSDT: '●', TRXUSDT: '△' };
  return glyph[symbol] || symbol?.slice(0, 1) || '◈';
}
function coinClass(symbol) {
  return ({ BTCUSDT:'btc', ETHUSDT:'eth', SOLUSDT:'sol', XRPUSDT:'xrp', BNBUSDT:'bnb', DOGEUSDT:'doge', ADAUSDT:'ada', AVAXUSDT:'avax', LINKUSDT:'link', LTCUSDT:'ltc', DOTUSDT:'dot', TRXUSDT:'trx' })[symbol] || 'other';
}
function assetIcon(symbol, large = false) {
  const market = marketBySymbol(symbol);
  return `<span class="asset-icon asset-${coinClass(symbol)} ${large ? 'asset-icon-large' : ''}">${escapeHtml(coinGlyph(symbol))}</span>`;
}
function quoteOf(market) { return market?.quote || null; }
function marketFresh(market) { return Boolean(market?.quote?.dataMode === 'LIVE'); }
function dataPill(market) {
  const mode = market?.quote?.dataMode || 'UNAVAILABLE';
  const label = mode === 'LIVE' ? 'LIVE' : mode === 'STALE' ? 'STALE' : 'NO DATA';
  const cls = mode === 'LIVE' ? 'live' : mode === 'STALE' ? 'stale' : 'offline';
  return `<span class="pill ${cls}">${label}</span>`;
}
function symbolShort(symbol) { return String(symbol || '').replace('USDT', ''); }
function formatTimestamp(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return 'no quote received yet';
  if (seconds < 1) return 'updated just now';
  if (seconds < 60) return `${seconds}s old`;
  return `${Math.floor(seconds / 60)}m old`;
}
async function request(path, options = {}) {
  const init = { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } };
  const response = await fetch(path, init);
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok && payload?.error) throw new Error(payload.error.message || `Request failed (${response.status})`);
  if (!response.ok && !payload) throw new Error(`Request failed (${response.status})`);
  return payload;
}
function showToast(message, type = 'info') {
  const region = $('#toastRegion');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  region.append(node);
  window.setTimeout(() => node.remove(), 4200);
}
function showAuthGate() {
  $('#authGate').classList.remove('hidden');
  $('#appShell').classList.add('hidden');
}
function showAppShell() {
  $('#authGate').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
}
function selectedCapital(value) {
  state.startingCapital = String(value);
  const hidden = $('#registerForm [name="startingCapital"]');
  if (hidden) hidden.value = state.startingCapital;
  $('#capitalLabel').textContent = money(value,0);
  $$('.capital-presets button').forEach((button) => button.classList.toggle('selected', button.dataset.capital === state.startingCapital));
  const custom = $('#customCapital');
  if (custom) custom.value = '';
}
function switchAuthMode(mode) {
  const isRegister = mode === 'register';
  $$('.auth-tab').forEach((button) => button.classList.toggle('active', button.dataset.authMode === mode));
  $('#loginForm').classList.toggle('hidden', isRegister);
  $('#registerForm').classList.toggle('hidden', !isRegister);
  $('#authTitle').textContent = isRegister ? 'Build your trading desk' : 'Sign in to your desk';
  $('#authDescription').textContent = isRegister ? 'Choose your username and starting virtual balance.' : 'Pick up where your last market session ended.';
}

async function loadMarkets() {
  const payload = await request('/api/markets');
  state.markets = payload.markets || [];
  state.marketData = payload.marketData || null;
  return payload;
}
async function loadPortfolio() {
  const payload = await request('/api/portfolio');
  state.portfolio = payload.portfolio;
}
async function loadWatchlist() {
  const payload = await request('/api/watchlist');
  state.watchlist = payload.watchlist || [];
}
async function loadPageData(view = state.currentView) {
  if (!state.user) return;
  if (view === 'orders' || view === 'terminal') {
    const payload = await request('/api/orders');
    state.orders = payload.orders || [];
  }
  if (view === 'history') {
    const payload = await request('/api/trades');
    state.trades = payload.trades || [];
  }
  if (view === 'dashboard' || view === 'portfolio') {
    const payload = await request('/api/portfolio/history?limit=120');
    state.history = payload.snapshots || [];
  }
  if (view === 'dashboard') {
    const trades = await request('/api/trades?limit=5');
    state.trades = trades.trades || [];
  }
  if (view === 'leaderboard') {
    const payload = await request('/api/leaderboard');
    state.leaderboard = payload.leaderboard || [];
    state.leaderboardMethod = payload.methodology;
  }
}
async function refreshCore({ render = false } = {}) {
  if (!state.user) return;
  try {
    await Promise.all([loadMarkets(), loadPortfolio(), loadWatchlist()]);
    state.lastRefreshAt = Date.now();
    syncGlobalStatus();
    syncSharedNumbers();
    const activeInsidePage = content()?.contains(document.activeElement);
    if (render && state.currentView !== 'terminal' && !activeInsidePage) {
      await loadPageData();
      renderView();
    } else if (state.currentView === 'terminal') {
      syncTerminalQuote();
    }
  } catch (error) {
    console.error('Refresh failed:', error);
    syncGlobalStatus();
  }
}
function syncSharedNumbers() {
  if (!state.portfolio) return;
  const openCount = state.orders.filter((order) => order.status === 'open').length;
  const node = $('#openOrderCount');
  if (node) node.textContent = String(openCount);
  if ($('#sidebarUsername')) $('#sidebarUsername').textContent = state.user?.username || 'Trader';
  if ($('#topUsername')) $('#topUsername').textContent = state.user?.username || 'Trader';
  if ($('#sidebarAvatar')) $('#sidebarAvatar').textContent = (state.user?.username || 'A').slice(0,1).toUpperCase();
  if ($('#topAvatar')) $('#topAvatar').textContent = (state.user?.username || 'A').slice(0,1).toUpperCase();
  if ($('#footerClock')) $('#footerClock').textContent = new Date().toISOString().slice(11,19) + ' UTC';
}
function syncGlobalStatus() {
  const status = state.marketData || {};
  const mode = status.mode || 'UNAVAILABLE';
  const label = mode === 'LIVE' ? 'Market data live' : mode === 'STALE' ? 'Market data stale' : 'Market data unavailable';
  const color = mode === 'LIVE' ? 'var(--green)' : mode === 'STALE' ? 'var(--amber)' : 'var(--red)';
  if ($('#sidebarDataText')) $('#sidebarDataText').textContent = label;
  if ($('#sidebarDataDot')) { $('#sidebarDataDot').style.background = color; $('#sidebarDataDot').style.boxShadow = mode === 'LIVE' ? '0 0 9px rgba(57,214,160,.25)' : 'none'; }
  if ($('#footerDataStatus')) $('#footerDataStatus').textContent = label;
  if ($('#footerDataAge')) $('#footerDataAge').textContent = status.ageSeconds === null || status.ageSeconds === undefined ? '· no quote received yet' : `· ${formatAge(status.ageSeconds)}`;
  if ($('#footerDataDot')) $('#footerDataDot').style.background = color;
}
function setView(view) {
  state.currentView = view;
  $$('.nav-item[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  const labels = { dashboard:'Overview', markets:'Markets', terminal:'Trading terminal', portfolio:'Portfolio', orders:'Orders', history:'Trade history', leaderboard:'Leaderboard', settings:'Settings' };
  $('#topbarTitle').textContent = labels[view] || 'Workspace';
  renderView();
  void loadPageData(view).then(() => { if (state.currentView === view && view !== 'terminal') renderView(); }).catch((error) => console.warn('Page load:', error.message));
  if (view === 'terminal') void prepareTerminal();
}
function renderView() {
  if (!state.user) return;
  const renderers = { dashboard: renderDashboard, markets: renderMarketsPage, terminal: renderTerminal, portfolio: renderPortfolioPage, orders: renderOrdersPage, history: renderHistoryPage, leaderboard: renderLeaderboard, settings: renderSettings };
  content().innerHTML = (renderers[state.currentView] || renderDashboard)();
  if (state.currentView === 'dashboard') postDashboardRender();
  if (state.currentView === 'markets') wireMarketSearch();
  if (state.currentView === 'terminal') postTerminalRender();
  if (state.currentView === 'portfolio') postPortfolioRender();
  if (state.currentView === 'orders') wireOrderActions();
  if (state.currentView === 'settings') wireSettings();
  syncSharedNumbers();
}
function pageHeading(title, description, kicker = 'SIMULATION WORKSPACE', actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${escapeHtml(kicker)}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function metricCard(label, value, foot, icon, options = {}) {
  return `<article class="metric-card ${options.highlight ? 'highlight' : ''}"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon}</span></div><div class="metric-value ${options.valueClass || ''}">${value}</div><div class="metric-foot">${foot}</div></article>`;
}
function marketTableRows(markets, withAction = true) {
  if (!markets.length) return `<tr><td colspan="6"><div class="table-empty"><strong>No market data yet</strong>Quotes will appear after the provider connects. Nothing is being simulated behind the scenes.</div></td></tr>`;
  return markets.map((market) => {
    const q = market.quote;
    const change = q?.changePct;
    return `<tr data-symbol-row="${escapeHtml(market.symbol)}"><td><div class="asset-cell">${assetIcon(market.symbol)}<span><strong>${escapeHtml(market.name)}</strong><small>${escapeHtml(market.symbol.replace('USDT',''))} / USDT</small></span></div></td><td class="numeric">${q ? `$${price(q.last)}` : '—'}${q && q.dataMode !== 'LIVE' ? '<small style="display:block;color:var(--amber);font-size:8px">STALE</small>' : ''}</td><td class="numeric ${signClass(change)}">${pct(change)}</td><td class="numeric">${q?.volume ? compactNumber(q.volume) : '—'}</td><td>${dataPill(market)}</td><td class="numeric">${withAction ? `<button class="row-action" data-trade-symbol="${escapeHtml(market.symbol)}">Trade ↗</button>` : `<button class="row-action" data-watch-symbol="${escapeHtml(market.symbol)}">${state.watchlist.some((w) => w.symbol === market.symbol) ? '✓ Saved' : '+ Watch'}</button>`}</td></tr>`;
  }).join('');
}
function marketRanked(limit = 6) {
  return state.markets.slice().sort((a,b) => num(b.quote?.quoteVolume, -1) - num(a.quote?.quoteVolume, -1)).slice(0,limit);
}
function renderDashboard() {
  const p = state.portfolio || {};
  const status = state.marketData || {};
  const returnValue = num(p.returnPct);
  const markets = marketRanked(6);
  const positions = p.positions || [];
  const topFoot = p.missingMarks ? `<span class="negative">${p.missingMarks} missing mark(s)</span>` : '<span>Since account creation</span>';
  const pnlFoot = `Realized ${signedMoney(p.realizedPnl || 0)} <span>·</span> Unrealized ${signedMoney(p.unrealizedPnl || 0)}`;
  return `${pageHeading('Your market, at a glance', 'Track your simulated equity, positions, and the markets you follow.', 'PAPER TRADING DESK', `<span class="pill ${status.mode === 'LIVE' ? 'live' : status.mode === 'STALE' ? 'stale' : 'offline'}">${escapeHtml(status.mode || 'UNAVAILABLE')} DATA</span><button class="button button-secondary" data-view="terminal">Open terminal ↗</button>`)}
    <div class="grid metrics-grid">
      ${metricCard('TOTAL ACCOUNT EQUITY', money(p.equity), `<span class="${signClass(p.totalReturn)}">${signedMoney(p.totalReturn)}</span><span>total return</span>`, '◈', {highlight:true})}
      ${metricCard('TOTAL RETURN', pct(p.returnPct), `<span class="${signClass(p.returnPct)}">${signedMoney(p.totalReturn)}</span><span>from ${money(p.startingCapital)}</span>`, '↗', {valueClass:signClass(p.returnPct)})}
      ${metricCard('AVAILABLE CASH', money(p.availableCash), `<span>${money(p.reservedCash)} reserved</span>`, '◫')}
      ${metricCard('OPEN POSITIONS', String(positions.length), `<span>${Number(p.openOrders || 0)} open orders</span>`, '◰')}
    </div>
    ${status.mode !== 'LIVE' ? `<div class="panel panel-pad" style="margin-bottom:15px;border-color:rgba(248,199,106,.2)"><div style="display:flex;gap:10px;align-items:flex-start"><span style="color:var(--amber);font-size:17px">ⓘ</span><div><strong style="font-size:11px">${status.mode === 'STALE' ? 'Market data is stale' : 'Waiting for market data'}</strong><p style="color:var(--muted);font-size:10px;margin:4px 0 0;line-height:1.6">${escapeHtml(status.explanation || 'No prices are fabricated. Market orders remain blocked when reliable quotes are unavailable.')}${status.lastError ? ` Provider detail: ${escapeHtml(status.lastError)}` : ''}</p></div></div></div>` : ''}
    <div class="two-column">
      <section class="panel">
        <div class="panel-heading"><div><h2>Equity performance</h2><p>Stored account snapshots · USD</p></div><div class="chart-legend"><span><i class="legend-dot"></i> Equity</span><span id="equitySnapshotCount">${state.history.length} snapshots</span></div></div>
        <div class="chart-wrap"><canvas id="portfolioChart" aria-label="Portfolio equity history chart"></canvas><div id="portfolioChartEmpty" class="chart-empty hidden"><div><strong>Not enough history yet</strong>Your portfolio chart builds from persisted snapshots.</div></div></div>
      </section>
      <section class="panel">
        <div class="panel-heading"><div><h2>Asset allocation</h2><p>Spot exposure by market value</p></div><button class="text-button" data-view="portfolio">View portfolio ↗</button></div>
        <div id="dashboardAllocation" class="allocation-list">${renderAllocationRows(positions, 5)}</div>
        ${!positions.length ? '<div class="table-empty">You do not hold any assets yet. Explore a market and place a simulated trade to get started.</div>' : ''}
      </section>
    </div>
    <section class="panel table-panel">
      <div class="panel-heading"><div><h2>Market watch</h2><p>Crypto spot · 24-hour change · Binance public quotes</p></div><button class="text-button" data-view="markets">All markets ↗</button></div>
      <div class="table-scroll"><table><thead><tr><th>Asset</th><th class="numeric">Last price</th><th class="numeric">24H change</th><th class="numeric">24H volume</th><th>Feed</th><th></th></tr></thead><tbody>${marketTableRows(markets)}</tbody></table></div>
    </section>
    <section class="panel table-panel">
      <div class="panel-heading"><div><h2>Recent activity</h2><p>Your latest simulated executions</p></div><button class="text-button" data-view="history">View history ↗</button></div>
      ${renderRecentActivity()}
    </section>`;
}
function renderAllocationRows(positions, maxItems = 99) {
  if (!positions.length) return '';
  return positions.slice(0,maxItems).map((position) => `<div class="allocation-row"><div>${assetIcon(position.symbol)}</div><div class="asset-main"><strong>${escapeHtml(position.name)} <span class="muted">${escapeHtml(symbolShort(position.symbol))}</span></strong><div class="allocation-track"><i style="width:${Math.min(100,Math.max(0,num(position.allocationPct)))}%"></i></div></div><div class="asset-right"><strong>${position.marketValue === null ? '—' : money(position.marketValue)}</strong><small>${position.allocationPct === null ? 'Unpriced' : pct(position.allocationPct,false)}</small></div></div>`).join('');
}
function renderRecentActivity() {
  const rows = state.trades.slice(0,5);
  if (!rows.length) return '<div class="table-empty"><strong>No trades recorded</strong>Your executions will appear here after a successful simulated order.</div>';
  return `<div class="table-scroll"><table><thead><tr><th>Instrument</th><th>Side</th><th>Quantity</th><th class="numeric">Execution price</th><th class="numeric">Fee</th><th>Time</th></tr></thead><tbody>${rows.map((t) => `<tr><td><div class="asset-cell">${assetIcon(t.symbol)}<span><strong>${escapeHtml(t.name)}</strong><small>${escapeHtml(t.symbol)}</small></span></div></td><td class="${t.side === 'buy' ? 'positive' : 'negative'}">${escapeHtml(t.side.toUpperCase())}</td><td class="mono">${escapeHtml(t.quantity)}</td><td class="numeric">${money(t.execution_price)}</td><td class="numeric">${money(t.fee)}</td><td>${formatTimestamp(t.created_at)}</td></tr>`).join('')}</tbody></table></div>`;
}
function postDashboardRender() {
  drawPortfolioChart($('#portfolioChart'), state.history);
  wireMarketActions();
}
function drawPortfolioChart(canvas, snapshots) {
  if (!canvas) return;
  const empty = $('#portfolioChartEmpty');
  if (!snapshots?.length) { empty?.classList.remove('hidden'); return; }
  empty?.classList.add('hidden');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  canvas.width = Math.floor(rect.width * dpr); canvas.height = Math.floor(rect.height * dpr);
  ctx.scale(dpr,dpr);
  const w = rect.width, h = rect.height;
  const pad = { left: 9, right: 9, top: 12, bottom: 22 };
  const values = snapshots.map((item) => num(item.equity)).filter(Number.isFinite);
  if (!values.length) { empty?.classList.remove('hidden'); return; }
  const min = Math.min(...values), max = Math.max(...values), spread = Math.max(max-min,Math.max(Math.abs(max)*.001,1));
  const y = (value) => pad.top + (h-pad.top-pad.bottom) * (1-(value-(min-spread*.12))/(spread*1.24));
  const x = (index) => pad.left + (w-pad.left-pad.right) * (snapshots.length <= 1 ? .5 : index/(snapshots.length-1));
  ctx.strokeStyle = 'rgba(148,163,184,.12)'; ctx.lineWidth = 1;
  for (let i=0;i<4;i++){const gy=pad.top+(h-pad.top-pad.bottom)*i/3;ctx.beginPath();ctx.moveTo(pad.left,gy);ctx.lineTo(w-pad.right,gy);ctx.stroke();}
  const gradient = ctx.createLinearGradient(0,pad.top,0,h-pad.bottom);gradient.addColorStop(0,'rgba(146,148,255,.22)');gradient.addColorStop(1,'rgba(146,148,255,0)');
  ctx.beginPath(); values.forEach((value,index)=>{index?ctx.lineTo(x(index),y(value)):ctx.moveTo(x(index),y(value));});
  ctx.lineTo(x(values.length-1),h-pad.bottom);ctx.lineTo(x(0),h-pad.bottom);ctx.closePath();ctx.fillStyle=gradient;ctx.fill();
  ctx.beginPath();values.forEach((value,index)=>{index?ctx.lineTo(x(index),y(value)):ctx.moveTo(x(index),y(value));});ctx.strokeStyle='#9a9bff';ctx.lineWidth=2;ctx.stroke();
  ctx.fillStyle='#768298';ctx.font='9px ui-monospace,monospace';ctx.textAlign='left';ctx.fillText(compactMoney(max),pad.left,10);ctx.textAlign='right';ctx.fillText(compactMoney(min),w-pad.right,h-5);
}

function renderMarketsPage() {
  let markets = state.markets.slice();
  if (state.marketSearch) {
    const needle = state.marketSearch.toLowerCase();
    markets = markets.filter((market) => market.symbol.toLowerCase().includes(needle) || market.name.toLowerCase().includes(needle) || market.baseAsset.toLowerCase().includes(needle));
  }
  if (state.marketFilter === 'GAINERS') markets = markets.filter((m)=>m.quote).sort((a,b)=>num(b.quote.changePct)-num(a.quote.changePct));
  else if (state.marketFilter === 'LOSERS') markets = markets.filter((m)=>m.quote).sort((a,b)=>num(a.quote.changePct)-num(b.quote.changePct));
  else if (state.marketFilter === 'WATCHLIST') markets = markets.filter((m)=>state.watchlist.some((w)=>w.symbol===m.symbol));
  else markets.sort((a,b)=>state.marketSort==='change' ? num(b.quote?.changePct,-Infinity)-num(a.quote?.changePct,-Infinity) : state.marketSort==='name' ? a.name.localeCompare(b.name) : num(b.quote?.quoteVolume,-1)-num(a.quote?.quoteVolume,-1));
  const movers = state.markets.filter((m)=>m.quote).slice().sort((a,b)=>num(b.quote.changePct)-num(a.quote.changePct));
  const topMovers = movers.slice(0,3);
  const bottomMovers = movers.slice(-3).reverse();
  return `${pageHeading('Markets', 'Explore supported crypto spot pairs and act on real provider quotes.', 'GLOBAL MARKET VIEW', `<span class="pill ${state.marketData?.mode==='LIVE'?'live':state.marketData?.mode==='STALE'?'stale':'offline'}">${escapeHtml(state.marketData?.mode || 'UNAVAILABLE')} FEED</span>`)}
    <div class="market-grid">${[...topMovers,...bottomMovers].slice(0,6).map((market,index)=>`<article class="market-stat-card" data-market-card="${escapeHtml(market.symbol)}"><div class="market-card-top"><div class="asset-cell">${assetIcon(market.symbol)}<span><strong>${escapeHtml(market.name)}</strong><small>${escapeHtml(symbolShort(market.symbol))}/USDT</small></span></div>${dataPill(market)}</div><div class="market-price">${market.quote ? `$${price(market.quote.last)}`:'—'}</div><div class="market-change ${signClass(market.quote?.changePct)}">${pct(market.quote?.changePct)}</div><small>${index<3?'Top 24h mover':'Lower 24h mover'} · ${market.quote?.quoteVolume ? compactMoney(market.quote.quoteVolume)+' quote volume':'volume unavailable'}</small></article>`).join('') || '<div class="unavailable-card"><h3>Waiting for quotes</h3><p>Gainers and losers will be ranked only when real market data is available.</p></div>'}</div>
    <section class="panel table-panel"><div class="table-toolbar"><div><strong>Supported instruments</strong><br><small>${state.markets.length} crypto spot pairs · change window: rolling 24 hours</small></div><div class="search-row"><input class="page-input" id="marketSearchInput" value="${escapeHtml(state.marketSearch)}" placeholder="Search by name or symbol"><select class="filter-select" id="marketFilter"><option value="ALL" ${state.marketFilter==='ALL'?'selected':''}>All markets</option><option value="GAINERS" ${state.marketFilter==='GAINERS'?'selected':''}>Top gainers</option><option value="LOSERS" ${state.marketFilter==='LOSERS'?'selected':''}>Top losers</option><option value="WATCHLIST" ${state.marketFilter==='WATCHLIST'?'selected':''}>Watchlist</option></select></div></div>
      <div class="table-scroll"><table><thead><tr><th>Instrument</th><th class="numeric">Last price</th><th class="numeric">24H change</th><th class="numeric">Base volume</th><th>Quote feed</th><th></th></tr></thead><tbody>${marketTableRows(markets,false)}</tbody></table></div>
      <div class="table-note">Quotes use public Binance market data. BTCUSDT-style pair prices are denominated in USDT, treated as approximately USD 1:1 for this educational simulator. No USDT/USD conversion is modeled. Stock, ETF, forex, and derivative instruments are not enabled in this release.</div>
    </section>`;
}
function wireMarketSearch() {
  const search = $('#marketSearchInput');
  if (search) search.addEventListener('input', () => {
    state.marketSearch = search.value;
    const start = search.selectionStart;
    const page = content();
    const scrollY = window.scrollY;
    page.innerHTML = renderMarketsPage();
    window.scrollTo(0,scrollY);
    const replacement = $('#marketSearchInput'); replacement?.focus(); replacement?.setSelectionRange(start,start);
    wireMarketSearch(); wireMarketActions();
  });
  $('#marketFilter')?.addEventListener('change',(event)=>{state.marketFilter=event.target.value;renderView();});
  wireMarketActions();
}
function wireMarketActions() {
  $$('[data-trade-symbol]').forEach((button)=>button.addEventListener('click',()=>{state.selectedSymbol=button.dataset.tradeSymbol;setView('terminal');}));
  $$('[data-watch-symbol]').forEach((button)=>button.addEventListener('click',async()=>{
    const symbol=button.dataset.watchSymbol;
    try{
      if(state.watchlist.some((w)=>w.symbol===symbol)){await request(`/api/watchlist?symbol=${encodeURIComponent(symbol)}`,{method:'DELETE'});showToast(`${symbolShort(symbol)} removed from watchlist.`);}
      else{await request('/api/watchlist',{method:'POST',body:JSON.stringify({symbol})});showToast(`${symbolShort(symbol)} added to watchlist.`,'success');}
      await loadWatchlist();renderView();
    }catch(error){showToast(error.message,'error');}
  }));
  $$('[data-market-card]').forEach((node)=>node.addEventListener('click',(event)=>{if(!event.target.closest('button')){state.selectedSymbol=node.dataset.marketCard;setView('terminal');}}));
}

function renderTerminal() {
  const market = marketBySymbol(state.selectedSymbol) || state.markets[0] || {symbol:state.selectedSymbol,name:state.selectedSymbol,quote:null};
  const q = quoteOf(market);
  const watch = state.watchlist.length ? state.watchlist : [];
  const activeOrders = state.orders.filter((order)=>order.status==='open');
  return `${pageHeading('Trading terminal', 'A quote-driven paper-trading workspace. Orders affect only your virtual account.', 'SPOT EXECUTION DESK', `<span class="pill ${marketFresh(market)?'live':q?'stale':'offline'}">${q?.dataMode || 'NO DATA'}</span>`)}
    <div class="terminal-grid">
      <section class="panel terminal-watchlist"><div class="terminal-watch-head"><strong>Watchlist</strong><p>Choose an instrument to chart</p></div><div class="terminal-watchlist-inner">${watch.map((item)=>{const m=marketBySymbol(item.symbol);return `<button class="terminal-market-item ${item.symbol===state.selectedSymbol?'active':''}" data-select-symbol="${escapeHtml(item.symbol)}">${assetIcon(item.symbol)}<span class="term-meta"><strong>${escapeHtml(symbolShort(item.symbol))}</strong><small>${escapeHtml(item.name||m?.name||item.symbol)}</small></span><span class="term-quote">${m?.quote?`$${price(m.quote.last)}`:'—'}<small class="${signClass(m?.quote?.changePct)}">${pct(m?.quote?.changePct)}</small></span></button>`;}).join('') || '<div class="table-empty">Your watchlist is empty.</div>'}</div>
        <div class="terminal-add-watch"><select id="addWatchSelect" aria-label="Choose market to watch">${state.markets.filter((m)=>!watch.some((item)=>item.symbol===m.symbol)).map((m)=>`<option value="${escapeHtml(m.symbol)}">${escapeHtml(m.baseAsset)} / USDT</option>`).join('')}</select><button class="row-action" id="addWatchButton">+ Add</button></div>
      </section>
      <section class="panel chart-panel">
        <div class="asset-overview"><div class="asset-overview-left">${assetIcon(market.symbol,true)}<div><h2>${escapeHtml(market.name)} <span class="muted">${escapeHtml(symbolShort(market.symbol))}/USDT</span></h2><p>${escapeHtml(market.dataProvider||'Binance public market data')} · <span id="terminalQuoteAge">${q?formatAge(q.ageSeconds):'no quote'}</span></p></div></div><div class="asset-price-main"><strong id="terminalLastPrice">${q?`$${price(q.last)}`:'—'}</strong><small id="terminalChange" class="${signClass(q?.changePct)}">${pct(q?.changePct)}</small></div></div>
        <div class="chart-toolbar"><div class="time-switch" id="intervalSwitch">${[['1m','1m'],['5m','5m'],['15m','15m'],['1h','1H'],['4h','4H'],['1d','1D'],['1w','1W']].map(([value,label])=>`<button type="button" data-interval="${value}" class="${state.interval===value?'active':''}">${label}</button>`).join('')}</div><span class="chart-toolbar-label">OHLCV · UTC</span></div>
        <div class="chart-stage"><canvas id="candlestickCanvas" aria-label="Historical candlestick price chart"></canvas><div id="candleEmpty" class="chart-empty ${state.candles.length?'hidden':''}"><div><strong>${state.chartLoading?'Loading historical candles…':'No historical candles available'}</strong>${state.chartLoading?'':'Candles are loaded from the market provider. Check the feed or try another interval.'}</div></div></div>
        <div class="chart-disclaimer">Historical candles are provider data, not generated. Candle endpoints can be unavailable during provider outages. The simulator does not infer fills from future candle data.</div>
      </section>
      <section class="panel order-panel"><div class="order-panel-title"><h3>Place simulated order</h3><p>Virtual USD · 0.10% fee per fill</p></div>
        <div class="side-switch"><button type="button" data-side="buy" class="${state.orderSide==='buy'?'active buy':'buy'}">Buy spot</button><button type="button" data-side="sell" class="${state.orderSide==='sell'?'active sell':'sell'}">Sell holdings</button></div>
        <form id="orderForm" class="order-form" autocomplete="off">
          <div class="order-type-tabs">${[['market','Market'],['limit','Limit'],['stop_market','Stop'],['take_profit','Target']].map(([value,label])=>`<button type="button" data-order-type="${value}" class="${state.orderType===value?'active':''}">${label}</button>`).join('')}</div>
          <div class="field-wrap"><div class="field-label-row"><span>Quantity</span><small id="quantityAssetLabel">${escapeHtml(symbolShort(market.symbol))}</small></div><div class="input-with-unit"><input id="orderQuantity" name="quantity" type="number" min="0.00000001" step="any" inputmode="decimal" required value="${escapeHtml(state.orderDraft.quantity || '')}" placeholder="0.0000"><span class="input-unit" id="quantityUnit">${escapeHtml(symbolShort(market.symbol))}</span></div><div class="quantity-presets"><button type="button" data-quantity-pct="25">25%</button><button type="button" data-quantity-pct="50">50%</button><button type="button" data-quantity-pct="75">75%</button><button type="button" data-quantity-pct="100">100%</button></div></div>
          <div id="limitField" class="field-wrap ${state.orderType==='limit'?'':'hidden'}"><div class="field-label-row"><span>Limit price</span><small>USDT</small></div><div class="input-with-unit"><input id="limitPriceInput" name="limitPrice" type="number" min="0.00000001" step="any" value="${escapeHtml(state.orderDraft.limitPrice || '')}" placeholder="0.00"><span class="input-unit">USDT</span></div></div>
          <div id="triggerField" class="field-wrap ${['stop_market','take_profit'].includes(state.orderType)?'':'hidden'}"><div class="field-label-row"><span id="triggerLabel">Trigger price</span><small>USDT</small></div><div class="input-with-unit"><input id="triggerPriceInput" name="triggerPrice" type="number" min="0.00000001" step="any" value="${escapeHtml(state.orderDraft.triggerPrice || '')}" placeholder="0.00"><span class="input-unit">USDT</span></div></div>
          <div class="order-estimate"><div class="estimate-row"><span>Estimated execution</span><strong id="estimatePrice">${q?`$${price(state.orderSide==='buy'?q.ask||q.last:q.bid||q.last)}`:'—'}</strong></div><div class="estimate-row"><span>Estimated notional</span><strong id="estimateNotional">—</strong></div><div class="estimate-row"><span>Trading fee (0.10%)</span><strong id="estimateFee">—</strong></div><div class="estimate-row"><span>Available cash</span><strong id="estimateCash">${money(state.portfolio?.availableCash)}</strong></div></div>
          <button type="submit" id="orderSubmitButton" class="button order-submit buy">Buy ${escapeHtml(symbolShort(market.symbol))}</button>
          <p class="risk-note" id="orderRiskNote">Market orders use the latest bid/ask. Simulated fills can differ from the displayed last price. Stale quotes are rejected.</p>
        </form>
      </section>
    </div>
    <section class="panel terminal-lower"><div class="lower-tabs">${[['positions','Positions'],['orders','Open orders'],['history','Recent trades']].map(([tab,label])=>`<button type="button" data-lower-tab="${tab}" class="${state.lowerTab===tab?'active':''}">${label}${tab==='orders'?` (${activeOrders.length})`:''}</button>`).join('')}</div><div id="terminalLowerContent" class="lower-content">${renderTerminalLower()}</div></section>
    <div class="method-note">USDT quotes are treated as approximately USD 1:1 for account valuation. Only spot holdings are enabled here; derivatives, margin borrowing, and leveraged positions are not active in this build.</div>`;
}
function renderTerminalLower() {
  if (state.lowerTab === 'orders') return renderOrdersTable(state.orders.filter((order)=>order.status==='open'), true);
  if (state.lowerTab === 'history') return renderRecentActivity();
  const positions = state.portfolio?.positions || [];
  if (!positions.length) return '<div class="table-empty"><strong>No open spot positions</strong>Select an instrument above to view its chart and submit a virtual order.</div>';
  return `<div class="table-scroll"><table><thead><tr><th>Asset</th><th class="numeric">Quantity</th><th class="numeric">Average entry</th><th class="numeric">Last price</th><th class="numeric">Market value</th><th class="numeric">Unrealized P&L</th><th class="numeric">Return</th><th></th></tr></thead><tbody>${positions.map((position)=>`<tr><td><div class="asset-cell">${assetIcon(position.symbol)}<span><strong>${escapeHtml(position.name)}</strong><small>${escapeHtml(position.symbol)}</small></span></div></td><td class="numeric">${escapeHtml(position.quantity)}</td><td class="numeric">${money(position.averageEntryPrice)}</td><td class="numeric">${position.currentPrice===null?'—':money(position.currentPrice)}</td><td class="numeric">${position.marketValue===null?'—':money(position.marketValue)}</td><td class="numeric ${signClass(position.unrealizedPnl)}">${signedMoney(position.unrealizedPnl)}</td><td class="numeric ${signClass(position.returnPct)}">${pct(position.returnPct)}</td><td><button class="row-action" data-close-position="${escapeHtml(position.symbol)}">Sell</button></td></tr>`).join('')}</tbody></table></div>`;
}
async function prepareTerminal() {
  try {
    state.chartLoading = true;
    await Promise.all([loadPageData('terminal'), request('/api/trades').then((p)=>state.trades=p.trades||[]), fetchCandles()]);
    if (state.currentView === 'terminal') renderView();
  } catch (error) {
    state.chartLoading = false;
    if (state.currentView === 'terminal') renderView();
    console.warn('Terminal prepare:', error.message);
  }
}
async function fetchCandles() {
  state.chartLoading = true;
  if ($('#candleEmpty')) { $('#candleEmpty').classList.remove('hidden'); $('#candleEmpty').innerHTML = '<div><strong>Loading historical candles…</strong>Fetching actual market-provider OHLCV data.</div>'; }
  try {
    const payload = await request(`/api/markets/${encodeURIComponent(state.selectedSymbol)}/candles?interval=${encodeURIComponent(state.interval)}&limit=120`);
    state.candles = payload.candles || [];
  } catch (error) {
    state.candles = [];
    state.candleError = error.message;
  } finally { state.chartLoading = false; }
}
function drawCandles(canvas, candles) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width*dpr); canvas.height = Math.floor(rect.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
  const w=rect.width,h=rect.height;ctx.clearRect(0,0,w,h);
  if (!candles.length) { $('#candleEmpty')?.classList.remove('hidden'); return; }
  $('#candleEmpty')?.classList.add('hidden');
  const highs=candles.map(c=>num(c.high)),lows=candles.map(c=>num(c.low));
  let max=Math.max(...highs),min=Math.min(...lows);const spread=Math.max(max-min,Math.max(max*.0005,.00000001));max+=spread*.08;min-=spread*.08;
  const pad={left:8,right:8,top:12,bottom:25};const plotH=h-pad.top-pad.bottom;const plotW=w-pad.left-pad.right;
  const y=(value)=>pad.top+(max-value)/(max-min)*plotH;
  for(let i=0;i<5;i++){const gy=pad.top+plotH*i/4;ctx.beginPath();ctx.moveTo(pad.left,gy);ctx.lineTo(w-pad.right,gy);ctx.strokeStyle='rgba(148,163,184,.12)';ctx.lineWidth=1;ctx.stroke();const v=max-(max-min)*i/4;ctx.fillStyle='#68758a';ctx.font='9px ui-monospace,monospace';ctx.textAlign='right';ctx.fillText(price(v),w-pad.right,Math.max(9,gy-3));}
  const candleW=Math.max(2,Math.min(11,(plotW/candles.length)*.61));
  candles.forEach((c,index)=>{
    const cx=pad.left+(index+.5)*plotW/candles.length;const open=num(c.open),close=num(c.close),high=num(c.high),low=num(c.low);const rising=close>=open;const color=rising?'#39d6a0':'#fb7185';
    ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(cx,y(high));ctx.lineTo(cx,y(low));ctx.stroke();
    ctx.fillStyle=color;const top=Math.min(y(open),y(close));const body=Math.max(1,Math.abs(y(open)-y(close)));ctx.fillRect(cx-candleW/2,top,candleW,body);
  });
  const first=new Date(candles[0].time*1000),last=new Date(candles[candles.length-1].time*1000);ctx.fillStyle='#68758a';ctx.font='9px ui-monospace,monospace';ctx.textAlign='left';ctx.fillText(first.toISOString().slice(5,16).replace('T',' '),pad.left,h-6);ctx.textAlign='right';ctx.fillText(last.toISOString().slice(5,16).replace('T',' '),w-pad.right,h-6);
  const hover=state.chartHoverIndex;if(Number.isInteger(hover)&&hover>=0&&hover<candles.length){const c=candles[hover];const cx=pad.left+(hover+.5)*plotW/candles.length;ctx.setLineDash([3,3]);ctx.strokeStyle='rgba(225,231,241,.5)';ctx.beginPath();ctx.moveTo(cx,pad.top);ctx.lineTo(cx,h-pad.bottom);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#e6edf6';ctx.font='9px ui-monospace,monospace';ctx.textAlign='left';const info=`O ${price(c.open)}  H ${price(c.high)}  L ${price(c.low)}  C ${price(c.close)}`;ctx.fillText(info,Math.min(w-190,Math.max(8,cx+6)),h-pad.bottom+12);}
}
function captureOrderDraft() {
  if ($('#orderQuantity')) state.orderDraft.quantity = $('#orderQuantity').value;
  if ($('#limitPriceInput')) state.orderDraft.limitPrice = $('#limitPriceInput').value;
  if ($('#triggerPriceInput')) state.orderDraft.triggerPrice = $('#triggerPriceInput').value;
}
function postTerminalRender() {
  $$('[data-select-symbol]').forEach((button)=>button.addEventListener('click',async()=>{
    state.selectedSymbol=button.dataset.selectSymbol;
    state.candles=[];state.chartLoading=true;renderView();await fetchCandles();if(state.currentView==='terminal')renderView();
  }));
  $$('[data-interval]').forEach((button)=>button.addEventListener('click',async()=>{
    state.interval=button.dataset.interval;state.candles=[];state.chartLoading=true;renderView();await fetchCandles();if(state.currentView==='terminal')renderView();
  }));
  $$('[data-side]').forEach((button)=>button.addEventListener('click',()=>{
    captureOrderDraft(); state.orderSide=button.dataset.side;renderView();
  }));
  $$('[data-order-type]').forEach((button)=>button.addEventListener('click',()=>{
    captureOrderDraft(); state.orderType=button.dataset.orderType;renderView();
  }));
  $$('[data-quantity-pct]').forEach((button)=>button.addEventListener('click',()=>{
    const market=marketBySymbol(state.selectedSymbol),q=market?.quote;const p=state.portfolio||{};
    const base=state.orderSide==='buy'?num(p.availableCash):num(p.positions?.find((x)=>x.symbol===state.selectedSymbol)?.availableQuantity);
    const px=state.orderSide==='buy'?num(q?.ask||q?.last):num(q?.bid||q?.last);
    if(!px||!base){showToast(state.orderSide==='buy'?'No available virtual cash.':'No unreserved holdings to sell.','error');return;}
    const fraction=Number(button.dataset.quantityPct)/100;
    const quantity=state.orderSide==='buy'?(base*fraction)/(px*1.001):base*fraction;
    $('#orderQuantity').value=Math.max(0,quantity).toFixed(8).replace(/0+$/,'').replace(/\.$/,'');
    captureOrderDraft(); updateOrderEstimate();
  }));
  $('#orderForm')?.addEventListener('input',()=>{captureOrderDraft();updateOrderEstimate();});
  $('#orderForm')?.addEventListener('submit',submitOrderForm);
  $('#addWatchButton')?.addEventListener('click',async()=>{
    const symbol=$('#addWatchSelect')?.value;if(!symbol)return;
    try{await request('/api/watchlist',{method:'POST',body:JSON.stringify({symbol})});await loadWatchlist();renderView();showToast(`${symbolShort(symbol)} added to watchlist.`,'success');}catch(error){showToast(error.message,'error');}
  });
  $$('[data-lower-tab]').forEach((button)=>button.addEventListener('click',()=>{state.lowerTab=button.dataset.lowerTab;renderView();}));
  $$('[data-close-position]').forEach((button)=>button.addEventListener('click',()=>{const position=state.portfolio?.positions?.find((p)=>p.symbol===button.dataset.closePosition);if(position){state.selectedSymbol=position.symbol;state.orderSide='sell';state.orderType='market';state.orderDraft.quantity=position.availableQuantity;state.orderDraft.limitPrice='';state.orderDraft.triggerPrice='';setView('terminal');}}));
  const canvas=$('#candlestickCanvas');drawCandles(canvas,state.candles);
  canvas?.addEventListener('pointermove',(event)=>{const rect=canvas.getBoundingClientRect();const index=Math.max(0,Math.min(state.candles.length-1,Math.floor((event.clientX-rect.left)/rect.width*state.candles.length)));state.chartHoverIndex=index;drawCandles(canvas,state.candles);});
  canvas?.addEventListener('pointerleave',()=>{state.chartHoverIndex=null;drawCandles(canvas,state.candles);});
  updateOrderEstimate();
}
function syncTerminalQuote() {
  if(state.currentView!=='terminal')return;
  const market=marketBySymbol(state.selectedSymbol),q=market?.quote;
  if($('#terminalLastPrice'))$('#terminalLastPrice').textContent=q?`$${price(q.last)}`:'—';
  if($('#terminalChange')){$('#terminalChange').textContent=pct(q?.changePct);$('#terminalChange').className=signClass(q?.changePct);}
  if($('#terminalQuoteAge'))$('#terminalQuoteAge').textContent=q?formatAge(q.ageSeconds):'no quote';
  if($('#estimateCash'))$('#estimateCash').textContent=money(state.portfolio?.availableCash);
  updateOrderEstimate();
}
function updateOrderEstimate() {
  const market=marketBySymbol(state.selectedSymbol),q=market?.quote;
  const quantity=num($('#orderQuantity')?.value,0);
  const inputPrice=state.orderType==='limit'?num($('#limitPriceInput')?.value,0):state.orderType==='stop_market'||state.orderType==='take_profit'?num($('#triggerPriceInput')?.value,0):0;
  const execution=state.orderType==='limit'?inputPrice:num(state.orderSide==='buy'?(q?.ask||q?.last):(q?.bid||q?.last),0);
  const notional=Math.max(0,quantity*execution),fee=notional*.001;
  if($('#estimatePrice'))$('#estimatePrice').textContent=execution?`$${price(execution)}`:'—';
  if($('#estimateNotional'))$('#estimateNotional').textContent=quantity&&execution?money(notional):'—';
  if($('#estimateFee'))$('#estimateFee').textContent=quantity&&execution?money(fee):'—';
  if($('#estimateCash'))$('#estimateCash').textContent=money(state.portfolio?.availableCash);
  const trigger=state.orderType==='stop_market'||state.orderType==='take_profit';
  $('#triggerField')?.classList.toggle('hidden',!trigger);
  $('#limitField')?.classList.toggle('hidden',state.orderType!=='limit');
  if($('#triggerLabel'))$('#triggerLabel').textContent=state.orderType==='take_profit'?'Target trigger price':'Stop trigger price';
  const submit=$('#orderSubmitButton');
  if(submit){submit.textContent=`${state.orderSide==='buy'?'Buy':'Sell'} ${symbolShort(state.selectedSymbol)}`;submit.className=`button order-submit ${state.orderSide}`;submit.disabled=!quantity||quantity<=0;}
  if($('#orderRiskNote'))$('#orderRiskNote').textContent=state.orderType==='stop_market'?'A stop triggers at the selected price, then sells against the best available bid. The fill can be worse than the trigger.':state.orderType==='take_profit'?'A target order triggers when the bid reaches the target and sells against the available bid.':state.orderType==='limit'?'A limit order fills only when the provider quote meets your limit. Buy orders reserve virtual cash; sell orders reserve holdings.':'Market orders use the latest best bid/ask. Orders are blocked when quotes are stale.';
}
async function submitOrderForm(event) {
  event.preventDefault();
  const quantity=$('#orderQuantity').value;
  const body={symbol:state.selectedSymbol,side:state.orderSide,orderType:state.orderType,quantity,clientOrderId:crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`};
  if(state.orderType==='limit')body.limitPrice=$('#limitPriceInput').value;
  if(['stop_market','take_profit'].includes(state.orderType))body.triggerPrice=$('#triggerPriceInput').value;
  const submit=$('#orderSubmitButton');if(submit){submit.disabled=true;submit.textContent='Processing…';}
  try{
    const result=await request('/api/orders',{method:'POST',body:JSON.stringify(body)});
    const order=result.order;
    if(!order){throw new Error('The server did not return an order result.');}
    if(order.status==='rejected')showToast(order.rejection_reason||'Order rejected by the simulator.','error');
    else if(order.status==='filled')showToast(`${order.side.toUpperCase()} ${order.quantity} ${order.symbol} filled. Review the execution price in Trade history.`,'success');
    else showToast(`Order ${order.status}. It will be monitored against fresh market quotes.`, 'success');
    if(order.status!=='rejected')state.orderDraft={quantity:'',limitPrice:'',triggerPrice:''};
    await Promise.all([loadPortfolio(),loadMarkets(),loadWatchlist(),loadPageData('terminal')]);
    const t=await request('/api/trades');state.trades=t.trades||[];
    renderView();
  }catch(error){showToast(error.message,'error');}
  finally{if($('#orderSubmitButton'))updateOrderEstimate();}
}

function renderPortfolioPage() {
  const p=state.portfolio||{};const positions=p.positions||[];
  return `${pageHeading('Portfolio', 'Account equity is valued from virtual cash and marked spot holdings.', 'ACCOUNT ANALYTICS', `<button class="button button-secondary" data-export-csv="trades">Export trades ↓</button>`)}
    <div class="grid metrics-grid">
      ${metricCard('TOTAL EQUITY',money(p.equity),`Initial capital ${money(p.startingCapital)}`,'◈',{highlight:true})}
      ${metricCard('REALIZED P&L',signedMoney(p.realizedPnl),'<span>Closed quantity · fees on sales included</span>','↗',{valueClass:signClass(p.realizedPnl)})}
      ${metricCard('UNREALIZED P&L',signedMoney(p.unrealizedPnl),'<span>Open spot positions</span>','⌁',{valueClass:signClass(p.unrealizedPnl)})}
      ${metricCard('FEES PAID',money(p.feesPaid),'<span>0.10% per simulated fill</span>','◫')}
    </div>
    <div class="portfolio-breakdown">
      <section class="panel"><div class="panel-heading"><div><h2>Allocation by asset</h2><p>Share of currently marked account equity</p></div></div><div class="donut-wrap"><canvas id="allocationDonut" class="donut-canvas"></canvas><div id="donutLegend" class="donut-legend"></div></div><div class="method-note">Unpriced positions are excluded from marked spot value and are called out below. Cash includes both available and reserved virtual USD.</div></section>
      <section class="panel"><div class="panel-heading"><div><h2>Account composition</h2><p>Current simulated balances</p></div></div><div class="allocation-list" style="padding-top:3px">${[['Available cash',p.availableCash,'cash'],['Reserved cash',p.reservedCash,'reserved'],['Spot asset value',p.spotValue,'assets'],['Account equity',p.equity,'equity']].map(([label,value,key])=>`<div class="allocation-row"><div class="asset-icon">${key==='cash'?'$':key==='reserved'?'⌑':key==='assets'?'◈':'Σ'}</div><div class="asset-main"><strong>${label}</strong><small>${key==='reserved'?'Held for open buy limit orders':key==='assets'?'Last-known provider marks':key==='equity'?'Cash + owned spot holdings':'Spendable for new buys'}</small></div><div class="asset-right"><strong>${money(value)}</strong></div></div>`).join('')}</div><div class="method-note">Return: ${pct(p.returnPct)} (${signedMoney(p.totalReturn)}) vs the permanently recorded starting capital. No external virtual deposits or resets are available in this release.</div></section>
    </div>
    <section class="panel table-panel"><div class="panel-heading"><div><h2>Open positions</h2><p>Weighted-average entry-cost accounting · fractional spot quantities supported up to 8 decimals</p></div><button class="text-button" data-view="terminal">Trade ↗</button></div>${positions.length?`<div class="table-scroll"><table><thead><tr><th>Instrument</th><th class="numeric">Quantity</th><th class="numeric">Available / reserved</th><th class="numeric">Avg entry</th><th class="numeric">Mark price</th><th class="numeric">Market value</th><th class="numeric">Unrealized P&L</th><th class="numeric">Return</th></tr></thead><tbody>${positions.map((pos)=>`<tr><td><div class="asset-cell">${assetIcon(pos.symbol)}<span><strong>${escapeHtml(pos.name)}</strong><small>${escapeHtml(pos.symbol)}</small></span></div></td><td class="numeric">${escapeHtml(pos.quantity)}</td><td class="numeric">${escapeHtml(pos.availableQuantity)} / ${escapeHtml(pos.reservedQuantity)}</td><td class="numeric">${money(pos.averageEntryPrice)}</td><td class="numeric">${pos.currentPrice===null?'<span class="negative">Unpriced</span>':money(pos.currentPrice)}</td><td class="numeric">${pos.marketValue===null?'—':money(pos.marketValue)}</td><td class="numeric ${signClass(pos.unrealizedPnl)}">${signedMoney(pos.unrealizedPnl)}</td><td class="numeric ${signClass(pos.returnPct)}">${pct(pos.returnPct)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="table-empty"><strong>No open positions</strong>Your account starts in cash. Spot holdings will appear after a buy order fills.</div>'}</section>
    <section class="panel table-panel"><div class="panel-heading"><div><h2>Performance history</h2><p>Equity snapshots persisted by the simulator</p></div><span class="pill">${state.history.length} SNAPSHOTS</span></div><div class="chart-wrap" style="height:230px"><canvas id="portfolioDetailChart"></canvas><div id="portfolioDetailEmpty" class="chart-empty ${state.history.length?'hidden':''}"><div><strong>Waiting for portfolio history</strong>Snapshots are stored on account creation, executions, and the periodic snapshot timer.</div></div></div></section>
    ${p.warning?`<div class="method-note"><span class="negative">Valuation warning:</span> ${escapeHtml(p.warning)}</div>`:''}`;
}
function postPortfolioRender() {
  drawPortfolioChart($('#portfolioDetailChart'),state.history);
  const positions=state.portfolio?.positions||[];
  const colors=['#9294ff','#70d6ff','#39d6a0','#f8c76a','#fba1ae','#9c8cff','#5eead4','#93c5fd','#fb923c','#f472b6','#a3e635','#c4b5fd'];
  const canvas=$('#allocationDonut');
  const legend=$('#donutLegend');
  if(!canvas||!legend)return;
  legend.innerHTML=positions.length?positions.map((p,i)=>`<div class="donut-legend-row"><i style="background:${colors[i%colors.length]}"></i><span>${escapeHtml(p.name)}</span><strong>${p.allocationPct===null?'—':pct(p.allocationPct,false)}</strong></div>`).join(''):`<div class="muted" style="font-size:10px;line-height:1.7">No spot assets held.<br>Available virtual cash: ${money(state.portfolio?.availableCash)}.</div>`;
  const rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;if(!rect.width||!rect.height)return;
  canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);const cx=rect.width/2,cy=rect.height/2,r=Math.min(rect.width,rect.height)*.42,inner=r*.69;
  ctx.clearRect(0,0,rect.width,rect.height);const vals=positions.map(p=>Math.max(0,num(p.marketValue)));const total=vals.reduce((a,b)=>a+b,0);
  ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.strokeStyle='#273141';ctx.lineWidth=r-inner;ctx.stroke();
  let angle=-Math.PI/2;if(total>0){vals.forEach((v,i)=>{if(v<=0)return;const next=angle+v/total*Math.PI*2;ctx.beginPath();ctx.arc(cx,cy,r,angle,next);ctx.strokeStyle=colors[i%colors.length];ctx.lineWidth=r-inner;ctx.lineCap='butt';ctx.stroke();angle=next;});}
  ctx.fillStyle='#eef2f8';ctx.font='600 13px ui-monospace,monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(total>0?compactMoney(total):'CASH',cx,cy-3);ctx.fillStyle='#748197';ctx.font='9px ui-sans-serif,system-ui';ctx.fillText('spot assets',cx,cy+13);
}

function renderOrdersTable(orders, allowCancel=false) {
  if(!orders.length)return '<div class="table-empty"><strong>No matching orders</strong>Open orders and their state changes appear here after submission.</div>';
  return `<div class="table-scroll"><table><thead><tr><th>Instrument</th><th>Side</th><th>Order type</th><th class="numeric">Quantity</th><th class="numeric">Limit / trigger</th><th>Status</th><th>Submitted</th><th></th></tr></thead><tbody>${orders.map((order)=>`<tr><td><div class="asset-cell">${assetIcon(order.symbol)}<span><strong>${escapeHtml(symbolShort(order.symbol))}</strong><small>${escapeHtml(order.symbol)}</small></span></div></td><td class="${order.side==='buy'?'positive':'negative'}">${escapeHtml(order.side.toUpperCase())}</td><td>${escapeHtml(order.order_type.replace('_',' ').toUpperCase())}</td><td class="numeric">${escapeHtml(order.quantity)}</td><td class="numeric">${order.limit_price?money(order.limit_price):order.trigger_price?money(order.trigger_price):'—'}</td><td><span class="pill ${order.status==='filled'?'live':order.status==='rejected'?'offline':order.status==='open'?'stale':''}">${escapeHtml(order.status.toUpperCase())}</span>${order.rejection_reason?`<small style="display:block;color:var(--red);white-space:normal;max-width:190px;margin-top:4px">${escapeHtml(order.rejection_reason)}</small>`:''}</td><td>${formatTimestamp(order.created_at)}</td><td>${allowCancel&&order.status==='open'?`<button class="row-action danger" data-cancel-order="${escapeHtml(order.id)}">Cancel</button>`:''}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderOrdersPage() {
  const all=state.orders||[];const open=all.filter(o=>o.status==='open');const history=all.filter(o=>o.status!=='open');
  return `${pageHeading('Order management', 'Inspect pending, filled, cancelled, and rejected simulated orders.', 'EXECUTION LOG', `<button class="button button-primary" data-view="terminal">New order ↗</button>`)}
    <div class="grid metrics-grid">${metricCard('OPEN ORDERS',String(open.length),'<span>Monitored against fresh quotes</span>','☷')}${metricCard('FILLED ORDERS',String(all.filter(o=>o.status==='filled').length),'<span>Completed virtual executions</span>','✓')}${metricCard('CANCELLED',String(all.filter(o=>o.status==='cancelled').length),'<span>Reservations released</span>','↶')}${metricCard('REJECTED',String(all.filter(o=>o.status==='rejected').length),'<span>See reason in order record</span>','!')}</div>
    <section class="panel table-panel"><div class="panel-heading"><div><h2>Open orders</h2><p>Eligible orders can be cancelled before execution.</p></div><span class="pill stale">${open.length} PENDING</span></div>${renderOrdersTable(open,true)}</section>
    <section class="panel table-panel"><div class="panel-heading"><div><h2>Order history</h2><p>Order status is stored server-side; executed fills are immutable records.</p></div></div>${renderOrdersTable(history,false)}</section>`;
}
function wireOrderActions() {
  $$('[data-cancel-order]').forEach((button)=>button.addEventListener('click',async()=>{
    button.disabled=true;
    try{await request(`/api/orders/${encodeURIComponent(button.dataset.cancelOrder)}`,{method:'DELETE'});await Promise.all([loadPageData(state.currentView),loadPortfolio()]);renderView();showToast('Open order cancelled and reservations released.','success');}
    catch(error){showToast(error.message,'error');button.disabled=false;}
  }));
}
function renderHistoryPage() {
  const trades=state.trades||[];
  return `${pageHeading('Trade history', 'A persisted record of completed simulated fills. Export only your own data.', 'EXECUTION LEDGER', `<button class="button button-secondary" id="downloadTradesButton">Export CSV ↓</button>`)}
    <div class="grid metrics-grid">${metricCard('COMPLETED FILLS',String(trades.length),'<span>Execution records</span>','✓')}${metricCard('TOTAL FEES',money(trades.reduce((sum,t)=>sum+num(t.fee),0)),'<span>Fees recorded per fill</span>','◫')}${metricCard('BUY FILLS',String(trades.filter(t=>t.side==='buy').length),'<span>Spot acquisitions</span>','↗')}${metricCard('SELL FILLS',String(trades.filter(t=>t.side==='sell').length),'<span>Spot disposals</span>','↘')}</div>
    <section class="panel table-panel"><div class="panel-heading"><div><h2>Executions</h2><p>Historical fills include price, quantity, fee, and order reference.</p></div><span class="pill">${trades.length} RECORDS</span></div>${renderRecentActivityAll(trades)}</section>
    <div class="method-note">Execution records are append-only in this application version. Spot realized P&L uses weighted-average cost and subtracts the sell-side fee; total equity also reflects buy-side fees through cash accounting.</div>`;
}
function renderRecentActivityAll(trades) {
  if(!trades.length)return '<div class="table-empty"><strong>No executions yet</strong>Your completed trades will appear here after the quote source is available and an order is valid.</div>';
  return `<div class="table-scroll"><table><thead><tr><th>Execution ID</th><th>Instrument</th><th>Side</th><th class="numeric">Quantity</th><th class="numeric">Execution price</th><th class="numeric">Notional</th><th class="numeric">Fee</th><th class="numeric">Realized P&L</th><th>Timestamp</th></tr></thead><tbody>${trades.map((t)=>`<tr><td class="mono">${escapeHtml(String(t.id).slice(0,8))}…</td><td><div class="asset-cell">${assetIcon(t.symbol)}<span><strong>${escapeHtml(t.name)}</strong><small>${escapeHtml(t.symbol)}</small></span></div></td><td class="${t.side==='buy'?'positive':'negative'}">${escapeHtml(t.side.toUpperCase())}</td><td class="numeric">${escapeHtml(t.quantity)}</td><td class="numeric">${money(t.execution_price)}</td><td class="numeric">${money(num(t.quantity)*num(t.execution_price))}</td><td class="numeric">${money(t.fee)}</td><td class="numeric ${signClass(t.realized_pnl)}">${signedMoney(t.realized_pnl)}</td><td>${formatTimestamp(t.created_at)}</td></tr>`).join('')}</tbody></table></div>`;
}
function exportTradesCsv() {
  const trades=state.trades||[];
  if(!trades.length){showToast('There are no executions to export yet.','error');return;}
  const columns=['id','symbol','name','side','order_type','quantity','execution_price','fee','realized_pnl','created_at'];
  const header=columns.join(',');
  const rows=trades.map((trade)=>columns.map((column)=>{
    const value=String(trade[column]??'');return `"${value.replace(/"/g,'""')}"`;
  }).join(','));
  const blob=new Blob([[header,...rows].join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`alpha-terminal-trades-${new Date().toISOString().slice(0,10)}.csv`;document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);showToast('Your trade history CSV was exported.','success');
}

function renderLeaderboard() {
  const board=state.leaderboard||[];const top=board.slice(0,3);const first=top.find(x=>x.rank===1);const second=top.find(x=>x.rank===2);const third=top.find(x=>x.rank===3);
  return `${pageHeading('Leaderboard', 'Compare normalized paper-trading returns. Starting balance alone does not determine rank.', 'SEASON · ALL TIME', `<span class="pill">SERVER CALCULATED</span>`)}
    <div class="leaderboard-top">${[second,first,third].map((entry,index)=>entry?`<div class="leaderboard-podium ${entry.rank===1?'first':''}"><span class="podium-rank">${entry.rank===1?'♛':`#${entry.rank}`}</span><h3>${escapeHtml(entry.username)}</h3><div class="podium-return ${signClass(entry.returnPct)}">${pct(entry.returnPct)}</div><small>${signedMoney(entry.profit)} · ${entry.trades} fills</small></div>`:'<div class="leaderboard-podium"><span class="podium-rank">—</span><h3>Waiting for traders</h3><div class="podium-return neutral">—</div><small>No fabricated leaderboard entries</small></div>').join('')}</div>
    <section class="panel table-panel"><div class="panel-heading"><div><h2>Performance ranking</h2><p>Public profiles only · return normalized to each user's starting virtual capital</p></div><span class="pill live">${board.length} TRADERS</span></div>
      ${board.length?`<div class="table-scroll"><table><thead><tr><th>Rank</th><th>Trader</th><th class="numeric">Return</th><th class="numeric">Profit / loss</th><th class="numeric">Completed fills</th><th class="numeric">Realized P&L</th></tr></thead><tbody>${board.map((entry)=>`<tr><td><strong class="${entry.rank<=3?'positive':''}">#${entry.rank}</strong></td><td><div class="asset-cell"><span class="mini-avatar">${escapeHtml(entry.username.slice(0,1).toUpperCase())}</span><span><strong>${escapeHtml(entry.username)}</strong><small>Public trader profile</small></span></div></td><td class="numeric ${signClass(entry.returnPct)}">${pct(entry.returnPct)}</td><td class="numeric ${signClass(entry.profit)}">${signedMoney(entry.profit)}</td><td class="numeric">${entry.trades}</td><td class="numeric ${signClass(entry.realizedPnl)}">${signedMoney(entry.realizedPnl)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="table-empty"><strong>No public traders yet</strong>Create an account to start a persisted paper-trading record. This board does not include demo users.</div>'}
      <div class="table-note">${escapeHtml(state.leaderboardMethod||'Return = (current equity − initial virtual capital) / initial virtual capital.')} Win rate, risk-adjusted performance, weekly/monthly seasons, and challenge leaderboards are not yet enabled.</div>
    </section>`;
}
function renderSettings() {
  const user=state.user||{};
  return `${pageHeading('Settings', 'Manage your profile and privacy preferences for this simulation account.', 'ACCOUNT PREFERENCES')}
    <div class="settings-grid"><section class="panel"><div class="panel-heading"><div><h2>Public profile</h2><p>Your email and account balance are never shown on the public leaderboard.</p></div></div>
      <form id="settingsForm" class="settings-form"><label>Username<input name="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_-]{3,20}" value="${escapeHtml(user.username)}"></label><label>Avatar URL (optional)<input name="avatarUrl" type="url" value="${escapeHtml(user.avatarUrl||'')}" placeholder="https://example.com/avatar.png"></label>
      <div class="settings-switch"><div><strong>Show my statistics on the leaderboard</strong><small>If disabled, your public profile and row are omitted from public ranking responses.</small></div><button type="button" class="toggle-switch ${user.leaderboardPublic?'on':''}" id="publicStatsToggle" aria-label="Toggle public statistics" aria-pressed="${Boolean(user.leaderboardPublic)}"></button></div>
      <button class="button button-primary" type="submit">Save profile changes</button><p id="settingsMessage" class="form-message" aria-live="polite"></p></form>
    </section><div class="grid" style="align-content:start;gap:14px"><section class="panel notice-card"><h3>Simulation boundaries</h3><p>Your balance is virtual. The application does not connect to broker execution and cannot place real financial orders. Market quotes are public crypto spot data and may be stale or unavailable.</p><p>USDT prices are treated as approximately USD 1:1. Slippage beyond the displayed bid/ask is not modeled in this spot-only release.</p></section><section class="panel notice-card"><h3>Account summary</h3><p><strong style="color:#dbe3ee">Username:</strong> ${escapeHtml(user.username)}<br><strong style="color:#dbe3ee">Joined:</strong> ${formatTimestamp(user.createdAt)}<br><strong style="color:#dbe3ee">Starting capital:</strong> ${money(state.portfolio?.startingCapital)}<br><strong style="color:#dbe3ee">Base currency:</strong> USD (simulated)</p></section><section class="panel notice-card"><h3>Security</h3><p>Passwords are hashed server-side. Sessions use HttpOnly cookies and account endpoints enforce ownership. Password reset, email verification, MFA, and avatar uploads are not included yet.</p><button class="button button-secondary" id="settingsLogoutButton">Log out ↪</button></section></div></div>`;
}
function wireSettings() {
  let publicEnabled=Boolean(state.user?.leaderboardPublic);
  const toggle=$('#publicStatsToggle');
  toggle?.addEventListener('click',()=>{publicEnabled=!publicEnabled;toggle.classList.toggle('on',publicEnabled);toggle.setAttribute('aria-pressed',String(publicEnabled));});
  $('#settingsForm')?.addEventListener('submit',async(event)=>{
    event.preventDefault();const form=new FormData(event.currentTarget);
    try{
      const payload=await request('/api/user/profile',{method:'PATCH',body:JSON.stringify({username:form.get('username'),avatarUrl:form.get('avatarUrl')||null,leaderboardPublic:publicEnabled})});
      state.user=payload.user;syncSharedNumbers();$('#settingsMessage').textContent='Profile saved.';$('#settingsMessage').classList.add('success');showToast('Profile preferences saved.','success');
    }catch(error){$('#settingsMessage').textContent=error.message;$('#settingsMessage').classList.remove('success');}
  });
  $('#settingsLogoutButton')?.addEventListener('click',logout);
}

async function openNotifications() {
  const panel=$('#notificationPanel');
  const isOpen=!panel.classList.contains('hidden');
  if(isOpen){panel.classList.add('hidden');return;}
  panel.classList.remove('hidden');panel.innerHTML='<div class="loading-state" style="min-height:80px">Loading notifications…</div>';
  try{
    const payload=await request('/api/notifications');state.notifications=payload.notifications||[];
    $('#notificationDot')?.classList.toggle('hidden',!payload.unread);
    panel.innerHTML=`<h3>Notifications <span class="muted">(${payload.unread||0} unread)</span></h3>${state.notifications.length?state.notifications.map((n)=>`<div class="notification-row"><strong>${escapeHtml(n.title)}</strong><p>${escapeHtml(n.message)}</p><small>${formatTimestamp(n.created_at)} ${n.read_at?'· Read':''}</small>${!n.read_at?`<button type="button" class="text-button" data-read-notification="${escapeHtml(n.id)}">Mark read</button>`:''}</div>`).join(''):'<div class="table-empty">No notifications yet.</div>'}`;
    $$('[data-read-notification]',panel).forEach((button)=>button.addEventListener('click',async()=>{try{await request(`/api/notifications/${encodeURIComponent(button.dataset.readNotification)}/read`,{method:'POST',body:JSON.stringify({})});await openNotifications();await openNotifications();}catch(error){showToast(error.message,'error');}}));
  }catch(error){panel.innerHTML=`<div class="table-empty">${escapeHtml(error.message)}</div>`;}
}
async function logout() {
  try{await request('/api/auth/logout',{method:'POST',body:JSON.stringify({})});}catch{/* Client resets locally even if session has expired. */}
  state.user=null;state.portfolio=null;state.markets=[];state.marketData=null;state.watchlist=[];state.orders=[];state.trades=[];state.history=[];state.orderDraft={quantity:'',limitPrice:'',triggerPrice:''};
  $('#notificationPanel')?.classList.add('hidden');showAuthGate();switchAuthMode('login');showToast('Signed out of ALPHA TERMINAL.');
  void loadPublicPreview();
}
async function activateUser(user) {
  state.user=user;
  showAppShell();
  syncSharedNumbers();
  try{
    await Promise.all([loadMarkets(),loadPortfolio(),loadWatchlist(),loadPageData('dashboard'),request('/api/trades').then((p)=>state.trades=p.trades||[]),request('/api/orders').then((p)=>state.orders=p.orders||[])]);
  }catch(error){showToast(error.message,'error');}
  syncGlobalStatus();
  state.currentView='dashboard';
  $$('.nav-item[data-view]').forEach((button)=>button.classList.toggle('active',button.dataset.view==='dashboard'));
  $('#topbarTitle').textContent='Overview';
  renderView();
  void refreshCore();
}
async function loadPublicPreview() {
  try{
    const payload=await request('/api/markets');
    const markets=payload.markets||[];
    const elements=$$('#publicMarketPreview .preview-assets>div');
    const status=$('#publicMarketPreview .live-tag');
    const mode=payload.marketData?.mode||'UNAVAILABLE';
    if(status)status.innerHTML=`<i style="background:${mode==='LIVE'?'var(--green)':mode==='STALE'?'var(--amber)':'var(--red)'}"></i>${mode==='LIVE'?'LIVE DATA':mode==='STALE'?'STALE DATA':'NO DATA'}`;
    ['BTCUSDT','ETHUSDT','SOLUSDT'].forEach((symbol,index)=>{
      const market=markets.find((m)=>m.symbol===symbol);const element=elements[index];if(!market||!element)return;
      const value=element.querySelector('b');if(value)value.textContent=market.quote?`$${price(market.quote.last)}`:'—';
      const small=element.querySelector('small');if(small)small.textContent=`${symbolShort(symbol)} / USDT`;
    });
  }catch(error){console.warn('Public market preview unavailable:',error.message);}
}
function bindGlobalEvents() {
  $$('.auth-tab').forEach((button)=>button.addEventListener('click',()=>switchAuthMode(button.dataset.authMode)));
  $$('.capital-presets button').forEach((button)=>button.addEventListener('click',()=>selectedCapital(button.dataset.capital)));
  $('#customCapital')?.addEventListener('input',(event)=>{
    const value=event.target.value;
    if(value!==''){
      const hidden=$('#registerForm [name="startingCapital"]');if(hidden)hidden.value=value;
      state.startingCapital=value;$$('.capital-presets button').forEach((button)=>button.classList.remove('selected'));
      const label=$('#capitalLabel');if(label)label.textContent=compactMoney(value);
    }
  });
  $('#loginForm')?.addEventListener('submit',async(event)=>{
    event.preventDefault();const form=new FormData(event.currentTarget);const message=$('#loginMessage');message.textContent='Signing in…';message.classList.remove('success');
    try{
      const payload=await request('/api/auth/login',{method:'POST',body:JSON.stringify({email:form.get('email'),password:form.get('password')})});
      message.textContent='';await activateUser(payload.user);showToast(`Welcome back, ${payload.user.username}.`,'success');
    }catch(error){message.textContent=error.message;}
  });
  $('#registerForm')?.addEventListener('submit',async(event)=>{
    event.preventDefault();const form=new FormData(event.currentTarget);const message=$('#registerMessage');message.textContent='Creating your virtual account…';message.classList.remove('success');
    try{
      const payload=await request('/api/auth/register',{method:'POST',body:JSON.stringify({username:form.get('username'),email:form.get('email'),password:form.get('password'),startingCapital:form.get('startingCapital')})});
      message.textContent='Account created.';message.classList.add('success');await activateUser(payload.user);showToast('Virtual account created. No real money is involved.','success');
    }catch(error){message.textContent=error.message;message.classList.remove('success');}
  });
  document.addEventListener('click',(event)=>{
    const viewButton=event.target.closest('[data-view]');
    if(viewButton){event.preventDefault();setView(viewButton.dataset.view);return;}
    const exportButton=event.target.closest('[data-export-csv]');
    if(exportButton){void loadPageData('history').then(()=>request('/api/trades').then((p)=>{state.trades=p.trades||[];exportTradesCsv();})).catch((error)=>showToast(error.message,'error'));return;}
    if(event.target.closest('#downloadTradesButton')){exportTradesCsv();return;}
    if(!event.target.closest('#notificationPanel')&&!event.target.closest('#notificationsButton'))$('#notificationPanel')?.classList.add('hidden');
  });
  $('#logoutButton')?.addEventListener('click',logout);
  $('#notificationsButton')?.addEventListener('click',openNotifications);
  $('#profileChip')?.addEventListener('click',()=>setView('settings'));
  $('#globalSearch')?.addEventListener('keydown',(event)=>{
    if(event.key==='Enter'){
      state.marketSearch=event.target.value.trim();state.marketFilter='ALL';setView('markets');
    }
  });
  window.addEventListener('resize',()=>{
    if(state.currentView==='dashboard')drawPortfolioChart($('#portfolioChart'),state.history);
    if(state.currentView==='portfolio')postPortfolioRender();
    if(state.currentView==='terminal')drawCandles($('#candlestickCanvas'),state.candles);
  });
}
async function boot() {
  bindGlobalEvents();
  try{
    const payload=await request('/api/auth/me');
    if(payload.user){await activateUser(payload.user);}
    else{showAuthGate();void loadPublicPreview();}
  }catch(error){showAuthGate();void loadPublicPreview();console.warn('Initial session check failed:',error.message);}
  window.setInterval(()=>{if(state.user)void refreshCore({render:true});else void loadPublicPreview();},15_000);
  window.setInterval(()=>{syncSharedNumbers();syncGlobalStatus();},1_000);
}

boot();
