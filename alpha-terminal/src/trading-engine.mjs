import { randomUUID } from 'node:crypto';
import { addNotification, recordAudit, transaction } from './db.mjs';
import { abs, add, div, formatDecimal, mul, parseDecimal, percentChange, sub } from './decimal.mjs';

const FEE_RATE = parseDecimal('0.001'); // 0.10% per fill, configurable in this module.
const QUOTE_MAX_AGE_MS = 35_000;
const ZERO = 0n;
const nowIso = () => new Date().toISOString();
const units = (value) => parseDecimal(String(value ?? '0'), { allowNegative: true });
const str = (value) => formatDecimal(value);
const feeFor = (notional) => mul(notional, FEE_RATE);
const freshQuote = (quote) => quote && (Date.now() - Number(quote.received_at)) <= QUOTE_MAX_AGE_MS && quote.data_mode === 'LIVE';

function writeLedger(db, accountId, entryType, amount, referenceType, referenceId, metadata = {}) {
  db.prepare(`INSERT INTO ledger_entries(id,account_id,entry_type,amount,currency,reference_type,reference_id,metadata,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), accountId, entryType, str(amount), 'USD', referenceType, referenceId, JSON.stringify(metadata), nowIso());
}

function getQuote(db, symbol) {
  return db.prepare('SELECT * FROM market_quotes WHERE symbol=?').get(symbol) ?? null;
}

function recordSnapshot(db, accountId) {
  const account = db.prepare('SELECT * FROM trading_accounts WHERE id=?').get(accountId);
  if (!account) return;
  let spotValue = ZERO;
  let unrealized = ZERO;
  const positions = db.prepare(`SELECT * FROM positions WHERE account_id=? AND CAST(quantity AS REAL)>0`).all(accountId);
  for (const position of positions) {
    const quote = getQuote(db, position.symbol);
    if (!quote || !quote.last_price) continue;
    const quantity = units(position.quantity);
    const price = units(quote.last_price);
    spotValue = add(spotValue, mul(quantity, price));
    unrealized = add(unrealized, mul(quantity, sub(price, units(position.avg_entry_price))));
  }
  const available = units(account.available_cash);
  const reserved = units(account.reserved_cash);
  const equity = add(add(available, reserved), spotValue);
  db.prepare(`INSERT INTO portfolio_snapshots(id,account_id,equity,available_cash,reserved_cash,spot_value,realized_pnl,unrealized_pnl,snapshot_timestamp)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), accountId, str(equity), str(available), str(reserved), str(spotValue), account.realized_pnl, str(unrealized), nowIso());
}

function upsertPositionAfterBuy(db, accountId, symbol, quantity, price) {
  const current = db.prepare('SELECT * FROM positions WHERE account_id=? AND symbol=?').get(accountId, symbol);
  if (!current) {
    db.prepare(`INSERT INTO positions(id,account_id,symbol,quantity,avg_entry_price,reserved_quantity,realized_pnl,updated_at)
      VALUES(?,?,?,?,?,'0','0',?)`).run(randomUUID(), accountId, symbol, str(quantity), str(price), nowIso());
    return;
  }
  const oldQty = units(current.quantity);
  const oldAverage = units(current.avg_entry_price);
  const nextQty = add(oldQty, quantity);
  const oldCost = mul(oldQty, oldAverage);
  const newCost = mul(quantity, price);
  const average = nextQty === ZERO ? ZERO : div(add(oldCost, newCost), nextQty);
  db.prepare('UPDATE positions SET quantity=?,avg_entry_price=?,updated_at=? WHERE id=?').run(str(nextQty), str(average), nowIso(), current.id);
}

