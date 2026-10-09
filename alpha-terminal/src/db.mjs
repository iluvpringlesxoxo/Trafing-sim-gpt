import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const INSTRUMENTS = [
  ['BTCUSDT', 'Bitcoin', 'BTC', 'USDT'],
  ['ETHUSDT', 'Ethereum', 'ETH', 'USDT'],
  ['SOLUSDT', 'Solana', 'SOL', 'USDT'],
  ['XRPUSDT', 'XRP', 'XRP', 'USDT'],
  ['BNBUSDT', 'BNB', 'BNB', 'USDT'],
  ['DOGEUSDT', 'Dogecoin', 'DOGE', 'USDT'],
  ['ADAUSDT', 'Cardano', 'ADA', 'USDT'],
  ['AVAXUSDT', 'Avalanche', 'AVAX', 'USDT'],
  ['LINKUSDT', 'Chainlink', 'LINK', 'USDT'],
  ['LTCUSDT', 'Litecoin', 'LTC', 'USDT'],
  ['DOTUSDT', 'Polkadot', 'DOT', 'USDT'],
  ['TRXUSDT', 'TRON', 'TRX', 'USDT'],
];

export function createDatabase(databasePath = process.env.DB_PATH || './data/alpha-terminal.sqlite') {
  const absolutePath = databasePath === ':memory:' ? ':memory:' : resolve(databasePath);
  if (absolutePath !== ':memory:') mkdirSync(dirname(absolutePath), { recursive: true });
  const db = new DatabaseSync(absolutePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      avatar_url TEXT,
      account_status TEXT NOT NULL DEFAULT 'active',
      leaderboard_public INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS trading_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      base_currency TEXT NOT NULL DEFAULT 'USD',
      initial_capital TEXT NOT NULL,
      available_cash TEXT NOT NULL,
      reserved_cash TEXT NOT NULL DEFAULT '0',
      realized_pnl TEXT NOT NULL DEFAULT '0',
      fees_paid TEXT NOT NULL DEFAULT '0',
      created_at TEXT NOT NULL,
      account_status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS instruments (
      symbol TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      asset_class TEXT NOT NULL,
      instrument_type TEXT NOT NULL,
      base_asset TEXT NOT NULL,
      quote_asset TEXT NOT NULL,
      trading_enabled INTEGER NOT NULL DEFAULT 1,
      provider TEXT NOT NULL DEFAULT 'Binance public market data'
    );
    CREATE TABLE IF NOT EXISTS market_quotes (
      symbol TEXT PRIMARY KEY REFERENCES instruments(symbol),
      last_price TEXT NOT NULL,
      bid TEXT,
      ask TEXT,
      change_pct TEXT,
      abs_change TEXT,
      volume TEXT,
      quote_volume TEXT,
      source_timestamp INTEGER,
      received_at INTEGER NOT NULL,
      provider TEXT NOT NULL,
      data_mode TEXT NOT NULL DEFAULT 'LIVE'
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES trading_accounts(id),
      symbol TEXT NOT NULL REFERENCES instruments(symbol),
      side TEXT NOT NULL CHECK(side IN ('buy','sell')),
      order_type TEXT NOT NULL CHECK(order_type IN ('market','limit','stop_market','take_profit')),
      quantity TEXT NOT NULL,
      limit_price TEXT,
      trigger_price TEXT,
      status TEXT NOT NULL,
      reserved_amount TEXT NOT NULL DEFAULT '0',
      client_order_id TEXT NOT NULL,
      rejection_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(account_id, client_order_id)
    );
    CREATE INDEX IF NOT EXISTS orders_account_status_idx ON orders(account_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS orders_monitor_idx ON orders(status, symbol);
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      account_id TEXT NOT NULL REFERENCES trading_accounts(id),
      symbol TEXT NOT NULL REFERENCES instruments(symbol),
      side TEXT NOT NULL,
      quantity TEXT NOT NULL,
      execution_price TEXT NOT NULL,
      fee TEXT NOT NULL,
      realized_pnl TEXT NOT NULL DEFAULT '0',
      created_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS executions_account_idx ON executions(account_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES trading_accounts(id),
      symbol TEXT NOT NULL REFERENCES instruments(symbol),
      quantity TEXT NOT NULL DEFAULT '0',
      avg_entry_price TEXT NOT NULL DEFAULT '0',
      reserved_quantity TEXT NOT NULL DEFAULT '0',
      realized_pnl TEXT NOT NULL DEFAULT '0',
      updated_at TEXT NOT NULL,
      UNIQUE(account_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES trading_accounts(id),
      entry_type TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      reference_type TEXT,
      reference_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_account_idx ON ledger_entries(account_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES trading_accounts(id),
      equity TEXT NOT NULL,
      available_cash TEXT NOT NULL,
      reserved_cash TEXT NOT NULL,
      spot_value TEXT NOT NULL,
      realized_pnl TEXT NOT NULL,
      unrealized_pnl TEXT NOT NULL,
      snapshot_timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS snapshots_account_time_idx ON portfolio_snapshots(account_id, snapshot_timestamp DESC);
    CREATE TABLE IF NOT EXISTS watchlist_items (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL REFERENCES instruments(symbol),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(account_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notifications_account_idx ON notifications(account_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      account_id TEXT REFERENCES trading_accounts(id),
      event_type TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);

  const insertInstrument = db.prepare(`INSERT INTO instruments
    (symbol,name,asset_class,instrument_type,base_asset,quote_asset,trading_enabled,provider)
    VALUES (?,?, 'CRYPTO','SPOT',?,?,1,'Binance public market data')
    ON CONFLICT(symbol) DO UPDATE SET name=excluded.name, base_asset=excluded.base_asset, quote_asset=excluded.quote_asset`);
  for (const [symbol, name, base, quote] of INSTRUMENTS) insertInstrument.run(symbol, name, base, quote);
  return db;
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already have ended */ }
    throw error;
  }
}

export function recordAudit(db, { userId = null, accountId = null, eventType, details = {} }) {
  db.prepare(`INSERT INTO audit_log(id,user_id,account_id,event_type,details,created_at) VALUES(?,?,?,?,?,?)`)
    .run(randomUUID(), userId, accountId, eventType, JSON.stringify(details), new Date().toISOString());
}

export function addNotification(db, accountId, type, title, message) {
  db.prepare(`INSERT INTO notifications(id,account_id,notification_type,title,message,created_at) VALUES(?,?,?,?,?,?)`)
    .run(randomUUID(), accountId, type, title, message, new Date().toISOString());
}
