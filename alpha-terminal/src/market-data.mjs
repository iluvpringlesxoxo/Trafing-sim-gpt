import { formatDecimal, parseDecimal } from './decimal.mjs';

const PUBLIC_API = 'https://data-api.binance.vision';
const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','LTCUSDT','DOTUSDT','TRXUSDT'];
const CANDLE_INTERVALS = new Set(['1m','5m','15m','1h','4h','1d','1w','1M']);

function providerDecimal(value) {
  const raw = String(value ?? '0');
  const m = raw.match(/^(-?\d+)(?:\.(\d+))?$/);
  if (!m) return '0';
  return formatDecimal(parseDecimal(`${m[1]}.${(m[2] || '').slice(0, 8) || '0'}`, { allowNegative: true }));
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'AlphaTerminal-Simulator/1.0' }, signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error(`Market provider returned HTTP ${response.status}`);
  return response.json();
}

export class BinanceMarketData {
  constructor(db) {
    this.db = db;
    this.lastSuccess = null;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.lastRefreshStarted = null;
    this.refreshInFlight = null;
    this.onQuotesUpdated = null;
  }

  symbolsQuery() { return encodeURIComponent(JSON.stringify(SYMBOLS)); }

  async refresh() {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.#refreshInternal();
    try { return await this.refreshInFlight; }
    finally { this.refreshInFlight = null; }
  }

  async #refreshInternal() {
    this.lastRefreshStarted = Date.now();
    try {
      const [stats, books] = await Promise.all([
        fetchJson(`${PUBLIC_API}/api/v3/ticker/24hr?symbols=${this.symbolsQuery()}`),
        fetchJson(`${PUBLIC_API}/api/v3/ticker/bookTicker?symbols=${this.symbolsQuery()}`),
      ]);
      if (!Array.isArray(stats) || !Array.isArray(books)) throw new Error('Unexpected market-data response format');
      const bookMap = new Map(books.map((item) => [item.symbol, item]));
      const now = Date.now();
      const upsert = this.db.prepare(`INSERT INTO market_quotes
        (symbol,last_price,bid,ask,change_pct,abs_change,volume,quote_volume,source_timestamp,received_at,provider,data_mode)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'LIVE')
        ON CONFLICT(symbol) DO UPDATE SET last_price=excluded.last_price,bid=excluded.bid,ask=excluded.ask,
          change_pct=excluded.change_pct,abs_change=excluded.abs_change,volume=excluded.volume,
          quote_volume=excluded.quote_volume,source_timestamp=excluded.source_timestamp,
          received_at=excluded.received_at,provider=excluded.provider,data_mode='LIVE'`);
      let accepted = 0;
      for (const item of stats) {
        if (!SYMBOLS.includes(item.symbol)) continue;
        const book = bookMap.get(item.symbol);
        const last = providerDecimal(item.lastPrice);
        const bid = book ? providerDecimal(book.bidPrice) : null;
        const ask = book ? providerDecimal(book.askPrice) : null;
        if (parseDecimal(last) <= 0n) continue;
        upsert.run(item.symbol, last, bid, ask, providerDecimal(item.priceChangePercent), providerDecimal(item.priceChange),
          providerDecimal(item.volume), providerDecimal(item.quoteVolume), Number(item.closeTime) || now, now,
          'Binance public market data');
        accepted += 1;
      }
      if (accepted === 0) throw new Error('The provider returned no supported quotes');
      this.lastSuccess = now;
      this.lastError = null;
      this.consecutiveFailures = 0;
      if (this.onQuotesUpdated) await this.onQuotesUpdated();
      return { ok: true, accepted, timestamp: now };
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError = error.message || 'Market-data request failed';
      return { ok: false, accepted: 0, error: this.lastError };
    }
  }

  status() {
    const now = Date.now();
    const latest = this.db.prepare('SELECT MAX(received_at) AS latest FROM market_quotes').get()?.latest ?? null;
    const ageSeconds = latest ? Math.max(0, Math.floor((now - Number(latest)) / 1000)) : null;
    let mode = 'UNAVAILABLE';
    if (ageSeconds !== null && ageSeconds <= 35) mode = 'LIVE';
    else if (ageSeconds !== null) mode = 'STALE';
    return {
      provider: 'Binance public market-data API',
      mode,
      ageSeconds,
      lastSuccessfulUpdate: this.lastSuccess ? new Date(this.lastSuccess).toISOString() : (latest ? new Date(Number(latest)).toISOString() : null),
      lastError: this.lastError,
      supportedSymbols: SYMBOLS.length,
      pollingIntervalSeconds: 15,
      explanation: mode === 'LIVE' ? 'Public crypto quotes updated recently.' : mode === 'STALE' ? 'Last-known quotes are stale. New market orders are disabled for safety.' : 'Waiting for a successful provider response. No prices are being fabricated.',
    };
  }

  async getCandles(symbol, interval = '1h', requestedLimit = 120) {
    const safeSymbol = String(symbol || '').toUpperCase();
    if (!SYMBOLS.includes(safeSymbol)) throw new Error('Unsupported instrument');
    if (!CANDLE_INTERVALS.has(interval)) throw new Error('Unsupported candle interval');
    const limit = Math.max(20, Math.min(500, Number.parseInt(requestedLimit, 10) || 120));
    const url = `${PUBLIC_API}/api/v3/klines?symbol=${encodeURIComponent(safeSymbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    const data = await fetchJson(url);
    if (!Array.isArray(data)) throw new Error('Unexpected candle response format');
    return data.map((c) => ({ time: Math.floor(Number(c[0]) / 1000), open: providerDecimal(c[1]), high: providerDecimal(c[2]), low: providerDecimal(c[3]), close: providerDecimal(c[4]), volume: providerDecimal(c[5]), closeTime: Number(c[6]) }));
  }

  async getMarketStatus() { return this.status(); }
}

export { SYMBOLS as SUPPORTED_MARKET_SYMBOLS, PUBLIC_API as BINANCE_PUBLIC_API };
