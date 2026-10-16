# Trade Master

**Automated Binance USDT-M Futures trading terminal** — a 5-minute order-flow strategy with a
browser dashboard, a hardened server-side execution path, and an unattended guardian loop that keeps
protecting positions when no tab is open.

> ### ⚠️ Read this before anything else
>
> - **The strategy has no backtest and no live track record.** Nothing in this repository proves it
>   is profitable. Prove it on **testnet** before a single real dollar is at risk.
> - **Testnet is the default.** Mainnet requires *both* `TRADE_ALLOW_MAINNET=true` on the server
>   **and** typing `I UNDERSTAND` in the UI.
> - **Set `TM_OPERATOR_TOKEN` before deploying with real keys.** The Binance API secret may never be
>   read by a browser, so a public URL without it would be an open order relay; the app refuses to
>   trade in that state (see [Safety model](#safety-model)).
> - Futures trading with leverage can lose more than you deposit. Size the caps in
>   [Configuration](#configuration) to money you can afford to lose entirely.

---

## Contents

- [What it does](#what-it-does)
- [The strategy](#the-strategy)
- [Architecture](#architecture)
- [Safety model](#safety-model)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Testing and verification](#testing-and-verification)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Documentation index](#documentation-index)

---

## What it does

| Area | Detail |
|---|---|
| **Market** | Binance USDT-M Futures, 5-minute candles |
| **Universe** | The **whole USDT-M market**, ranked most-volatile-first by a cached market scan (one `/ticker/24hr` call, $50M liquidity floor). `TRADE_SYMBOL_ALLOWLIST` overrides it; `TRADE_DISCOVERY_ENABLED=false` pins it to the built-in 12 majors |
| **Opportunity list** | The market scan *promotes* opportunity assets onto a persistent list (up to 20); the fast scan trades only from that list, and a pair leaves the moment it stops qualifying |
| **Market regime** | Chop filter (ADX + efficiency ratio) and a volatility band (0.6 %–4 %) — refusals are reported with reasons, never traded |
| **Selection** | Best signal score inside the band; volatility gates eligibility, breaks ties, and is shown as a 0–100 percentile rank |
| **Scan cadence** | Every 15 s (configurable), with a Binance API weight shield that halts scanning at a safety threshold |
| **Risk per trade** | `$2.00` base margin × 10–15× isolated leverage (server-capped at `$25` margin / `$500` notional) |
| **Protection** | A stop-loss is **mandatory**: if Binance rejects the stop, the position is flattened immediately and the trade is reported as failed |
| **Take-profit** | Structural target from the same indicators, at least 1.67× the stop distance |
| **Compounding** | On a win, 20 % of the profit is added to the next trade's margin; a loss resets to base |
| **Concurrency** | Max 5 open positions (configurable) |
| **Unattended** | Optional server-side engine that reconciles, re-arms stops, settles PnL from Binance's income ledger, and can open trades on its own |

## The strategy

Every scan evaluates three independent order-flow indicators on the last 5 minutes of price action:

1. **HVN / Volume Profile** — volume is distributed across the price bins candles traded through to
   find the Point of Control (POC), the high-volume nodes and the 70 % value area (VAH/VAL).
   Price above POC is treated as bullish pressure, below as bearish.
2. **Heavy Absorption** — compares aggressive taker volume against the candle's price progress to
   detect large passive limit orders absorbing flow (a long lower wick on heavy volume is bullish
   absorption).
3. **Stacked Imbalance** — measures buy vs sell aggression per bar and requires a ~3:1 disagreement
   (stacked across levels) to register an imbalance.

The three scores are combined, conflicting signals are penalised, and a direction plus a 0–100 score
falls out. Entries require `STRONG_BUY`/`STRONG_SELL`, or `BUY`/`SELL` with a score ≥ 65 — *and* the
pair has to pass the market-regime gate below, which is now part of the same shared decision.

### Which pairs get looked at, and in what order

Two stages at two rates: the market scan is wide and cached (one call), the opportunity scan is narrow
and fast (every cycle), so the bot can react without re-ranking the market to place a trade.

1. **Market scan → the opportunity list.** `GET /fapi/v1/ticker/24hr` answers for every symbol, so the
   whole USDT-M market is ranked: perpetuals only, `TRADING`, no stablecoin pairs, no quarterly `_`
   contracts, then a liquidity floor (`TRADE_DISCOVERY_MIN_QUOTE_VOLUME`, default $50M/24h). What is
   left is sorted **most volatile → least volatile** — 0.6 × the 24h high-low amplitude + 0.4 × the
   24h move — and cached for `TRADE_DISCOVERY_TTL_MS`, so a 15 s loop does not re-rank the market four
   times a minute. The most volatile pairs that could actually be traded are then **promoted onto the
   opportunity list** (up to `TRADE_OPPORTUNITY_MAX`, default 20, clamped by what one cycle can
   afford). The list is persisted to `TRADE_DATA_DIR/opportunity-list.json`, so a restart does not
   have to re-discover the market before it can trade again.
2. **Opportunity scan → trade execution.** Every cycle deep-scans **exactly the opportunity list**
   (100 5m candles per pair, minus anything already open): a bounded, fixed-size scan that is the
   only source of trades.

   | Leaves the list when | Reason |
   |---|---|
   | It drops off the ranked board — delisted, or 24h volume fell under the liquidity floor | `not-on-board` |
   | The market moves it outside the screening band (quiet again, or wild) | `vol-below-floor` / `vol-above-ceiling` |
   | A clearly more volatile qualified pair takes its slot on a full list (5% margin, so the boundary does not churn) | `displaced` |
   | The deep scan refuses it — chop, out of band, or no usable candles — on `TRADE_OPPORTUNITY_STRIKES` consecutive passes (default 2) | `choppy` / `vol-*` / `no-data` |
   | Its exchange filters disappear, so it cannot be sized safely | `filters-unknown` (immediate) |

   A removal is remembered for `TRADE_OPPORTUNITY_COOLDOWN_MS` (default 5 min), so a pair that just
   failed cannot bounce straight back in. A *fallback* board (the exchange could not be reached, so
   the built-in majors stand in) is never read as a ranking: the list is carried over untouched
   rather than emptied because the market scan had a bad minute.

3. **Regime gate (settled candles only), applied to every list member.** A pair is refused when the
   tape is doing nothing or is too violent:
   - **Chop** — ADX(14) below `TRADE_CHOP_ADX_FLOOR` **and** Kaufman efficiency ratio below
     `TRADE_CHOP_EFFICIENCY_FLOOR`. Both must agree, so an orderly slow trend (low ADX, high ER) is
     still traded.
   - **Band** — `volatilityPercent` below `TRADE_MIN_VOLATILITY_PCT` (dead market: signals are noise
     and stops die on spread) or above `TRADE_MAX_VOLATILITY_PCT` (violent market: an ATR-sized stop
     is a coin flip). The top band is *skipped*, not traded smaller — leverage and stop sizing stay
     uniform by design.
   Every refusal is reported with its reason (`choppy (ADX 13.8, ER 0.21)`, `vol above ceiling …`) in
   the scanner, the engine status and the log, so "nothing traded" is never a mystery.
4. **Selection.** Among the list members that survive, the **best signal score** wins, with
   volatility breaking ties. Volatility decides *eligibility* (band), *membership* (the list is
   ranked most-volatile-first) and *ties*, and is displayed prominently (raw % plus a 0–100
   percentile rank), but it does not overrule a better setup — the previous behaviour, which reached
   for the most volatile pair that had any signal at all, has been removed.

All thresholds live in `.env` (`TRADE_DISCOVERY_*`, `TRADE_OPPORTUNITY_*`, `TRADE_SCAN_*`,
`TRADE_MIN_VOLATILITY_PCT`, `TRADE_MAX_VOLATILITY_PCT`, `TRADE_CHOP_*`). Set `TRADE_SYMBOL_ALLOWLIST`
to override the discovered universe with named pairs, `TRADE_DISCOVERY_ENABLED=false` to pin the
universe to the built-in majors, or `TRADE_OPPORTUNITY_ENABLED=false` to go back to a stateless
shortlist rebuilt from the ranking every cycle.

**TP/SL are structural, not fixed percentages:** the stop is anchored to the tightest nearby
absorption wick, imbalance level or volume node that sits **0.85–1.6 × ATR** away, and the target is
the next high-volume node at least **1.67× the risk** away (capped near 3.5 × ATR). A bracket placed
on the wrong side of entry, or closer than 5 bp, is refused before any order is sent.

## Architecture

```
┌───────────────────────────── browser ──────────────────────────────┐
│  Next.js 15 App Router UI (React 19)                               │
│  • operator sign-in wall (lib/operator-auth)                       │
│  • scanner / positions / history / diagnostics                     │
│  • fallback TP/SL monitor (2 s tick) while the tab is open         │
│  localStorage: UI state, logs, browser-side history estimate       │
└───────────────────────────────┬────────────────────────────────────┘
                                │ same-origin fetch + X-TM-Request
┌───────────────────────────────▼────────────────────────────────────┐
│  Route handlers (app/api/**) — thin HTTP shells                    │
│  operator auth → CSRF/origin check → credentials → risk policy     │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────┐
│  lib/market-scanner.ts — ranks the whole market (1 ticker call)    │
│  lib/market-data.ts — shortlist → klines → regime gate → selection │
│  lib/market-regime.ts — ADX, efficiency ratio, volatility band      │
└────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────┐
│  lib/order-executor.ts — the ONLY place orders are placed          │
│  sizing (exchange filters) · brackets · fill verification          │
│  mandatory stop-loss · ambiguous-failure reconciliation            │
└──────┬───────────────────────────────────────┬─────────────────────┘
       │                                       │
┌──────▼──────────────┐              ┌─────────▼──────────────────────┐
│ lib/binance-client  │              │ lib/engine.ts (optional)       │
│ signed REST calls   │              │ reconcile · re-arm stops ·     │
│ timeouts, errors    │              │ breach backstop · settle PnL   │
└──────┬──────────────┘              └─────────┬──────────────────────┘
       │                                       │
       │                            ┌──────────▼──────────────────────┐
       │                            │ lib/position-ledger.ts          │
       │                            │ durable JSON ledger (atomic)    │
       │                            └─────────────────────────────────┘
       ▼
  Binance USDT-M Futures (testnet or mainnet)
```

Both the browser loop and the unattended engine call **the same** `lib/order-executor.ts`, so user
clicks and automated entries can never drift apart on sizing, brackets or error handling.

## Safety model

Defence in depth, every layer independent:

| Layer | What it stops |
|---|---|
| **Operator session** (`TM_OPERATOR_TOKEN`) | Anonymous order placement. A signed httpOnly cookie gates every money endpoint; fail-closed (`503`) if server keys exist without a token. |
| **CSRF / origin guard** | Cross-site pages driving the API (`X-TM-Request` header + `Origin`/`Referer` must match). |
| **Server risk policy** (`lib/risk-policy.ts`) | Over-leverage, oversized margin/notional, too many positions, non-allowlisted symbols — enforced *before* any exchange call, regardless of what the UI sent. |
| **Daily-loss breaker** | Realized PnL + commission + funding from Binance's income ledger; locks new entries for the UTC day. Fails **closed** when the figure cannot be read. |
| **Kill switch** (`TRADE_HALT=true`) | All new entries, instantly. Closing still works so a position can always be unwound. |
| **Mainnet gates** | `TRADE_ALLOW_MAINNET=true` **and** the typed `I UNDERSTAND` confirmation. |
| **Mandatory stop-loss** | If the `STOP_MARKET` order is rejected, the position is flattened and the trade reports failure — never a silent naked position. |
| **Exchange-filter sizing** | `LOT_SIZE` / `PRICE_FILTER` / `MIN_NOTIONAL` read live from `exchangeInfo`; refuses to guess rather than over-sizing or sending a stop Binance will reject for precision. |
| **Guardian engine** | Reconciles against `positionRisk` every cycle, re-arms a missing stop, closes positions whose stop cannot be established, adopts stops moved on the exchange. |
| **Position-mode check** | Refuses to trade a Hedge-Mode account (this bot places One-Way orders). |
| **Clickjacking / transport** | `X-Frame-Options: DENY` + `frame-ancestors 'none'` by default, httpOnly + `Secure` (on https) cookies. `TM_FRAME_ANCESTORS` (build-time; Next.js bakes headers into the routes manifest) opts in to a named embedding origin (`https://console.example.com` or `https://*.example.com`) — X-Frame-Options cannot express an allowlist, so that path relies on the CSP control alone. |
| **No key in the browser** | API keys are never in `localStorage`, never in a request body, and never returned to the client. |

## Quick start

### Local development

Requires **Node ≥ 22.18** (the test suite runs on Node's native TypeScript support).

```bash
npm ci                 # the committed lock file is kept in sync — `npm ci` must keep working
npm run dev            # http://localhost:3000
```

The app starts with **no credentials and no engine**: the terminal renders, the scanner is empty, and
nothing can be traded until a Binance key is present. For a testnet run:

```bash
cp .env.example .env.local
# then set, at minimum:
#   BINANCE_API_KEY / BINANCE_API_SECRET   (testnet keys)
#   TM_OPERATOR_TOKEN=$(openssl rand -hex 32)
#   BINANCE_TESTNET=true
npm run dev
```

### Production

```bash
npm run build
npm run lint && npm test          # both are also run by the Docker build
node .next/standalone/server.js   # PORT / HOSTNAME env vars are honoured
```

Docker (multi-stage, `output: 'standalone'`, non-root user, secrets injected at deploy time):

```bash
docker build -t trade-master .
docker run -p 8080:8080 \
  -e TM_OPERATOR_TOKEN="$(openssl rand -hex 32)" \
  -e BINANCE_TESTNET=true \
  -e TRADE_MAX_MARGIN_USDT=25 \
  trade-master
```

Cloud Run walkthrough, hardening checklist and the go-live verification probes live in
[`DEPLOYMENT.md`](DEPLOYMENT.md).

## Configuration

All configuration is environment-only (no settings file, no database). Defaults are deliberately the
safest values; every cap is **tightened**, never loosened, by what you set here.

### Credentials and access

| Variable | Default | Purpose |
|---|---|---|
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | — | Server-side keys. Preferred: keys never touch a browser, and the unattended engine needs them. |
| `BINANCE_TESTNET` | `true` | `false` targets **mainnet (real money)**. |
| `TM_OPERATOR_TOKEN` | — | **Required** whenever server Binance keys are set. 32+ random chars (`openssl rand -hex 32`). |
| `TM_OPERATOR_AUTH` | `auto` | `auto` = require sign-in when server keys exist · `on` = always · `off` = never (only behind platform auth such as IAP/IAM/VPN). |

### Risk policy

| Variable | Default | Meaning |
|---|---|---|
| `TRADE_MIN_LEVERAGE` / `TRADE_MAX_LEVERAGE` | `10` / `15` | Permitted leverage band. |
| `TRADE_MAX_MARGIN_USDT` | `25` | Maximum margin per position. |
| `TRADE_MAX_NOTIONAL_USDT` | `500` | Maximum committed notional. |
| `TRADE_MAX_OPEN_POSITIONS` | `5` | Concurrent positions. |
| `TRADE_MAX_DAILY_LOSS_USDT` | `50` | Realized loss that locks entries for the UTC day (`0` disables). |
| `TRADE_SYMBOL_ALLOWLIST` | *(empty = whole market)* | Comma-separated. Set it to restrict both the scanner and the executor to those pairs; leave it empty to let discovery rank the market. |
| `TRADE_MAX_NOTIONAL_DEVIATION_RATIO` | `1.5` | Refuse rather than silently inflate size when lot rounding changes notional. |
| `TRADE_MIN_STOP_DISTANCE_PCT` | `0.0005` | Minimum stop distance (5 bp). |
| `TRADE_HALT` | `false` | Kill switch for new entries. |
| `TRADE_ALLOW_MAINNET` | `false` | Hard gate for real-money orders. |

### Universe, volatility band and chop filter

| Variable | Default | Meaning |
|---|---|---|
| `TRADE_DISCOVERY_ENABLED` | `true` | Rank the whole USDT-M market each scan. `false` = the built-in 12 majors, enforced at the order layer too. |
| `TRADE_DISCOVERY_TOP_N` | `40` | How many of the most volatile liquid pairs the opportunity board keeps. |
| `TRADE_DISCOVERY_MIN_QUOTE_VOLUME` | `50000000` | 24h quote-volume floor (USDT). |
| `TRADE_DISCOVERY_TTL_MS` | `60000` | How long a market ranking is reused before it is rebuilt. |
| `TRADE_SCAN_TOP_N` | `12` | Shortlist size per cycle (used when the opportunity list is off). |
| `TRADE_OPPORTUNITY_ENABLED` | `true` | Keep a promoted opportunity list, scanned every cycle. `false` = rebuild a shortlist from the ranking each cycle. |
| `TRADE_OPPORTUNITY_MAX` | `20` | Maximum opportunity assets held, and therefore deep-scanned per cycle. Clamped by `TRADE_MAX_OPEN_POSITIONS × 4` (the per-cycle weight budget). |
| `TRADE_OPPORTUNITY_STRIKES` | `2` | Consecutive failed passes before a pair leaves the list (`1` = evict on the first bad reading). |
| `TRADE_OPPORTUNITY_COOLDOWN_MS` | `300000` | How long a removed pair is barred from re-promotion. |
| `TRADE_MIN_VOLATILITY_PCT` | `0.6` | Chop floor: below this a pair is quiet/dead and is skipped. |
| `TRADE_MAX_VOLATILITY_PCT` | `4` | Blow-off ceiling: above this a pair is skipped rather than traded at reduced size. |
| `TRADE_CHOP_ADX_FLOOR` | `20` | ADX below this counts as "no trend" (needs the efficiency ratio to agree). |
| `TRADE_CHOP_EFFICIENCY_FLOOR` | `0.3` | Kaufman efficiency ratio below this counts as "going nowhere". |

### Server-side engine (unattended operation)

| Variable | Default | Meaning |
|---|---|---|
| `TRADE_ENGINE_ENABLED` | `false` | Boot the guardian loop with the server. Off = browser-driven only. |
| `TRADE_ENGINE_AUTO_ENTRY` | `false` | `false` = guardian only (protects, never opens). Also switchable in the UI. |
| `TRADE_ENGINE_ENFORCE_BRACKETS` | `true` | Verify a live `STOP_MARKET` exists for every owned position. |
| `TRADE_ENGINE_INTERVAL_MS` | `15000` | Cycle interval (minimum 5000). |
| `TRADE_ENGINE_UNPROTECTED_TOLERANCE` | `2` | Failed re-arm cycles before the position is closed to cap loss. |
| `TRADE_ENGINE_LEVERAGE` / `TRADE_ENGINE_BASE_MARGIN` / `TRADE_ENGINE_COMPOUNDING_PCT` | `10` / `2` / `20` | Server-side entry sizing (still bounded by the risk policy). |
| `TRADE_DATA_DIR` | `<cwd>/.data` | Where the durable ledger is written. On a container this must point at a mounted volume or it dies with the instance. |

## API reference

Every mutating call requires the `X-TM-Request: 1` header and a same-origin `Origin`. “Operator”
means the signed operator session is required when `TM_OPERATOR_AUTH` says so.

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/operator/status` | GET | public | Is a session required, is it configured, am I signed in |
| `/api/operator/login` | POST | CSRF | Exchange `TM_OPERATOR_TOKEN` for a 12 h httpOnly cookie (throttled) |
| `/api/operator/logout` | POST | CSRF | Drop the operator cookie |
| `/api/binance/credentials` | POST | operator + CSRF | Verify keys and open an 8 h credential session (server memory only) |
| `/api/binance/credentials` | GET | operator | Session state, key hint and the effective risk policy |
| `/api/binance/credentials` | DELETE | operator + CSRF | Revoke the credential session |
| `/api/binance/test-connection` | POST | operator + CSRF | Ping, auth check and policy report |
| `/api/binance/sync-account` | POST | operator + CSRF | Authoritative balance, positions and income snapshot |
| `/api/binance/scan` | GET | operator | Market scan (`?pairs=`, `?safetyCap=`) |
| `/api/binance/execute` | POST | operator + CSRF | `{action:"OPEN"\|"CLOSE", ...}` → the only order path |
| `/api/engine/status` | GET | operator | Loop state, ledger, policy, recent events |
| `/api/engine/control` | POST | operator + CSRF | `start` · `stop` · `halt-entries` · `resume-entries` · `flatten-all` (needs `confirm:"FLATTEN"`) · `set-auto-entry` |
| `/api/engine/track` | POST / DELETE | operator + CSRF | Register/unregister a UI-opened position with the guardian |
| `/api/network/ip` | GET | operator | Verified egress IPv4 for the Binance key whitelist (never guesses) |
| `/api/config/check` | GET | operator | **Deployment self-diagnosis**: verdict, both-host reachability, why a key is or is not active, and an explicit fix list |

**Request examples**

```bash
# 0. is a session needed?
curl -s https://<service>/api/operator/status | jq

# 1. sign in once; the cookie jar keeps the session
curl -s -c /tmp/tm.jar -X POST https://<service>/api/operator/login \
  -H 'Content-Type: application/json' -H 'X-TM-Request: 1' \
  -d '{"token":"<TM_OPERATOR_TOKEN>"}' | jq '{success, expiresAt}'

# 2. an oversized request must still be refused by the server policy (it never reaches Binance)
curl -s -b /tmp/tm.jar -X POST https://<service>/api/binance/execute \
  -H 'Content-Type: application/json' -H 'X-TM-Request: 1' \
  -d '{"action":"OPEN","symbol":"BTCUSDT","side":"LONG","margin":99999,"leverage":50,"price":111000,"stopLoss":110000,"takeProfit":113000}' | jq '.code, .violations[].code'
# → 409 POLICY_BLOCKED  [MARGIN_TOO_LARGE, LEVERAGE_OUT_OF_RANGE, NOTIONAL_TOO_LARGE]
```

**Something not working? Ask the deployment:**

```bash
curl -s -b /tmp/tm.jar -H 'X-TM-Request: 1' https://<service>/api/config/check | jq '{verdict, headline, targetNetwork, issues}'
```

One call returns the verdict (`READY_TESTNET`, `READY_MAINNET`, `LOCKED_OPERATOR_TOKEN_MISSING`,
`NO_CREDENTIALS`, `CREDENTIALS_REJECTED`, `GEO_BLOCKED`, `BINANCE_UNREACHABLE`, `MAINNET_LOCKED`),
a reachability report for **both** Binance hosts, whether the credentials actually resolved, and an
actionable list of blockers/warnings — including the two that catch most people: an unset
`BINANCE_TESTNET` (which silently means *testnet*) and a missing `TM_OPERATOR_TOKEN`.

Representative refusal codes: `OPERATOR_AUTH_REQUIRED`, `OPERATOR_AUTH_NOT_CONFIGURED`,
`POLICY_BLOCKED`, `MAINNET_DISABLED`, `TRADE_HALTED`, `DAILY_LOSS_BREAKER`, `DAILY_LOSS_UNKNOWN`,
`SYMBOL_ALREADY_OPEN`, `SYMBOL_NOT_ALLOWED`, `HEDGE_MODE_UNSUPPORTED`, `SPEC_UNKNOWN`, `DEVIATION_TOO_LARGE`,
`BRACKET_INVALID`, `STOP_LOSS_UNAVAILABLE`, `ORDER_NOT_FILLED`, `DUPLICATE_ORDER`, `INSUFFICIENT_AVAILABLE_BALANCE`.

## Testing and verification

```bash
npm run lint          # eslint (also enforced during `next build`)
npx tsc --noEmit      # strict type-check
npm test              # 179 tests, 15 files, node:test + native TypeScript
```

The suite covers the parts that lose money if they are wrong:

- **Binance client wire format** — a signed GET carries `timestamp`/`signature` on the query string
  (not in a body `fetch` would drop), the HMAC verifies against the payload as sent, order rejections
  keep Binance's code and never look like fills, and the daily-PnL read fails closed with `NaN`.
- **Cycle-failure policy** — first failure logged in full, identical repeats throttled, deterministic
  failures backing off, transient ones keeping the fast cadence.
- **Sizing** — `MIN_NOTIONAL` bumps, lot rounding, deviation refusal (the 5–10× over-size regression),
  unknown-symbol refusal, tick-aligned prices, malformed-bracket refusal.
- **Risk policy** — leverage/margin/notional caps, symbol allowlist, position cap, mainnet gate,
  kill switch, fail-closed daily-loss breaker.
- **Execution guards** — operator-cookie signing/verification/tamper, fail-closed auth, CSRF origin
  checks, credentials never resolving from a request body, idempotency claims, safe client order ids.
- **Guardian decisions** — stop detection, re-arm/adopt/flatten escalation, breach detection, exit
  classification, entry gate.
- **Ledger** — compounding ladder, UTC-day PnL rollover, persistence round-trip, network mismatch.
- **Strategy math** — HVN/POC/value area, absorption, imbalance, ATR, signal scoring, rate limiting.
- **Market regime** — ADX on trends vs oscillations (including the degenerate "goes nowhere scores as a
  maximal trend" case), efficiency ratio, realised volatility, band edges, percentile ranks, and that a
  still-forming candle can never decide the regime.
- **Market discovery** — contract/liquidity filtering, most-volatile-first ranking, allowlist
  override, board caching, stale-board and fallback behaviour when the exchange is unreachable.
- **The scan funnel** — shortlist selection, chop/band refusals with their reasons, volatility
  percentile ranks, and that the best score wins over the most volatile pair.
- **The opportunity list** — promotion most-volatile-first, the screening band, displacement with its
  anti-churn margin, board-drop and band-exit removals, strike-based eviction of chop/band/no-data
  failures, the removal cooldown, and that a fallback board carries the list over instead of wiping
  it.

Verified state of this revision: `tsc` clean · `eslint` clean · **179/179 tests** · production build
clean (15 routes) · live route probes (anonymous money calls answer **401**, oversized requests
answer **409 POLICY_BLOCKED**, unreachable exchange answers **502 NETWORK_UNREACHABLE** with the
remedy rather than a bogus credential rejection). Live audit history and the honest list of what has *not* been proven
are in [`AUDIT-LIVE-TRADING.md`](AUDIT-LIVE-TRADING.md).

## Project structure

```
app/
  page.tsx                  terminal UI: scan loop, position monitor, operator gate
  layout.tsx  not-found.tsx  globals.css
  api/
    operator/               sign-in / sign-out / session status
    binance/                credentials, execute, scan, sync-account, test-connection
    engine/                 control, status, track
    network/ip              verified egress IPv4
components/                 dashboard panels (positions, engine, KPIs, charts, history, logs, settings)
lib/
  order-executor.ts         the single order path: sizing, brackets, reconciliation
  binance-client.ts         signed REST client (timeouts, typed errors)
  exchange-specs.ts         exchange filters + pure sizing / tick alignment
  risk-policy.ts            server-side caps, daily-loss gate, position-mode rules
  operator-auth.ts          operator cookie: signing, verification, throttling
  binance-errors.ts         failure classifier: geo-block / IP / key / transport, with remedies
  config-check.ts           pure deployment diagnosis behind GET /api/config/check
  trade-guard.ts            CSRF guard, credential resolution, idempotency
  engine.ts                 unattended guardian loop
  guardian.ts               pure guardian decisions (re-arm / adopt / flatten / breach)
  position-ledger.ts        durable JSON ledger (atomic writes)
  market-scanner.ts         market-wide discovery: ranks every liquid perp by volatility
  opportunity-list.ts       the opportunity list: promotion, pruning, churn control (pure)
  opportunity-store.ts      durable opportunity list (atomic JSON under TRADE_DATA_DIR)
  market-data.ts            the scan funnel: opportunity list, regime gate, best-score selection
  market-regime.ts          ADX, efficiency ratio, volatility band + percentile ranks (pure)
  trading-engine.ts         indicators, TP/SL, compounding, rate-limit shield
instrumentation.ts          boots the engine when TRADE_ENGINE_ENABLED=true
Dockerfile  next.config.ts  package.json  .env.example
DEPLOYMENT.md  AUDIT-LIVE-TRADING.md
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Any money endpoint answers `503 OPERATOR_AUTH_NOT_CONFIGURED` | Server Binance keys are set but `TM_OPERATOR_TOKEN` is missing/short. Set it and redeploy. |
| `401 OPERATOR_AUTH_REQUIRED` | Not signed in (or the 12 h cookie expired). Sign in with the operator token. |
| `401 NO_SESSION` | No Binance credential session. Add keys via Settings, or set `BINANCE_API_KEY`/`BINANCE_API_SECRET` server-side. |
| `409 MAINNET_DISABLED` | Mainnet orders are locked. Set `TRADE_ALLOW_MAINNET=true` only after a clean testnet run. |
| Key is verified but the badge says **TESTNET · PAPER FUNDS** | `BINANCE_TESTNET` is unset (or `true`), so the deployment targets testnet on purpose — real mainnet keys are rejected there with `-2015`. Set `BINANCE_TESTNET=false` (and `TRADE_ALLOW_MAINNET=true`) for real money. Run `/api/config/check` to see this called out as `TESTNET_FLAG_UNSET`. |
| `KEY_NETWORK_MISMATCH` | The keys belong to the other network: testnet needs keys from `testnet.binancefuture.com`, mainnet needs mainnet keys. |
| `GEO_BLOCKED` (HTTP 451) | Binance refuses this server's location *before* authentication. Move the deployment to a permitted region — no key or permission change helps. |
| `IP_NOT_ALLOWED` | The key's IP restriction does not include the server's egress IP. Add it (see `/api/network/ip`) or clear the restriction. |
| `REQUEST_INVALID` (e.g. `Mandatory parameter 'timestamp' was not sent`) | Binance rejected the request *before* judging the key: a required parameter never arrived (the app's bug), not a credential problem. Retrying unchanged will keep failing — report the raw message. |
| Engine panel keeps showing the same `CYCLE_FAILED` | Each failure is classified (key, IP allowlist, geo-block, malformed request, network) and the panel shows the diagnosis, the remedy and how many cycles it has repeated. A first line is logged in full; an identical repeat is logged every 20th cycle instead of every cycle, and failures no retry can fix back off to a 2-minute poll — the loop never stops retrying, so a fix made in Binance is picked up on its own. |
| `TIMESTAMP_DRIFT` / `SIGNATURE_INVALID` | Host clock skew >1s (enable NTP) / the secret does not match the key (re-copy or regenerate). |
| `BINANCE_UNREACHABLE` / `TIMEOUT` | Egress/DNS problem: no credential would work. Check outbound HTTPS, then `/api/config/check` reachability. |
| The opportunity list keeps shrinking | Each removal carries its reason in the scanner strip and the engine log: `not-on-board` (fell out of the liquid set), `vol-below-floor`/`vol-above-ceiling` (moved out of the band), `choppy` (struck off after `TRADE_OPPORTUNITY_STRIKES` failed passes). Raise `TRADE_OPPORTUNITY_MAX` or widen the band if the list never fills. |
| The opportunity list never fills to `TRADE_OPPORTUNITY_MAX` | The list is clamped by the per-cycle weight budget (`TRADE_MAX_OPEN_POSITIONS × 4`). Raise `TRADE_MAX_OPEN_POSITIONS`, or accept the clamp — `/api/config/check` reports it as `OPPORTUNITY_BUDGET_LIMITED`. |
| Same pairs stay on the list too long | `TRADE_OPPORTUNITY_STRIKES=1` evicts on the first bad reading, `TRADE_OPPORTUNITY_COOLDOWN_MS` controls how long a removed pair stays out, and `TRADE_OPPORTUNITY_ENABLED=false` goes back to rebuilding a shortlist every cycle. |
| Scanner finds pairs but never trades | Read the scan line: each refused pair is listed with its reason — `choppy` (ADX and efficiency ratio both say the market is going nowhere), `vol-below-floor` (quiet/dead pair), `vol-above-ceiling` (too violent for an ATR-sized stop). Widen the band or lower `TRADE_CHOP_*` only if you understand what those gates are protecting. |
| `UNIVERSE_MARKET_WIDE` in `/api/config/check` | Not an error: it states that entries are bounded by the scan funnel rather than by a symbol list. Set `TRADE_SYMBOL_ALLOWLIST` to narrow the bot to named pairs. |
| `UNIVERSE_FIXED_LIST` in `/api/config/check` | `TRADE_DISCOVERY_ENABLED=false`: only the built-in 12 majors are scanned, so a more volatile pair listed elsewhere is invisible. |
| `VOLATILITY_BAND_EMPTY` (blocker) | `TRADE_MIN_VOLATILITY_PCT` is not below `TRADE_MAX_VOLATILITY_PCT`, so every pair is refused and no entry can ever be taken. |
| `409 POLICY_BLOCKED` | The request violated a server cap (leverage, margin, notional, symbol, position count) — see `violations[]`. |
| `409 DAILY_LOSS_UNKNOWN` | The daily PnL could not be read from Binance; entries stay locked until the exchange answers (deliberately fail-closed). |
| `409 HEDGE_MODE_UNSUPPORTED` | The account is in Hedge Mode; switch it to One-Way Mode in Binance. |
| `422 SPEC_UNKNOWN` | `exchangeInfo` was unreachable, so filters/tick sizes are unknown. The bot refuses to guess; retry. |
| `422 DEVIATION_TOO_LARGE` | The smallest legal position for that pair is materially larger than requested. Raise the margin or drop the pair. |
| `502 STOP_LOSS_UNAVAILABLE` | The stop was rejected; the position was flattened. Check the Binance API permissions (Futures enabled) and margin type. |
| Engine panel says "NOT RUNNING" / Start is disabled | `TRADE_ENGINE_ENABLED=true` and server keys are both required. The button's tooltip says which is missing. |
| Engine reports `ledgerDurable: false` | `TRADE_DATA_DIR` is not on a mounted volume — the ledger dies with the instance. |
| Page renders but every panel is empty with a sign-in wall | Expected: the operator gate is active because server keys are configured. |
| `npm ci` fails with `EUSAGE` | `package-lock.json` drifted from `package.json`. Run `npm install` and commit the lock file. |

## Known limitations

Stated plainly, because they matter more than the feature list:

- **No backtest, no track record.** The strategy is unvalidated. Testnet results are the only
  evidence that exists so far.
- **Two books.** The browser keeps its own history and compounding ladder in `localStorage`, using a
  flat 0.1 % fee estimate; the engine keeps a durable ledger settled from Binance income (real
  commission + funding). While the engine is running it is treated as the book of record and the
  browser deliberately does not re-book its trades — so expect the engine panel, not the browser
  KPIs, to be authoritative in that mode.
- **The browser monitor is a fallback**, not the primary protection: it acts on the latest candle
  close from the most recent scan (up to ~15 s old). Real protection is the `STOP_MARKET` order on
  Binance plus the guardian loop.
- **Volatility gates are heuristic, not proven.** The band (0.6 %–4 %) and the chop thresholds
  (ADX 20 / ER 0.3) are reasoned defaults, not backtested optima: no backtest exists to tune them, so
  they should be revisited against testnet results rather than trusted as calibrated.
- **The upper volatility band is skipped, not sized down.** A pair above `TRADE_MAX_VOLATILITY_PCT`
  is reported and refused; leverage and stop distance stay uniform across everything else. That is a
  deliberate choice (see "skip only" in `AUDIT-LIVE-TRADING.md` round 6), not an oversight.
- **The list is a cache, not a guarantee.** It is one JSON file under `TRADE_DATA_DIR`; on an
  ephemeral filesystem it survives the process but not a redeploy (the engine logs
  `OPPORTUNITY_NOT_DURABLE` when it cannot write it), and the next market scan rebuilds it.
- **Two processes, one list.** The engine and the browser scan route share that file. Running two
  engine replicas against the same volume would have them both reconciling it — the same caveat as
  the trade ledger, and the reason the deployment guidance is one replica.
- **"Faster" means focused, not sub-second.** One market-wide ranking call plus a bounded shortlist is
  cheaper than scanning everything, but a full re-scan still costs one kline request per shortlisted
  pair; genuinely fast reaction would need websocket mark-price streams, which this app does not use.
- **No alerting.** Nobody is paged if a position goes unprotected or the process dies.
- **No multi-user support.** One operator, one Binance account per deployment.
- **Session and idempotency maps are per process**, so browser-credential deployments must run a
  single instance (`--max-instances=1`); env-key deployments are stateless.
- **Exchange-facing behaviour is not unit-testable.** Whether Binance accepts a given bracket
  (`timeInForce` on `STOP_MARKET` with `closePosition=true`) can only be proven by a live testnet run.
  The error classifier is unit-tested against Binance's documented responses; the live paths it
  depends on (a real 451, a real `-2015` allowlist rejection) have not been observed from this repo.
- **Unproven under load.** Rate-limit backoff and cooldown paths are implemented but have not been
  exercised against a sustained Binance weight limit in production.

## Documentation index

| Document | Contents |
|---|---|
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Build prerequisites, Cloud Run deploy, key hygiene, mainnet checklist, emergency controls, engine setup, go-live verification probes |
| [`AUDIT-LIVE-TRADING.md`](AUDIT-LIVE-TRADING.md) | Full audit history: every finding, its fix and the proof — including what remains unproven |
| [`.env.example`](.env.example) | Annotated environment reference |

---

Futures trading involves substantial risk of loss. This software is provided as-is, without
warranty, and is not financial advice — you are responsible for every order it places.
