import http from 'node:http';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, recordAudit } from './db.mjs';
import { formatDecimal, parseDecimal } from './decimal.mjs';
import { BinanceMarketData } from './market-data.mjs';
import { TradingEngine, TRADING_RULES } from './trading-engine.mjs';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_DIR = resolve(HERE, '../public');
const PORT = Number(process.env.PORT || 4173);
const SESSION_MAX_AGE = 14 * 24 * 60 * 60;
const MAX_BODY_BYTES = 32 * 1024;
const COOKIE_NAME = 'alpha_session';
const db = createDatabase(process.env.DB_PATH || resolve(HERE, '../data/alpha-terminal.sqlite'));
const marketData = new BinanceMarketData(db);
const engine = new TradingEngine(db);
const rateLimits = new Map();

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, keyHex] = String(stored).split(':');
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(keyHex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}
function safeUser(user) {
  return { id: user.id, email: user.email, username: user.username, avatarUrl: user.avatar_url, createdAt: user.created_at, leaderboardPublic: Boolean(user.leaderboard_public) };
}
function getCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const index = cookie.indexOf('=');
    if (index > 0 && cookie.slice(0, index).trim() === name) return decodeURIComponent(cookie.slice(index + 1).trim());
  }
  return null;
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}${secure}`);
}
function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}
function getCurrentSession(req) {
  const token = getCookie(req, COOKIE_NAME);
  if (!token) return null;
  const hash = sha256(token);
  const row = db.prepare(`SELECT s.expires_at,u.*,a.id AS account_id,a.account_status AS trading_status
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN trading_accounts a ON a.user_id=u.id WHERE s.token_hash=?`).get(hash);
  if (!row || Number(row.expires_at) < Date.now() || row.account_status !== 'active' || row.trading_status !== 'active') {
    if (row) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
    return null;
  }
  return { tokenHash: hash, user: row, accountId: row.account_id };
}
function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    ...headers,
  });
  res.end(body);
}
function sendError(res, status, message, code = 'REQUEST_FAILED') {
  return sendJson(res, status, { error: { code, message } });
}
async function readJson(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 }); }
}
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Native same-origin form submissions may omit Origin.
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}
function rateLimit(req, res, key, limit = 15, windowMs = 60_000) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const id = `${ip}:${key}`;
  const now = Date.now();
  const current = rateLimits.get(id);
  if (!current || current.resetAt <= now) {
    rateLimits.set(id, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  if (current.count <= limit) return true;
  res.setHeader('retry-after', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
  sendError(res, 429, 'Too many requests. Try again later.', 'RATE_LIMITED');
  return false;
}
function requireSession(session, res) {
  if (session) return true;
  sendError(res, 401, 'Please log in to access this resource.', 'AUTH_REQUIRED');
  return false;
}
function requireAccountOwner(session, accountId, res) {
  if (session && session.accountId === accountId) return true;
  sendError(res, 403, 'You do not have access to this account.', 'FORBIDDEN');
  return false;
}
function parseStartingCapital(raw) {
  let capital;
  try { capital = parseDecimal(String(raw)); }
  catch { throw Object.assign(new Error('Starting capital must be a valid number with up to 8 decimal places.'), { status: 400 }); }
  const min = parseDecimal('100');
  const max = parseDecimal('1000000');
  if (capital < min || capital > max) throw Object.assign(new Error('Starting capital must be between $100 and $1,000,000.'), { status: 400 });
  return formatDecimal(capital);
}
function publicQuote(row) {
  if (!row) return null;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Number(row.received_at)) / 1000));
  return {
    last: row.last_price, bid: row.bid, ask: row.ask,
    changePct: row.change_pct, absoluteChange: row.abs_change,
    volume: row.volume, quoteVolume: row.quote_volume,
    sourceTimestamp: row.source_timestamp ? new Date(Number(row.source_timestamp)).toISOString() : null,
    receivedAt: new Date(Number(row.received_at)).toISOString(), ageSeconds,
    dataMode: ageSeconds <= 35 && row.data_mode === 'LIVE' ? 'LIVE' : 'STALE', provider: row.provider,
  };
}
function publicMarketRows() {
  const rows = db.prepare(`SELECT i.*,q.last_price,q.bid,q.ask,q.change_pct,q.abs_change,q.volume,q.quote_volume,q.source_timestamp,
    q.received_at,q.provider AS quote_provider,q.data_mode FROM instruments i LEFT JOIN market_quotes q ON i.symbol=q.symbol ORDER BY i.symbol`).all();
  return rows.map((row) => ({
    symbol: row.symbol, name: row.name, assetClass: row.asset_class, instrumentType: row.instrument_type,
    baseAsset: row.base_asset, quoteAsset: row.quote_asset, tradingEnabled: Boolean(row.trading_enabled),
    dataProvider: row.quote_provider || row.provider, quote: publicQuote(row.received_at ? { ...row, provider: row.quote_provider } : null),
  }));
}
function sendStatic(res, content, type) {
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  });
  res.end(content);
}

async function api(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';
  const session = getCurrentSession(req);

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { status: 'ok', application: 'ALPHA TERMINAL', marketData: marketData.status(), database: 'connected', trading: 'virtual funds only' });
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    if (!rateLimit(req, res, 'register', 8)) return;
    if (!checkOrigin(req)) return sendError(res, 403, 'Cross-origin registration requests are not allowed.', 'BAD_ORIGIN');
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const startingCapital = parseStartingCapital(body.startingCapital ?? '10000');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return sendError(res, 400, 'Enter a valid email address.', 'VALIDATION_ERROR');
    if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return sendError(res, 400, 'Username must be 3–20 characters and use letters, numbers, underscores, or hyphens.', 'VALIDATION_ERROR');
    if (password.length < 8 || password.length > 128) return sendError(res, 400, 'Password must be between 8 and 128 characters.', 'VALIDATION_ERROR');
    if (db.prepare('SELECT 1 FROM users WHERE email=? OR username=?').get(email, username)) return sendError(res, 409, 'That email or username is already registered.', 'ACCOUNT_EXISTS');
    const userId = randomUUID();
    try {
      db.prepare(`INSERT INTO users(id,email,username,password_hash,created_at) VALUES(?,?,?,?,?)`)
        .run(userId, email, username, passwordHash(password), new Date().toISOString());
      let account;
      try { account = engine.createAccount(userId, startingCapital); }
      catch (error) { db.prepare('DELETE FROM users WHERE id=?').run(userId); throw error; }
      const token = randomBytes(32).toString('base64url');
      const tokenHash = sha256(token);
      db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
        .run(tokenHash, userId, Date.now() + SESSION_MAX_AGE * 1000, new Date().toISOString());
      recordAudit(db, { userId, accountId: account.id, eventType: 'user_registered', details: { username } });
      setSessionCookie(res, token);
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
      return sendJson(res, 201, { user: safeUser(user), portfolio: engine.portfolio(account.id) });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, 409, 'That email or username is already registered.', 'ACCOUNT_EXISTS');
      throw error;
    }
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    if (!rateLimit(req, res, 'login', 12)) return;
    if (!checkOrigin(req)) return sendError(res, 403, 'Cross-origin login requests are not allowed.', 'BAD_ORIGIN');
    const body = await readJson(req);
    const login = String(body.email || body.login || '').trim();
    const password = String(body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email=? OR username=?').get(login, login);
    const okay = user && verifyPassword(password, user.password_hash);
    if (!okay || user.account_status !== 'active') return sendError(res, 401, 'Invalid login credentials.', 'INVALID_CREDENTIALS');
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
      .run(sha256(token), user.id, Date.now() + SESSION_MAX_AGE * 1000, new Date().toISOString());
    recordAudit(db, { userId: user.id, eventType: 'user_login' });
    setSessionCookie(res, token);
    const account = db.prepare('SELECT id FROM trading_accounts WHERE user_id=?').get(user.id);
    return sendJson(res, 200, { user: safeUser(user), portfolio: engine.portfolio(account.id) });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    if (!checkOrigin(req)) return sendError(res, 403, 'Cross-origin logout requests are not allowed.', 'BAD_ORIGIN');
    if (session) {
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.tokenHash);
      recordAudit(db, { userId: session.user.id, accountId: session.accountId, eventType: 'user_logout' });
    }
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    if (!session) return sendJson(res, 200, { user: null });
    return sendJson(res, 200, { user: safeUser(session.user), portfolio: engine.portfolio(session.accountId) });
  }

  if (pathname === '/api/markets' && method === 'GET') {
    return sendJson(res, 200, { markets: publicMarketRows(), marketData: marketData.status(), tradingRules: TRADING_RULES });
  }

  const candleMatch = pathname.match(/^\/api\/markets\/([A-Z0-9]+)\/candles$/i);
  if (candleMatch && method === 'GET') {
    try {
      const candles = await marketData.getCandles(candleMatch[1], url.searchParams.get('interval') || '1h', url.searchParams.get('limit') || '120');
      return sendJson(res, 200, { symbol: candleMatch[1].toUpperCase(), interval: url.searchParams.get('interval') || '1h', candles, provider: 'Binance public market data', dataMode: 'LIVE_HISTORICAL' });
    } catch (error) {
      return sendError(res, 503, `Historical candles are currently unavailable: ${error.message}`, 'MARKET_DATA_UNAVAILABLE');
    }
  }
  const marketMatch = pathname.match(/^\/api\/markets\/([A-Z0-9]+)$/i);
  if (marketMatch && method === 'GET') {
    const item = publicMarketRows().find((row) => row.symbol === marketMatch[1].toUpperCase());
    if (!item) return sendError(res, 404, 'Instrument not found.', 'NOT_FOUND');
    return sendJson(res, 200, { market: item, marketData: marketData.status() });
  }

  if (pathname === '/api/portfolio' && method === 'GET') {
    if (!requireSession(session, res)) return;
    return sendJson(res, 200, { portfolio: engine.portfolio(session.accountId) });
  }
  if (pathname === '/api/portfolio/history' && method === 'GET') {
    if (!requireSession(session, res)) return;
    const limit = Math.max(10, Math.min(500, Number.parseInt(url.searchParams.get('limit') || '100', 10)));
    const snapshots = db.prepare(`SELECT equity,available_cash,reserved_cash,spot_value,realized_pnl,unrealized_pnl,snapshot_timestamp
      FROM portfolio_snapshots WHERE account_id=? ORDER BY snapshot_timestamp DESC LIMIT ?`).all(session.accountId, limit).reverse();
    return sendJson(res, 200, { snapshots });
  }

  if (pathname === '/api/orders' && method === 'GET') {
    if (!requireSession(session, res)) return;
    const status = url.searchParams.get('status');
    const rows = status
      ? db.prepare('SELECT * FROM orders WHERE account_id=? AND status=? ORDER BY created_at DESC LIMIT 250').all(session.accountId, status)
      : db.prepare('SELECT * FROM orders WHERE account_id=? ORDER BY created_at DESC LIMIT 250').all(session.accountId);
    return sendJson(res, 200, { orders: rows });
  }
  if (pathname === '/api/orders' && method === 'POST') {
    if (!requireSession(session, res)) return;
    if (!checkOrigin(req)) return sendError(res, 403, 'Cross-origin order requests are not allowed.', 'BAD_ORIGIN');
    const body = await readJson(req);
    const result = engine.submitOrder(session.accountId, {
      symbol: body.symbol, side: body.side, orderType: body.orderType, quantity: body.quantity,
      limitPrice: body.limitPrice, triggerPrice: body.triggerPrice,
      clientOrderId: body.clientOrderId,
    });
    return sendJson(res, result.order.status === 'rejected' ? 422 : 201, result);
  }
  const cancelMatch = pathname.match(/^\/api\/orders\/([a-f0-9-]+)(?:\/cancel)?$/i);
  if (cancelMatch && (method === 'DELETE' || method === 'POST')) {
    if (!requireSession(session, res)) return;
    if (!checkOrigin(req)) return sendError(res, 403, 'Cross-origin order requests are not allowed.', 'BAD_ORIGIN');
    const order = engine.cancelOrder(session.accountId, cancelMatch[1]);
    return sendJson(res, 200, { order });
  }

  if (pathname === '/api/trades' && method === 'GET') {
    if (!requireSession(session, res)) return;
    const limit = Math.max(10, Math.min(500, Number.parseInt(url.searchParams.get('limit') || '100', 10)));
    const trades = db.prepare(`SELECT e.*,o.order_type,i.name FROM executions e JOIN orders o ON o.id=e.order_id
      JOIN instruments i ON i.symbol=e.symbol WHERE e.account_id=? ORDER BY e.created_at DESC LIMIT ?`).all(session.accountId, limit);
    return sendJson(res, 200, { trades });
  }

  if (pathname === '/api/watchlist' && method === 'GET') {
    if (!requireSession(session, res)) return;
    const items = db.prepare(`SELECT w.symbol,w.sort_order,i.name,q.last_price,q.change_pct,q.abs_change,q.received_at,q.provider,q.data_mode
      FROM watchlist_items w JOIN instruments i ON i.symbol=w.symbol LEFT JOIN market_quotes q ON q.symbol=w.symbol
      WHERE w.account_id=? ORDER BY w.sort_order,w.created_at`).all(session.accountId);
    return sendJson(res, 200, { watchlist: items.map((item) => ({ ...item, quote: item.received_at ? publicQuote({ ...item, provider: item.provider }) : null })) });
  }
  if (pathname === '/api/watchlist' && (method === 'POST' || method === 'DELETE')) {
    if (!requireSession(session, res)) return;
    if (!checkOrigin(req)) return sendError(res, 403, 'Cross-origin watchlist requests are not allowed.', 'BAD_ORIGIN');
    if (method === 'POST') {
      const body = await readJson(req);
      const symbol = String(body.symbol || '').toUpperCase();
      if (!db.prepare('SELECT 1 FROM instruments WHERE symbol=?').get(symbol)) return sendError(res, 400, 'Unknown instrument.', 'VALIDATION_ERROR');
      try {
        const count = db.prepare('SELECT COUNT(*) AS count FROM watchlist_items WHERE account_id=?').get(session.accountId).count;
        db.prepare('INSERT INTO watchlist_items(id,account_id,symbol,sort_order,created_at) VALUES(?,?,?,?,?)')
          .run(randomUUID(), session.accountId, symbol, Number(count), new Date().toISOString());
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, 409, 'That instrument is already in your watchlist.', 'ALREADY_WATCHLISTED');
        throw error;
      }
    } else {
      const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
      db.prepare('DELETE FROM watchlist_items WHERE account_id=? AND symbol=?').run(session.accountId, symbol);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/notifications' && method === 'GET') {
    if (!requireSession(session, res)) return;
    const notifications = db.prepare('SELECT * FROM notifications WHERE account_id=? ORDER BY created_at DESC LIMIT 50').all(session.accountId);
    return sendJson(res, 200, { notifications, unread: notifications.filter((item) => !item.read_at).length });
  }
  const notificationMatch = pathname.match(/^\/api\/notifications\/([a-f0-9-]+)\/read$/i);
  if (notificationMatch && method === 'POST') {
    if (!requireSession(session, res)) return;
    db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND account_id=?').run(new Date().toISOString(), notificationMatch[1], session.accountId);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/leaderboard' && method === 'GET') {
    const rows = db.prepare(`SELECT a.id AS account_id,a.initial_capital,u.username,u.avatar_url,u.created_at
      FROM trading_accounts a JOIN users u ON u.id=a.user_id WHERE a.account_status='active' AND u.leaderboard_public=1`).all();
    const entries = rows.map((row) => {
      const stats = engine.portfolio(row.account_id);
      return { username: row.username, avatarUrl: row.avatar_url, returnPct: stats.returnPct, profit: stats.totalReturn, trades: stats.completedTrades, realizedPnl: stats.realizedPnl };
    }).sort((a, b) => {
      const left = parseDecimal(a.returnPct, { allowNegative: true });
      const right = parseDecimal(b.returnPct, { allowNegative: true });
      return left > right ? -1 : left < right ? 1 : a.username.localeCompare(b.username);
    }).slice(0, 100).map((entry, index) => ({ rank: index + 1, ...entry }));
    return sendJson(res, 200, { leaderboard: entries, methodology: 'Return = (current simulated equity − initial virtual capital) / initial virtual capital. External funding and account resets are not supported in this release.' });
  }

  const profileMatch = pathname.match(/^\/api\/users\/([a-zA-Z0-9_-]+)\/public-profile$/);
  if (profileMatch && method === 'GET') {
    const user = db.prepare('SELECT id,username,avatar_url,created_at,leaderboard_public FROM users WHERE username=?').get(profileMatch[1]);
    if (!user || !user.leaderboard_public) return sendError(res, 404, 'Public profile not found.', 'NOT_FOUND');
    const account = db.prepare('SELECT id FROM trading_accounts WHERE user_id=?').get(user.id);
    const stats = engine.portfolio(account.id);
    return sendJson(res, 200, { profile: { username: user.username, avatarUrl: user.avatar_url, joinedAt: user.created_at, returnPct: stats.returnPct, realizedPnl: stats.realizedPnl, completedTrades: stats.completedTrades } });
  }

  if (pathname === '/api/user/profile' && method === 'GET') {
    if (!requireSession(session, res)) return;
    return sendJson(res, 200, { user: safeUser(session.user) });
  }
  if (pathname === '/api/user/profile' && method === 'PATCH') {
    if (!requireSession(session, res)) return;
    if (!checkOrigin(req)) return sendError(res, 403, 'Cross-origin profile requests are not allowed.', 'BAD_ORIGIN');
    const body = await readJson(req);
    const username = body.username === undefined ? session.user.username : String(body.username).trim();
    const avatarUrl = body.avatarUrl === undefined ? session.user.avatar_url : (body.avatarUrl === null ? null : String(body.avatarUrl).trim());
    const publicStats = body.leaderboardPublic === undefined ? Number(session.user.leaderboard_public) : (body.leaderboardPublic ? 1 : 0);
    if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return sendError(res, 400, 'Username must be 3–20 characters and use letters, numbers, underscores, or hyphens.', 'VALIDATION_ERROR');
    if (avatarUrl && (avatarUrl.length > 500 || !/^https:\/\//i.test(avatarUrl))) return sendError(res, 400, 'Avatar URL must be an HTTPS URL or empty.', 'VALIDATION_ERROR');
    try {
      db.prepare('UPDATE users SET username=?,avatar_url=?,leaderboard_public=? WHERE id=?').run(username, avatarUrl || null, publicStats, session.user.id);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, 409, 'That username is already taken.', 'USERNAME_TAKEN');
      throw error;
    }
    recordAudit(db, { userId: session.user.id, accountId: session.accountId, eventType: 'profile_updated' });
    return sendJson(res, 200, { user: safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(session.user.id)) });
  }

  return sendError(res, 404, 'API route not found.', 'NOT_FOUND');
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const decoded = decodeURIComponent(requested);
    const filePath = resolve(PUBLIC_DIR, `.${decoded}`);
    if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== resolve(PUBLIC_DIR, 'index.html')) return sendError(res, 403, 'Forbidden.', 'FORBIDDEN');
    const ext = extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
    const content = await readFile(filePath);
    return sendStatic(res, content, types[ext] || 'application/octet-stream');
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}:`, error.stack || error.message);
    if (res.headersSent) return res.end();
    return sendError(res, status, status >= 500 ? 'An unexpected server error occurred.' : error.message, status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR');
  }
}

