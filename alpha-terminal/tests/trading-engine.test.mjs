import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.mjs';
import { formatDecimal, parseDecimal, mul } from '../src/decimal.mjs';
import { TradingEngine } from '../src/trading-engine.mjs';

function setup(capital = '10000') {
  const db = createDatabase(':memory:');
  const userId = 'test-user';
  db.prepare('INSERT INTO users(id,email,username,password_hash,created_at) VALUES(?,?,?,?,?)')
    .run(userId, 'tester@example.test', 'tester', 'salt:hash', new Date().toISOString());
  const engine = new TradingEngine(db);
  const account = engine.createAccount(userId, capital);
  return { db, engine, accountId: account.id };
}
function setQuote(db, { last='100', bid='99.9', ask='100.1', receivedAt=Date.now() } = {}) {
  db.prepare(`INSERT INTO market_quotes(symbol,last_price,bid,ask,change_pct,abs_change,volume,quote_volume,source_timestamp,received_at,provider,data_mode)
    VALUES('BTCUSDT',?,?,?,?,?,?,?,?,?,'Test market data','LIVE')
    ON CONFLICT(symbol) DO UPDATE SET last_price=excluded.last_price,bid=excluded.bid,ask=excluded.ask,
    change_pct=excluded.change_pct,abs_change=excluded.abs_change,volume=excluded.volume,quote_volume=excluded.quote_volume,
    source_timestamp=excluded.source_timestamp,received_at=excluded.received_at,provider=excluded.provider,data_mode='LIVE'`)
    .run(last, bid, ask, '1.25', '1.25', '1000', '100000', receivedAt, receivedAt);
}
const order = (overrides = {}) => ({
  symbol: 'BTCUSDT', side: 'buy', orderType: 'market', quantity: '1', clientOrderId: `test-${Math.random().toString(16).slice(2)}`,
  ...overrides,
});

test('fixed-point decimal arithmetic avoids binary floating-point drift', () => {
  const a = parseDecimal('0.1');
  const b = parseDecimal('0.2');
  assert.equal(formatDecimal(a + b), '0.3');
  assert.equal(formatDecimal(mul(parseDecimal('100.1'), parseDecimal('1'))), '100.1');
  assert.equal(formatDecimal(parseDecimal('0.1') + parseDecimal('0.2')), '0.3');
});