function fillOrder(db, order, quote, executionPrice, reserved = false) {
  const account = db.prepare('SELECT * FROM trading_accounts WHERE id=?').get(order.account_id);
  const quantity = units(order.quantity);
  const price = units(executionPrice);
  const notional = mul(quantity, price);
  const fee = feeFor(notional);
  let realizedPnl = ZERO;
  let cashDelta;

  if (order.side === 'buy') {
    const totalCost = add(notional, fee);
    if (reserved) {
      const reservedAmount = units(order.reserved_amount);
      if (reservedAmount < totalCost) throw new Error('Reserved buying power is insufficient at execution time');
      const refund = sub(reservedAmount, totalCost);
      db.prepare('UPDATE trading_accounts SET available_cash=?,reserved_cash=? WHERE id=?')
        .run(str(add(units(account.available_cash), refund)), str(sub(units(account.reserved_cash), reservedAmount)), account.id);
      cashDelta = -totalCost;
      writeLedger(db, account.id, 'reserved_buy_execution', cashDelta, 'order', order.id, {
        available_delta: str(refund), reserved_delta: str(-reservedAmount), quantity: order.quantity, price: str(price), fee: str(fee),
      });
    } else {
      if (units(account.available_cash) < totalCost) throw new Error('Insufficient available virtual cash');
      db.prepare('UPDATE trading_accounts SET available_cash=? WHERE id=?').run(str(sub(units(account.available_cash), totalCost)), account.id);
      cashDelta = -totalCost;
      writeLedger(db, account.id, 'spot_buy', cashDelta, 'order', order.id, { quantity: order.quantity, price: str(price), fee: str(fee) });
    }
    upsertPositionAfterBuy(db, account.id, order.symbol, quantity, price);
  } else {
    const position = db.prepare('SELECT * FROM positions WHERE account_id=? AND symbol=?').get(account.id, order.symbol);
    if (!position) throw new Error('No position exists to sell');
    const currentQty = units(position.quantity);
    const reservedQty = units(position.reserved_quantity);
    const availableQty = sub(currentQty, reservedQty);
    if (reserved) {
      if (currentQty < quantity || reservedQty < quantity) throw new Error('Reserved position quantity is no longer available');
    } else if (availableQty < quantity) {
      throw new Error('Insufficient available holdings');
    }
    const proceeds = sub(notional, fee);
    realizedPnl = sub(mul(quantity, sub(price, units(position.avg_entry_price))), fee);
    const nextQty = sub(currentQty, quantity);
    const nextReserved = reserved ? sub(reservedQty, quantity) : reservedQty;
    db.prepare(`UPDATE positions SET quantity=?,reserved_quantity=?,avg_entry_price=?,realized_pnl=?,updated_at=? WHERE id=?`)
      .run(str(nextQty), str(nextReserved), nextQty === ZERO ? '0' : position.avg_entry_price,
        str(add(units(position.realized_pnl), realizedPnl)), nowIso(), position.id);
    db.prepare('UPDATE trading_accounts SET available_cash=?,realized_pnl=?,fees_paid=? WHERE id=?')
      .run(str(add(units(account.available_cash), proceeds)), str(add(units(account.realized_pnl), realizedPnl)),
        str(add(units(account.fees_paid), fee)), account.id);
    cashDelta = proceeds;
    writeLedger(db, account.id, reserved ? 'reserved_spot_sell' : 'spot_sell', cashDelta, 'order', order.id,
      { quantity: order.quantity, price: str(price), fee: str(fee), realized_pnl: str(realizedPnl), released_reserved_quantity: reserved ? order.quantity : '0' });
  }

  if (order.side === 'buy') {
    db.prepare('UPDATE trading_accounts SET fees_paid=? WHERE id=?').run(str(add(units(account.fees_paid), fee)), account.id);
  }
  db.prepare(`INSERT INTO executions(id,order_id,account_id,symbol,side,quantity,execution_price,fee,realized_pnl,created_at,metadata)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), order.id, order.account_id, order.symbol, order.side, order.quantity, str(price), str(fee), str(realizedPnl), nowIso(),
      JSON.stringify({ provider: quote.provider, pricing: order.side === 'buy' ? 'best available ask' : 'best available bid', quoteReceivedAt: Number(quote.received_at) }));
  db.prepare('UPDATE orders SET status=\'filled\',reserved_amount=\'0\',updated_at=? WHERE id=?').run(nowIso(), order.id);
  addNotification(db, order.account_id, 'order_filled', 'Order filled', `${order.side.toUpperCase()} ${order.quantity} ${order.symbol} at ${str(price)}.`);
  recordAudit(db, { accountId: order.account_id, eventType: 'order_filled', details: { orderId: order.id, symbol: order.symbol, side: order.side, quantity: order.quantity, executionPrice: str(price) } });
  recordSnapshot(db, order.account_id);
  return { price: str(price), fee: str(fee), realizedPnl: str(realizedPnl), cashDelta: str(cashDelta) };
}

function rejectOrder(db, orderId, reason, accountId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=? AND account_id=?').get(orderId, accountId);
  if (order && order.status === 'open') {
    if (order.side === 'buy' && units(order.reserved_amount) > ZERO) {
      const account = db.prepare('SELECT * FROM trading_accounts WHERE id=?').get(accountId);
      const reserve = units(order.reserved_amount);
      db.prepare('UPDATE trading_accounts SET available_cash=?,reserved_cash=? WHERE id=?')
        .run(str(add(units(account.available_cash), reserve)), str(sub(units(account.reserved_cash), reserve)), accountId);
      writeLedger(db, accountId, 'rejected_order_reserve_released', ZERO, 'order', orderId,
        { available_delta: str(reserve), reserved_delta: str(-reserve) });
      db.prepare("UPDATE orders SET reserved_amount='0' WHERE id=?").run(orderId);
    }
    if (order.side === 'sell' && units(order.reserved_amount) > ZERO) {
      const position = db.prepare('SELECT * FROM positions WHERE account_id=? AND symbol=?').get(accountId, order.symbol);
      if (position) {
        const heldReservation = units(position.reserved_quantity);
        const orderReservation = units(order.reserved_amount);
        const release = heldReservation < orderReservation ? heldReservation : orderReservation;
        db.prepare('UPDATE positions SET reserved_quantity=?,updated_at=? WHERE id=?')
          .run(str(sub(heldReservation, release)), nowIso(), position.id);
      }
    }
  }
  db.prepare(`UPDATE orders SET status='rejected',rejection_reason=?,reserved_amount='0',updated_at=? WHERE id=?`).run(reason, nowIso(), orderId);
  addNotification(db, accountId, 'order_rejected', 'Order rejected', reason);
}

function safelyFillOrder(db, order, quote, executionPrice, reserved = false) {
  // A savepoint makes a fill atomic even when a conditional order fails inside a larger transaction.
  db.exec('SAVEPOINT simulated_order_fill');
  try {
    const result = fillOrder(db, order, quote, executionPrice, reserved);
    db.exec('RELEASE simulated_order_fill');
    return { ok: true, result };
  } catch (error) {
    db.exec('ROLLBACK TO simulated_order_fill');
    db.exec('RELEASE simulated_order_fill');
    rejectOrder(db, order.id, error.message || 'Order execution failed.', order.account_id);
    return { ok: false, error };
  }
}

export class TradingEngine {
  constructor(db) { this.db = db; }

  createAccount(userId, startingCapital) {
    const capital = parseDecimal(String(startingCapital));
    const accountId = randomUUID();
    const timestamp = nowIso();
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO trading_accounts(id,user_id,base_currency,initial_capital,available_cash,reserved_cash,realized_pnl,fees_paid,created_at)
        VALUES(?,?,'USD',?,?,'0','0','0',?)`).run(accountId, userId, str(capital), str(capital), timestamp);
      writeLedger(this.db, accountId, 'initial_virtual_capital', capital, 'account', accountId, { countsTowardTradingReturn: false });
      const insert = this.db.prepare('INSERT INTO watchlist_items(id,account_id,symbol,sort_order,created_at) VALUES(?,?,?,?,?)');
      ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'].forEach((symbol, index) => insert.run(randomUUID(), accountId, symbol, index, timestamp));
      recordAudit(this.db, { userId, accountId, eventType: 'account_created', details: { startingCapital: str(capital), currency: 'USD' } });
      recordSnapshot(this.db, accountId);
    });
    return this.db.prepare('SELECT * FROM trading_accounts WHERE id=?').get(accountId);
  }

  submitOrder(accountId, { symbol, side, orderType, quantity: quantityInput, limitPrice, triggerPrice, clientOrderId }) {
    const safeSymbol = String(symbol || '').toUpperCase();
    const safeSide = String(side || '').toLowerCase();
    const safeType = String(orderType || '').toLowerCase();
    if (!['buy','sell'].includes(safeSide)) throw Object.assign(new Error('Side must be buy or sell'), { status: 400 });
    if (!['market','limit','stop_market','take_profit'].includes(safeType)) throw Object.assign(new Error('Unsupported order type'), { status: 400 });
    if (!/^[A-Z0-9]{3,16}$/.test(safeSymbol)) throw Object.assign(new Error('Invalid instrument symbol'), { status: 400 });
    if (!clientOrderId || String(clientOrderId).length > 100) throw Object.assign(new Error('A valid clientOrderId is required for idempotency'), { status: 400 });
    let quantity;
    let limit = null;
    let trigger = null;
    try { quantity = parseDecimal(String(quantityInput)); }
    catch { throw Object.assign(new Error('Quantity must be a positive number with at most 8 decimal places'), { status: 400 }); }
    if (quantity <= ZERO) throw Object.assign(new Error('Quantity must be greater than zero'), { status: 400 });
    if (safeType === 'limit') {
      try { limit = parseDecimal(String(limitPrice)); }
      catch { throw Object.assign(new Error('A valid limit price is required'), { status: 400 }); }
      if (limit <= ZERO) throw Object.assign(new Error('Limit price must be greater than zero'), { status: 400 });
    }
    if (safeType === 'stop_market' || safeType === 'take_profit') {
      try { trigger = parseDecimal(String(triggerPrice)); }
      catch { throw Object.assign(new Error('A valid trigger price is required'), { status: 400 }); }
      if (trigger <= ZERO) throw Object.assign(new Error('Trigger price must be greater than zero'), { status: 400 });
      if (safeSide !== 'sell') throw Object.assign(new Error('Conditional close orders in this first release only support selling an owned spot position'), { status: 400 });
    }

    return transaction(this.db, () => {
      const dupe = this.db.prepare('SELECT * FROM orders WHERE account_id=? AND client_order_id=?').get(accountId, String(clientOrderId));
      if (dupe) return { order: dupe, duplicate: true };
      const instrument = this.db.prepare('SELECT * FROM instruments WHERE symbol=? AND trading_enabled=1').get(safeSymbol);
      if (!instrument) throw Object.assign(new Error('This instrument is not enabled for trading'), { status: 400 });
      const account = this.db.prepare('SELECT * FROM trading_accounts WHERE id=? AND account_status=\'active\'').get(accountId);
      if (!account) throw Object.assign(new Error('Trading account is unavailable'), { status: 403 });
      const quote = getQuote(this.db, safeSymbol);
      const isFresh = freshQuote(quote);
      const orderId = randomUUID();
      const timestamp = nowIso();
      let status = safeType === 'market' && !isFresh ? 'rejected' : 'open';
      let reason = safeType === 'market' && !isFresh ? 'Market quote is unavailable or stale. Try again when fresh data returns.' : null;
      let reserveAmount = ZERO;

      this.db.prepare(`INSERT INTO orders(id,account_id,symbol,side,order_type,quantity,limit_price,trigger_price,status,reserved_amount,client_order_id,rejection_reason,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(orderId, accountId, safeSymbol, safeSide, safeType, str(quantity), limit === null ? null : str(limit),
          trigger === null ? null : str(trigger), status === 'rejected' ? 'rejected' : 'open', '0', String(clientOrderId), reason, timestamp, timestamp);
      if (status === 'rejected') {
        addNotification(this.db, accountId, 'order_rejected', 'Order rejected', reason);
        recordAudit(this.db, { accountId, eventType: 'order_rejected', details: { orderId, reason } });
        return { order: this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId), duplicate: false };
      }

      if (safeType === 'limit' && safeSide === 'buy') {
        reserveAmount = add(mul(quantity, limit), feeFor(mul(quantity, limit)));
        if (units(account.available_cash) < reserveAmount) {
          rejectOrder(this.db, orderId, 'Insufficient available virtual cash to reserve this buy limit order.', accountId);
          return { order: this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId), duplicate: false };
        }
        this.db.prepare('UPDATE trading_accounts SET available_cash=?,reserved_cash=? WHERE id=?')
          .run(str(sub(units(account.available_cash), reserveAmount)), str(add(units(account.reserved_cash), reserveAmount)), accountId);
        writeLedger(this.db, accountId, 'buy_order_reserve', ZERO, 'order', orderId, { available_delta: str(-reserveAmount), reserved_delta: str(reserveAmount) });
        this.db.prepare('UPDATE orders SET reserved_amount=? WHERE id=?').run(str(reserveAmount), orderId);
      }
      if ((safeType === 'limit' && safeSide === 'sell') || safeType === 'stop_market' || safeType === 'take_profit') {
        const position = this.db.prepare('SELECT * FROM positions WHERE account_id=? AND symbol=?').get(accountId, safeSymbol);
        if (!position) {
          rejectOrder(this.db, orderId, 'No owned spot position is available to reserve for this sell order.', accountId);
          return { order: this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId), duplicate: false };
        }
        const availableQty = sub(units(position.quantity), units(position.reserved_quantity));
        if (availableQty < quantity) {
          rejectOrder(this.db, orderId, 'Insufficient unreserved holdings for this sell order.', accountId);
          return { order: this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId), duplicate: false };
        }
        this.db.prepare('UPDATE positions SET reserved_quantity=?,updated_at=? WHERE id=?')
          .run(str(add(units(position.reserved_quantity), quantity)), timestamp, position.id);
        this.db.prepare('UPDATE orders SET reserved_amount=? WHERE id=?').run(str(quantity), orderId);
        writeLedger(this.db, accountId, 'position_quantity_reserved', ZERO, 'order', orderId, { symbol: safeSymbol, reserved_quantity: str(quantity) });
      }

      const order = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      recordAudit(this.db, { accountId, eventType: 'order_submitted', details: { orderId, symbol: safeSymbol, side: safeSide, orderType: safeType, quantity: str(quantity) } });
      if (safeType === 'market') {
        const executable = safeSide === 'buy' ? quote?.ask : quote?.bid;
        if (!executable || units(executable) <= ZERO) {
          rejectOrder(this.db, orderId, 'A valid best bid/ask is unavailable; no fill was simulated.', accountId);
        } else {
          safelyFillOrder(this.db, order, quote, executable, false);
        }
      } else if (isFresh) {
        this.#tryTriggerWithinTransaction(orderId, quote);
      }
      return { order: this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId), duplicate: false };
    });
  }

  #tryTriggerWithinTransaction(orderId, quote) {
    const order = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!order || order.status !== 'open' || !freshQuote(quote)) return;
    const bid = units(quote.bid || '0');
    const ask = units(quote.ask || '0');
    let executionPrice = null;
    if (order.order_type === 'limit') {
      if (order.side === 'buy' && ask > ZERO && ask <= units(order.limit_price)) executionPrice = quote.ask;
      if (order.side === 'sell' && bid > ZERO && bid >= units(order.limit_price)) executionPrice = quote.bid;
    } else if (order.order_type === 'stop_market' && bid > ZERO && bid <= units(order.trigger_price)) {
      executionPrice = quote.bid;
    } else if (order.order_type === 'take_profit' && bid > ZERO && bid >= units(order.trigger_price)) {
      executionPrice = quote.bid;
    }
    if (executionPrice === null) return;
    safelyFillOrder(this.db, order, quote, executionPrice, true);
  }

  processOpenOrders() {
    const orders = this.db.prepare(`SELECT * FROM orders WHERE status='open' ORDER BY created_at ASC LIMIT 1000`).all();
    for (const order of orders) {
      const quote = getQuote(this.db, order.symbol);
      if (!freshQuote(quote)) continue;
      try { transaction(this.db, () => this.#tryTriggerWithinTransaction(order.id, quote)); }
      catch (error) { console.error('Order monitor error:', error.message); }
    }
  }

  cancelOrder(accountId, orderId) {
    return transaction(this.db, () => {
      const order = this.db.prepare('SELECT * FROM orders WHERE id=? AND account_id=?').get(orderId, accountId);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (order.status !== 'open') throw Object.assign(new Error(`Only open orders can be cancelled (current status: ${order.status})`), { status: 409 });
      if (order.side === 'buy' && units(order.reserved_amount) > ZERO) {
        const account = this.db.prepare('SELECT * FROM trading_accounts WHERE id=?').get(accountId);
        const reserved = units(order.reserved_amount);
        this.db.prepare('UPDATE trading_accounts SET available_cash=?,reserved_cash=? WHERE id=?')
          .run(str(add(units(account.available_cash), reserved)), str(sub(units(account.reserved_cash), reserved)), accountId);
        writeLedger(this.db, accountId, 'buy_order_reserve_released', ZERO, 'order', order.id, { available_delta: str(reserved), reserved_delta: str(-reserved) });
      }
      if (order.side === 'sell' && units(order.reserved_amount) > ZERO) {
        const position = this.db.prepare('SELECT * FROM positions WHERE account_id=? AND symbol=?').get(accountId, order.symbol);
        if (position) {
          const held = units(position.reserved_quantity);
          const reserve = units(order.reserved_amount);
          const release = held < reserve ? held : reserve;
          this.db.prepare('UPDATE positions SET reserved_quantity=?,updated_at=? WHERE id=?')
            .run(str(sub(held, release)), nowIso(), position.id);
        }
      }
      this.db.prepare(`UPDATE orders SET status='cancelled',reserved_amount='0',updated_at=? WHERE id=?`).run(nowIso(), order.id);
      addNotification(this.db, accountId, 'order_cancelled', 'Order cancelled', `${order.side.toUpperCase()} ${order.quantity} ${order.symbol} order cancelled.`);
      recordAudit(this.db, { accountId, eventType: 'order_cancelled', details: { orderId: order.id } });
      recordSnapshot(this.db, accountId);
      return this.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
    });
  }

  portfolio(accountId) {
    const account = this.db.prepare('SELECT * FROM trading_accounts WHERE id=?').get(accountId);
    if (!account) throw Object.assign(new Error('Trading account not found'), { status: 404 });
    const rows = this.db.prepare(`SELECT p.*,i.name,i.base_asset,i.quote_asset FROM positions p JOIN instruments i ON i.symbol=p.symbol
      WHERE p.account_id=? AND CAST(p.quantity AS REAL)>0 ORDER BY p.symbol`).all(accountId);
    let spotValue = ZERO;
    let unrealizedPnl = ZERO;
    let missingMarks = 0;
    const positions = rows.map((position) => {
      const quote = getQuote(this.db, position.symbol);
      const quantity = units(position.quantity);
      const average = units(position.avg_entry_price);
      const current = quote ? units(quote.last_price) : ZERO;
      if (!quote) missingMarks += 1;
      const value = quote ? mul(quantity, current) : ZERO;
      const cost = mul(quantity, average);
      const unrealized = quote ? sub(value, cost) : ZERO;
      spotValue = add(spotValue, value);
      unrealizedPnl = add(unrealizedPnl, unrealized);
      const returnPercent = cost > ZERO ? div(mul(unrealized, parseDecimal('100')), cost) : ZERO;
      return {
        symbol: position.symbol, name: position.name, baseAsset: position.base_asset,
        quantity: position.quantity, reservedQuantity: position.reserved_quantity, availableQuantity: str(sub(quantity, units(position.reserved_quantity))),
        averageEntryPrice: position.avg_entry_price, currentPrice: quote?.last_price ?? null,
        marketValue: quote ? str(value) : null, costBasis: str(cost), unrealizedPnl: quote ? str(unrealized) : null,
        returnPct: quote ? str(returnPercent) : null, allocationPct: null,
        quoteAgeSeconds: quote ? Math.max(0, Math.floor((Date.now() - Number(quote.received_at)) / 1000)) : null,
        dataMode: quote ? (freshQuote(quote) ? 'LIVE' : 'STALE') : 'UNAVAILABLE',
      };
    });
    const available = units(account.available_cash);
    const reserved = units(account.reserved_cash);
    const equity = add(add(available, reserved), spotValue);
    positions.forEach((position) => {
      if (position.marketValue !== null && equity > ZERO) position.allocationPct = str(div(mul(units(position.marketValue), parseDecimal('100')), equity));
    });
    const initial = units(account.initial_capital);
    const totalReturn = sub(equity, initial);
    const returnPct = initial > ZERO ? div(mul(totalReturn, parseDecimal('100')), initial) : ZERO;
    const openOrders = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE account_id=? AND status='open'`).get(accountId).count);
    const completedTrades = Number(this.db.prepare('SELECT COUNT(*) AS count FROM executions WHERE account_id=?').get(accountId).count);
    return {
      currency: account.base_currency,
      startingCapital: account.initial_capital,
      availableCash: account.available_cash,
      reservedCash: account.reserved_cash,
      spotValue: str(spotValue),
      equity: str(equity),
      totalReturn: str(totalReturn),
      returnPct: str(returnPct),
      realizedPnl: account.realized_pnl,
      unrealizedPnl: str(unrealizedPnl),
      feesPaid: account.fees_paid,
      completedTrades,
      openOrders,
      positions,
      missingMarks,
      valuationMethod: 'Available cash + reserved cash + owned spot positions valued at the latest stored last price.',
      warning: missingMarks ? `${missingMarks} position(s) have no stored price and are excluded from the displayed spot value.` : null,
    };
  }

  snapshotAccount(accountId) { transaction(this.db, () => recordSnapshot(this.db, accountId)); }

  snapshotAllAccounts() {
    const accounts = this.db.prepare('SELECT id FROM trading_accounts WHERE account_status=\'active\'').all();
    for (const account of accounts) {
      try { this.snapshotAccount(account.id); } catch (error) { console.error('Portfolio snapshot failed:', error.message); }
    }
  }
}

export const TRADING_RULES = Object.freeze({ feeRate: '0.001', feePercent: '0.10%', quoteMaxAgeSeconds: 35, quoteAssetConversion: 'USDT is treated as approximately USD at 1:1 for this educational simulator; no USDT/USD FX leg is modeled.' });
