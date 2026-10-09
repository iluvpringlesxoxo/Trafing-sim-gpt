# ALPHA TERMINAL

A runnable, dependency-free paper-trading simulator. It uses public cryptocurrency market data when the provider is reachable, persistent local SQLite storage, virtual USD, server-side order validation, fixed-point accounting, and a responsive dark trading UI.

> **Simulation only:** the app has no brokerage execution connection and no real-money order endpoints. All balances and fills are virtual. Public crypto pair prices are quoted in USDT and treated as approximately USD 1:1 for this educational model; no USDT/USD conversion is modeled.

## 1. Implementation plan

1. **Stack:** Node.js 22.13+ ES modules with the built-in HTTP server and `node:sqlite`; HTML/CSS/vanilla JavaScript frontend with no external runtime packages. This avoids a package installation requirement and allows the project to run directly in the available environment. SQLite's Node API is still described as experimental by Node, so migrate to PostgreSQL before a public production launch.
2. **Directory structure:** HTTP/auth routing in `src/server.mjs`; relational schema and migrations/seed instruments in `src/db.mjs`; provider abstraction in `src/market-data.mjs`; fixed-point decimal operations in `src/decimal.mjs`; trading, reservations, execution, ledger, and portfolio valuations in `src/trading-engine.mjs`; UI in `public/`; financial logic tests in `tests/`.
3. **Database:** relational SQLite with foreign keys, uniqueness constraints, WAL, prepared statements, and tables for users, sessions, accounts, instruments, latest quotes, orders, executions, positions, a signed cash ledger, portfolio snapshots, watchlists, notifications, and audit logs. Monetary values and quantities are persisted as decimal strings, calculated with 8-decimal fixed-point `BigInt` arithmetic.
4. **Market data:** centralized 15-second polling against Binance's public market-data-only REST API, with exponential retry backoff. The initial instrument list is 12 major crypto/USDT spot pairs. The app loads actual provider OHLCV candles on demand. Provider status and quote age are visible; it does not fall back to fabricated prices.
5. **Trading engine:** server-side market and limit orders, stop-market sells, take-profit sells, bid/ask execution, a configurable 0.10% simulated fee, reserved buying power/holdings, idempotency keys, transactional account changes, trade records, notifications, and persisted portfolio snapshots. Open conditional orders are evaluated only when a fresh quote is available.
6. **UI design:** near-black workspace, controlled purple/cyan accents, readable tabular financial figures, subtle glass panels, canvas-based portfolio and candlestick charts, responsive side navigation, terminal order entry, market tables, portfolio, orders, trade history, leaderboard, and account preferences.
7. **Milestones:** foundation/authentication and chosen starting balance; central real-data ingestion and historical candles; spot accounting and core order types; portfolio/trade history/watchlists; public performance leaderboard; automated accounting tests. Later phases should move the database to PostgreSQL, use a production authentication provider, add a proper worker/queue, and only then add derivatives and further products.

## 2. Run it

Requirements: Node.js **22.13 or newer**. No `npm install` is necessary.

```bash
cd alpha-terminal
npm start
```

Open <http://localhost:4173>.

Environment variables are read directly by Node (the `.env.example` file is a reference; no dotenv loader is bundled):

- `PORT`: web server port, default `4173`.
- `DB_PATH`: SQLite database path, default `./data/alpha-terminal.sqlite` relative to the project.
- `NODE_ENV=production`: enables the `Secure` cookie attribute. HTTPS termination is still required in deployment.

For development auto-restart, run `npm run dev`. Tests use only Node's built-in test runner:

```bash
npm test
```

## 3. Market-data behavior

Configured provider: Binance public market-data-only REST API (`https://data-api.binance.vision`). Current quotes use 24-hour ticker statistics and best bid/ask; candle charts use the provider's kline endpoint. Public market data does not require a private trading API key. Review current provider documentation, jurisdiction availability, rate limits, and market-data terms before deployment:

- <https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md>
- <https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md>

The server-side provider integration was implemented but **could not reach Binance from the development execution environment** (`fetch failed`). As a result, live quote ingestion could not be verified here. The app responds with an explicit `UNAVAILABLE` market-data state and rejects market orders until fresh bid/ask quotes are available. It does not label fixtures or generated values as live.

## 4. Current project checklist