test('market buy updates cash, position, fee ledger, and execution exactly once', () => {
  const { db, engine, accountId } = setup();
  setQuote(db);
  const request = order({ clientOrderId: 'idempotent-buy-1' });
  const first = engine.submitOrder(accountId, request);
  assert.equal(first.order.status, 'filled');
  const accountAfterFirst = db.prepare('SELECT * FROM trading_accounts WHERE id=?').get(accountId);
  const balanceAfterFirst = accountAfterFirst.available_cash;
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM executions WHERE account_id=?').get(accountId).count, 1);
  const duplicate = engine.submitOrder(accountId, request);
  assert.equal(duplicate.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM executions WHERE account_id=?').get(accountId).count, 1);
  assert.equal(db.prepare('SELECT available_cash FROM trading_accounts WHERE id=?').get(accountId).available_cash, balanceAfterFirst);
  const position = db.prepare('SELECT * FROM positions WHERE account_id=? AND symbol=\'BTCUSDT\'').get(accountId);
  assert.equal(position.quantity, '1');
  assert.equal(position.avg_entry_price, '100.1');
  assert.ok(Number(accountAfterFirst.available_cash) < 10000);
  assert.ok(Number(accountAfterFirst.fees_paid) > 0);
  const portfolio = engine.portfolio(accountId);
  assert.equal(portfolio.positions.length, 1);
  assert.ok(Number(portfolio.equity) < 10000);
  db.close();
});

test('partial sell computes realized P&L and preserves weighted average entry', () => {
  const { db, engine, accountId } = setup();
  setQuote(db);
  engine.submitOrder(accountId, order({ clientOrderId: 'partial-buy', quantity: '2' }));
  setQuote(db, { last: '110', bid: '109.9', ask: '110.1' });
  const result = engine.submitOrder(accountId, order({ side: 'sell', quantity: '0.5', clientOrderId: 'partial-sell' }));
  assert.equal(result.order.status, 'filled');
  const position = db.prepare('SELECT * FROM positions WHERE account_id=? AND symbol=\'BTCUSDT\'').get(accountId);
  assert.equal(position.quantity, '1.5');
  assert.equal(position.avg_entry_price, '100.1');
  assert.ok(Number(position.realized_pnl) > 0);
  assert.ok(Number(db.prepare('SELECT realized_pnl FROM trading_accounts WHERE id=?').get(accountId).realized_pnl) > 0);
  db.close();
});

test('limit buy reserves funds and cancellation restores available cash', () => {
  const { db, engine, accountId } = setup('1000');
  setQuote(db);
  const before = engine.portfolio(accountId);
  const result = engine.submitOrder(accountId, order({ orderType: 'limit', limitPrice: '80', quantity: '2', clientOrderId: 'limit-reserve' }));
  assert.equal(result.order.status, 'open');
  const afterReserve = engine.portfolio(accountId);
  assert.ok(Number(afterReserve.availableCash) < Number(before.availableCash));
  assert.ok(Number(afterReserve.reservedCash) > 0);
  const cancelled = engine.cancelOrder(accountId, result.order.id);
  assert.equal(cancelled.status, 'cancelled');
  const afterCancel = engine.portfolio(accountId);
  assert.equal(afterCancel.availableCash, before.availableCash);
  assert.equal(afterCancel.reservedCash, '0');
  db.close();
});

test('stop-market sell reserves owned quantity and triggers against a fresh bid', () => {
  const { db, engine, accountId } = setup();
  setQuote(db);
  engine.submitOrder(accountId, order({ clientOrderId: 'stop-entry' }));
  const stop = engine.submitOrder(accountId, order({ side: 'sell', orderType: 'stop_market', triggerPrice: '95', quantity: '0.4', clientOrderId: 'stop-loss-1' }));
  assert.equal(stop.order.status, 'open');
  const reserved = db.prepare('SELECT reserved_quantity FROM positions WHERE account_id=? AND symbol=\'BTCUSDT\'').get(accountId).reserved_quantity;
  assert.equal(reserved, '0.4');
  setQuote(db, { last: '94', bid: '93.9', ask: '94.1' });
  engine.processOpenOrders();
  const updated = db.prepare('SELECT * FROM orders WHERE id=?').get(stop.order.id);
  assert.equal(updated.status, 'filled');
  const position = db.prepare('SELECT * FROM positions WHERE account_id=? AND symbol=\'BTCUSDT\'').get(accountId);
  assert.equal(position.quantity, '0.6');
  assert.equal(position.reserved_quantity, '0');
  db.close();
});

test('market orders are rejected when stored quotes are stale', () => {
  const { db, engine, accountId } = setup();
  setQuote(db, { receivedAt: Date.now() - 90_000 });
  const result = engine.submitOrder(accountId, order({ clientOrderId: 'stale-market-1' }));
  assert.equal(result.order.status, 'rejected');
  assert.match(result.order.rejection_reason, /stale/i);
  assert.equal(engine.portfolio(accountId).availableCash, '10000');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM executions WHERE account_id=?').get(accountId).count, 0);
  db.close();
});

test('rejected market sell does not release quantity reserved by another open order', () => {
  const { db, engine, accountId } = setup();
  setQuote(db);
  engine.submitOrder(accountId, order({ clientOrderId: 'reserve-regression-buy', quantity: '1' }));
  const stop = engine.submitOrder(accountId, order({ side: 'sell', orderType: 'stop_market', triggerPrice: '90', quantity: '0.8', clientOrderId: 'reserve-regression-stop' }));
  assert.equal(stop.order.status, 'open');

  const rejected = engine.submitOrder(accountId, order({ side: 'sell', quantity: '0.3', clientOrderId: 'reserve-regression-too-much' }));
  assert.equal(rejected.order.status, 'rejected');
  let position = db.prepare("SELECT * FROM positions WHERE account_id=? AND symbol='BTCUSDT'").get(accountId);
  assert.equal(position.quantity, '1');
  assert.equal(position.reserved_quantity, '0.8');

  const cancelled = engine.cancelOrder(accountId, stop.order.id);
  assert.equal(cancelled.status, 'cancelled');
  position = db.prepare("SELECT * FROM positions WHERE account_id=? AND symbol='BTCUSDT'").get(accountId);
  assert.equal(position.reserved_quantity, '0');
  db.close();
});