marketData.onQuotesUpdated = async () => { engine.processOpenOrders(); };
const server = http.createServer((req, res) => { void handle(req, res); });
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ALPHA TERMINAL running at http://localhost:${PORT}`);
  console.log(`Database: ${process.env.DB_PATH || resolve(HERE, '../data/alpha-terminal.sqlite')}`);
  console.log('Virtual funds only. No brokerage execution endpoints exist.');
});

async function marketLoop() {
  const result = await marketData.refresh();
  if (!result.ok) console.warn(`Market data unavailable: ${result.error}`);
  const failures = marketData.consecutiveFailures;
  const delay = result.ok ? 15_000 : Math.min(120_000, 15_000 * (2 ** Math.min(failures, 3)));
  const timer = setTimeout(() => { void marketLoop(); }, delay);
  timer.unref();
}
void marketLoop();
const snapshotTimer = setInterval(() => engine.snapshotAllAccounts(), 5 * 60_000);
snapshotTimer.unref();
const cleanupTimer = setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  for (const [key, state] of rateLimits) if (state.resetAt < Date.now() - 60_000) rateLimits.delete(key);
}, 60 * 60_000);
cleanupTimer.unref();

process.on('SIGINT', () => { server.close(() => { db.close(); process.exit(0); }); });
process.on('SIGTERM', () => { server.close(() => { db.close(); process.exit(0); }); });