| Component | Status | Notes |
|---|---|---|
| Responsive landing/auth UI | Implemented | Register, login, persistent HttpOnly session cookie, logout |
| Starting capital | Implemented | $100 to $1,000,000, recorded at account creation, no balance reset endpoint |
| Password storage | Implemented | Node `scrypt`, random salt; no plaintext password storage |
| Relational database | Implemented | SQLite schema is created on startup; foreign keys and indexes included |
| Live public crypto quotes | Implemented, not externally verified here | Provider fetch failed in this environment; stale/unavailable state is honest |
| Historical OHLCV chart | Implemented, not externally verified here | Loaded from provider when connected |
| Market orders | Implemented | Bid/ask, quote freshness guard, simulated fee |
| Limit orders | Implemented | Buy reserves cash; sell reserves holdings; eligible cancellation releases reservations |
| Stop-market sell / take-profit sell | Implemented | Backend-monitored conditional orders, using fresh bids |
| Weighted-average spot cost basis | Implemented | Partial sells preserve the remaining position cost basis |
| Idempotency and atomic updates | Implemented | Client order ID uniqueness + SQLite write transaction |
| Ledger and audit events | Implemented | Cash deltas and reserve movement metadata recorded |
| Portfolio valuation/history | Implemented | Snapshots on account creation/fills/cancellation and periodic timer |
| Watchlist | Implemented | Per-account persisted items |
| Trade history / CSV export | Implemented | Current user's fills only |
| Performance leaderboard | Implemented, basic | Public users only; return normalized to initial virtual capital |
| In-app notifications | Implemented, basic | Order fills, rejects, cancellations; persisted |
| Stop-limit, bracket/OCO, shorting | Not implemented | UI does not advertise them as working features |
| Futures, leverage, funding, liquidation | Not implemented | Deliberately excluded until a separately tested derivatives accounting model exists |
| Stocks, ETFs, forex, commodities | Not implemented | Only the configured crypto/USDT spot pairs are enabled |
| Email verification/password reset/MFA | Not implemented | Use a production identity provider before public launch |
| PostgreSQL, multi-worker deployment, admin roles | Not implemented | SQLite/local single-process foundation, not a production multi-tenant deployment |
| Challenges, achievements, seasonal leaderboards | Not implemented | No fake users or prize mechanics are seeded |

## 5. Trading and accounting model

- Market buys use the latest best ask; market sells use the latest best bid. Market execution is refused if the quote is missing or older than 35 seconds.
- A 0.10% fee is applied to each fill. It is a simulator setting, not a claimed exchange fee.
- Buy limit orders reserve `quantity × limit price + estimated fee`. They fill only if the current ask is at or below the limit. Sell limit orders fill only if the current bid is at or above the limit.
- Stop-market and take-profit orders in this release close an owned long spot holding by selling at a fresh bid after the bid meets the trigger. The fill can differ from the trigger. The model does not offer short selling or derivatives.
- Open-order execution, cash changes, position accounting, executions, ledger records, notifications, and a snapshot happen inside one SQLite write transaction. Duplicate `clientOrderId` values for an account do not execute twice.
- Spot cost basis uses a weighted-average entry price. Realized P&L on sales is calculated against that basis and subtracts the sell fee; all fees also affect total equity through cash movements.
- Equity = available virtual cash + reserved virtual cash + currently marked spot holdings. A stored price can be stale for display/valuation; quote status is made visible. New orders require fresh quotes.
- Leaderboard return = `(current equity − initial virtual capital) / initial virtual capital`. Virtual top-ups and account resets are not available, so they cannot be used to inflate ranking.

## 6. API summary

- `GET /api/health`
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/markets`, `GET /api/markets/:symbol`, `GET /api/markets/:symbol/candles`
- `GET /api/portfolio`, `GET /api/portfolio/history`
- `POST /api/orders`, `GET /api/orders`, `DELETE /api/orders/:id`
- `GET /api/trades`
- `GET /api/watchlist`, `POST /api/watchlist`, `DELETE /api/watchlist?symbol=...`
- `GET /api/leaderboard`, `GET /api/users/:username/public-profile`
- `GET /api/notifications`, `POST /api/notifications/:id/read`
- `GET /api/user/profile`, `PATCH /api/user/profile`

API responses use a consistent `{ "error": { "code", "message" } }` format for errors. Account routes derive ownership from the authenticated session instead of accepting an arbitrary account ID.

## 7. Deployment warnings

This is a runnable, tested foundation, **not a claim of full production readiness**. Before exposing it to the public internet, migrate to PostgreSQL, introduce schema migration tooling, use a mature identity provider, add email verification/password reset, CSRF defense appropriate for the deployment, external rate limiting, secret management, structured centralized logging, process supervision, database backups, load testing, and a durable order-monitor worker. Add futures only after instrument specifications, mark-price rules, margin-mode accounting, funding, and liquidation tests are independently reviewed. Do not enable real-money brokerage endpoints in this paper-trading product.
