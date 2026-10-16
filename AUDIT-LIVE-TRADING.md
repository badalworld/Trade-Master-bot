# Pre-Live Audit — Trade Master (Binance Futures Bot)

**Date:** 2026-10-16 · **Branch:** `arena/97c3f97b-trade-master-bot` @ `8579160`
**Audit verdict:** ❌ NOT CLEARED for live trading with real funds.
**Remediation status:** ✅ all 5 blockers + 4 high-severity items fixed in code, verified by 23 new
unit tests and live endpoint probes. **Still not cleared for real money** — the strategy itself has
no backtest and no track record, so it must earn that on testnet first.

The app builds clean and the strategy math is well-tested, but the order-execution path has
nine defects that can lose real money — two of which can leave an **unprotected leveraged
position on the exchange with no stop-loss and no monitoring process**. Fix the BLOCKER tier
before funding an account.

---

## What was actually run

| Check | Result |
|---|---|
| `npm install` | ✅ 948 packages, clean |
| `npx tsc --noEmit` | ✅ 0 errors |
| `npm run lint` | ✅ 0 errors |
| `node --test lib/trading-engine.test.ts` | ✅ **7/7 pass** (indicators, compounding, rate shield, micro-cap precision) |
| `npm run build` | ✅ compiles in 10.7s, `output: standalone`, 9 routes |
| `next start` + page render | ✅ HTTP 200, 54 KB, UI mounts |
| `/api/binance/execute` input validation | ✅ 400s correctly on missing key / symbol / price |
| Live vs. Binance (mainnet + testnet) | ⚠️ **untestable here** — sandbox egress is allowlisted; both returned `HTTP 000` |

**Consequence:** no order was ever placed against a real exchange in this audit, and there is
no backtest in the repo. "It builds and the unit tests pass" says nothing about whether the
strategy is profitable. Treat the strategy itself as **unvalidated (0 closed trades of history)**.

---

## ✅ Remediation applied (same day)

| ID | Fix | Where | Proof |
|---|---|---|---|
| **B1** | Stop-loss is now mandatory: a rejected `STOP_MARKET` triggers an immediate `reduceOnly` flatten and returns `success:false`. TP failure is reported as a warning, never hidden. Unknown tick sizes are refused instead of guessed (`SPEC_UNKNOWN`). | `app/api/binance/execute/route.ts`, `lib/exchange-specs.ts` | 3 tests incl. "a symbol with no exchange filters is never sized on guesses" |
| **B2** | `MIN_NOTIONAL`/`maxQty` read from `exchangeInfo`; size derived from the *rounded* qty; if the smallest legal position deviates >1.5× the order is **rejected** instead of silently over-sized. `effectiveNotional`/`effectiveMargin` are returned and booked. | `lib/exchange-specs.ts:computeOrderQuantity`, `app/page.tsx` | BTC @$20→$111 and SOL @$20→$210 now both return `DEVIATION_TOO_LARGE` with `minLegalNotional` |
| **B3** | Keys removed from the client entirely: never in `localStorage`, never in a request body (bodies containing them are rejected). Resolved from env or an 8h httpOnly `SameSite=Lax` session. Origin/`X-TM-Request` CSRF check on every mutating route. Legacy keys left in browser storage are scrubbed with a rotate warning. | `lib/trade-guard.ts`, `app/api/binance/credentials/route.ts`, all routes | `curl` with keys in body → `400 CREDENTIALS_IN_BODY`; no session → `401 NO_SESSION`; cross-origin → `403` |
| **B4** | Server-side caps enforced *before* any exchange call: leverage 10–15, margin, notional, position count, symbol allowlist, `TRADE_HALT` kill switch, and a daily-loss breaker computed from Binance `/fapi/v1/income` (immune to cleared browser state). | `lib/risk-policy.ts`, execute route | `margin:99999, leverage:50` → `409 POLICY_BLOCKED` with 3 violations (was: submitted as a $4.99M order) |
| **B5** | Testnet is now the default, a real toggle exists in Settings, and mainnet needs both a typed `I UNDERSTAND` **and** `TRADE_ALLOW_MAINNET=true`. | `app/page.tsx:43`, `components/SettingsView.tsx`, `lib/risk-policy.ts` | mainnet request with the flag off → `409 MAINNET_DISABLED` |
| **H1** | `scanInFlightRef` re-entrancy lock + per-signal dedupe + server-side idempotency claim + `newClientOrderId`, plus a **live** `SYMBOL_ALREADY_OPEN` check read from the exchange rather than React state. | `app/page.tsx`, `lib/trade-guard.ts` | — |
| **H2** | Entry must come back `FILLED` with `executedQty > 0` (re-queried once via `GET /fapi/v1/order`) or the trade is failed and brackets are not placed. | `app/api/binance/execute/route.ts` | — |
| **H3** | Closes use the exchange's `positionRisk` size, verify a residual check afterwards, and report `noPosition` when the bracket already fired. A partial close refuses to drop local tracking. | execute route, `app/page.tsx:finalizePositionClose` | close path reaches `positionRisk` (confirmed in probe) |
| **H4** | Fabricated `34.87.142.92` removed. Returns `ipv4: null, verified: false` + explicit "do not whitelist an unverified address". | `app/api/network/ip/route.ts` | probe returns `ipv4=None verified=False` |
| new | Ambiguous failures (timeout *after* submission) reconcile against the exchange and, if a position exists with no stop, attach one — reporting `RECOVERED_STOP_ATTACHED` or `UNPROTECTED_POSITION`. Positions found on Binance but absent from the browser are **adopted** with a `FROM BINANCE` badge; positions with no recorded stop show `NO STOP RECORDED`. | execute route catch path, `app/page.tsx`, `ActivePositions.tsx` | — |
| gates | `eslint.ignoreDuringBuilds` → false (build now lints + type-checks + runs tests), `test` script added, security headers added, `.env.example` documents the policy. | `next.config.ts`, `package.json`, `Dockerfile` | build output shows "Linting and checking validity of types" |

**Verification after the fix:** `tsc --noEmit` 0 errors · `eslint .` 0 errors 0 warnings ·
`node --test lib/*.test.ts` **23/23** · `next build` succeeds with lint+types enforced ·
`next start` renders the terminal (HTTP 200) with `TESTNET · PAPER FUNDS` as the default badge.

**Not fixed (needs a decision, not a patch):** the strategy has no backtest and the trading loop
still lives in a browser tab — unattended operation requires moving scan/monitor/ledger into a
server-side worker with persistent storage. See `DEPLOYMENT.md` §5.

## Original findings


### B1. Stop-loss failure is swallowed → naked leveraged position
`app/api/binance/execute/route.ts:328-334`

```ts
if (slRes.ok) { slOrderId = slData.orderId; }   // no else — rejection is invisible
} catch { /* Fallback: frontend dynamic TP/SL monitor remains active */ }
```

If the `STOP_MARKET` order is rejected for *any* reason (tick-size precision `-1111`, min
notional, `-4046` margin type, insufficient free margin), the route still returns
`success: true` and the UI logs `LIVE BINANCE ORDER EXECUTED`. The only remaining protection is
the **browser-side 2-second polling loop** in `app/page.tsx`. That loop dies the instant the tab
closes, the phone locks, the laptop sleeps, or the page reloads.

This is reachable by design: `getSymbolSpec` caches `exchangeInfo` for 10 min behind a 3 s
timeout, and any symbol not in the hardcoded table falls back to `tickSize: 0.0001`
(`route.ts:69-74`) — which for most pairs produces a `stopPrice` Binance rejects for precision.
Highest-probability failure path, exactly under rate-limit/network stress.

**Fix:** make a missing SL a hard failure — place entry *without* `closePosition` TP/SL first,
verify both, and if the SL is not confirmed, immediately flatten with `reduceOnly` and return
`success: false`.

### B2. Position size is silently 5.5×–10.5× larger than the configured margin
`app/api/binance/execute/route.ts:266-268` — `rawQty = Math.max(spec.minQty, notional / entryPrice)`

Measured with the repo's own `formatByStep` and its own fallback specs:

| Symbol | Margin×Lev | Target notional | Qty sent | **Actual notional** | Error |
|---|---|---|---|---|---|
| BTCUSDT @ $111k | $2 × 10 | $20 | 0.001 | **$111.00** | **5.5× over** |
| BTCUSDT @ $111k | $2 × 15 | $30 | 0.001 | **$111.00** | **3.7× over** |
| SOLUSDT @ $210 | $2 × 10 | $20 | 1 | **$210.00** | **10.5× over** |
| SOLUSDT @ $210 | $2 × 15 | $30 | 1 | **$210.00** | **7.0× over** |
| ETHUSDT / DOGEUSDT / ADAUSDT / XRPUSDT | $2 × 10–15 | $20–30 | ok | $16.8–30 | ✅ within lot rounding |

Two separate failure modes: on big-priced pairs the exchange `LOT_SIZE` floor silently **inflates
risk 5–10×**, while on small-priced pairs `$20` notional is below Binance's `$100 MIN_NOTIONAL`
filter, so the order is **rejected and the bot silently does nothing**. Neither is modeled.
The `MIN_NOTIONAL` filter is never read from `exchangeInfo` — only `LOT_SIZE` and `PRICE_FILTER`
are (`route.ts:44-46`).

Meanwhile the ledger still books `margin: $2.00`, so every displayed PnL %, win rate, and the
whole compounding ladder is computed against a position size that isn't real.

**Fix:** read `MIN_NOTIONAL`; compute `qty = max(minQty, ceil_to_step(notional/price))`, then
**recompute the effective notional from the rounded qty and trade that** — or reject if it
deviates >10 % from intent. Feed the effective notional back into the position record.

### B3. Binance API key + secret live in the browser
`app/page.tsx:279` writes `settings` — including `apiKey` and `apiSecret` — to `localStorage`
in plaintext; restored at `:189`; re-sent in the POST body on every execute (`:601`, `:841`) and
every 30 s account sync (`:318`).

Verified absent: `middleware.ts`, any session/auth check, CSRF protection, and security headers
(`next.config.ts` has none). So the deployed app is: keys readable by any XSS in a 948-package
dependency tree → and an unauthenticated public `POST /api/binance/execute` that will submit
orders with whatever keys it is handed.

**Fix:** keys must be server-side only (secret manager / env), never accepted from the client
body. Add `middleware.ts` auth on all `/api/binance/*` routes plus an order-placement allowlist.

### B4. No server-side risk cap and no kill switch
`route.ts:214-215` — `clampedLeverage = Math.min(50, …)`, `safeMargin = Math.max(1.0, …)`.
The UI clamps 10–15×, but **the API accepts up to 50× and any margin**. There is no max-notional
cap, no daily-loss limit, no per-symbol whitelist, no global halt. A single bad request or a
bug in the loop can size a position 1000× the plan.

**Fix:** enforce the policy in the route (reject `leverage > 15`, `margin > maxMargin`, unknown
symbols, `notional > maxNotional`), and keep a server-side daily realized-loss breaker.

### B5. There is no testnet / paper mode you can turn on
`app/page.tsx:43` — `isTestnet: false`. `SettingsView.tsx` declares `isTestnet` in the
`BotSettings` interface (line 22) and **renders no control for it** — grep confirms that is the
only occurrence in the file. The settings panel banner reads
`REAL LIVE PRODUCTION (0% SIMULATION)`.

So the only way to "test" this is to fund it with real money — which is what was being asked for.

**Fix:** add the testnet toggle to the UI, and make **testnet the default** so mainnet requires a
deliberate opt-in (plus a typed confirmation).

---

## 🟠 HIGH

**H1. Double-order race — `app/page.tsx:536`.** `runMarketScan` sets `isScanning` but never
bails on it, closes over a stale `positions` snapshot, and opens have no in-flight lock (closes
have `closingIdsRef`; opens have nothing). No `newClientOrderId` → no idempotency. `handleStartBot`
fires a scan *and* starts the interval, so overlapping cycles can submit two live entries on the
same symbol; `setPositions` dedupes the *local* list only, after the order is already live — the
second is an **orphan position with no local monitor**.

**H2. Fill never verified — `route.ts:369,379`.** `orderData.status` is returned but no caller
checks it; `parseFloat(avgPrice) || entryPrice` silently books an unfilled/expired/partial order
as a position filled at the intended price.

**H3. Close can leave an unprotected residual — `app/page.tsx:440-455`.** `finalizePositionClose`
cancels **all** open orders for the symbol (including the exchange TP/SL), then sends
`reduceOnly` for the *local* `pos.quantity`. If the live size differs (see B2) the protection is
removed and the remainder is left open with no stop.

**H4. Fabricated egress IP for Binance IP-whitelisting — `app/api/network/ip/route.ts:70`.**
Falls back to the hardcoded `'34.87.142.92'` and `SettingsView.tsx:255-262` presents it as
"Binance API Trusted Egress IPv4". Reproduced: the route returns that IP with `source: "gateway"`
and no warning. Advising a user to whitelist an address they may not own is a security footgun —
it must return `unknown` and fail loudly.

---

## 🟡 QUALITY / OPERATIONAL

- **The "bot" is a browser tab.** TP/SL monitoring, position state, and trade history all live in
  client React + `localStorage`. Nothing trades — and *nothing protects open positions* — with no
  tab open. `next start` holds no state, so a deployed URL alone does not run the strategy.
- **Ledger is per-browser.** Clear site data and history/compounding are gone while the real
  positions stay open on Binance. No server-side persistence, no reconciliation on startup.
- **Cost model is optimistic:** flat 0.10 % round-trip (`app/page.tsx:464`); funding payments and
  slippage are ignored, so reported net PnL overstates reality on leveraged scalps.
- **Scan failure is silent (but fails safe):** with Binance unreachable the route returns
  `200 {signals: []}` — verified. Indistinguishable from "no setup found".
- **Build gates off:** `next.config.ts` `eslint.ignoreDuringBuilds: true` (build printed
  "Skipping linting"). No `test` script in `package.json` despite a test file existing.
- **Zero coverage on the money paths:** execute, sizing, close, and compounding persistence are
  untested; only pure indicator math is.
- **Repo hygiene:** `firebase-tools` in devDeps and `@google/genai` in deps are unused by the
  trading path; `current_view.png` (240 KB) and 13 `.aistudio/` scratch images are committed.
- `getSymbolSpec`'s `cachedExchangeSpecs` is module-global — shared across all users of one
  server instance (harmless today, but it is shared mutable state).

---

## Minimum gate before any real-money order

1. B1 — SL unconfirmed ⇒ auto-flatten + hard error (no silent success).
2. B2 — enforce `MIN_NOTIONAL`, size from the rounded qty, reject >10 % deviation.
3. B3 — keys server-side only; auth middleware on every `/api/binance/*` route.
4. B4 — server-side caps: `leverage ≤ 15`, `margin ≤ N`, symbol allowlist, daily loss breaker.
5. B5 — testnet toggle in UI, **default testnet**.
6. H1 — in-flight lock + `newClientOrderId` idempotency key.
7. H3 — close using the live position size from `positionRisk`, not the local number.
8. Re-run `tsc`/`lint`/`test`/`build`, then **≥ 2 weeks on Binance Testnet** with real
   `exchangeInfo`-derived sizing before mainnet.

## Deploy note

The app *is* deployable: build passes, `output: 'standalone'` is Cloud Run-ready. What is **not**
advisable is deploying this build to a public URL with mainnet keys wired to it, because that is
exactly the B3/B4 combination (unauthenticated public order endpoint, no risk caps). Deploying to
a private URL for UI testing only is fine.

---

# Phase 2 — unattended protection (added after the remediation commit)

Verdict item (e) in the summary said the loop lives in a browser tab: close the tab and the only
thing left between a leveraged position and a total loss is whatever conditional orders happen to be
sitting on Binance. That is an architectural property, so it was fixed architectically rather than
with another guard clause.

## What moved server-side

| File | Responsibility |
|---|---|
| `lib/order-executor.ts` | **All** money logic (sizing → order → brackets → fill reconciliation), no Next.js imports. `app/api/binance/execute` is now a ~80-line shell over it, and the engine calls the same functions. A route and a daemon that each re-implement order placement always drift; this removes the second implementation. |
| `lib/position-ledger.ts` | Durable trade ledger: atomic tmp+rename JSON under `TRADE_DATA_DIR`, network stamp, settlement + compounding via `calculateNextTradeMargin` (one compounding rule for UI and server). |
| `lib/guardian.ts` | Pure, testable safety decisions: is a stop live, re-arm vs adopt vs flatten, is the bracket breached, may we enter. No I/O, no `Date.now()` inside the decisions. |
| `lib/market-data.ts` | `scanUniverse` + `isActionableSignal` shared by the scan route and the engine, including the `1000PEPE`/`PEPE` retry and fail-closed tradeability. |
| `lib/engine.ts` | The loop: reconcile → protect → backstop → settle → (opt-in) enter. Singleton on `globalThis`. |
| `instrumentation.ts` | Boots the loop with the server; `SIGINT`/`SIGTERM` flush the ledger. |
| `app/api/engine/{status,control,track}` | Read state, operator controls (`flatten-all` needs `confirm:"FLATTEN"`), and the UI→engine ownership bridge. |
| `components/EngineStatusPanel.tsx` | Makes the invisible visible: running/idle, cycles, durability, owned vs foreign vs unprotected, event log, and the buttons. |

Defaults are deliberately inert: `TRADE_ENGINE_ENABLED=false`, `TRADE_ENGINE_AUTO_ENTRY=false`
(guardian-only: it can close and protect, never open), env credentials required, engine-side leverage
still hard-capped to the `TRADE_MIN/MAX_LEVERAGE` band. A default deploy behaves exactly as before.

## Defects found *while building* Phase 2 (all fixed, all with tests or runtime evidence)

1. **The guardian would have re-placed an existing stop every cycle.** The first draft looked for
   `status === 'STOP'` in `/fapi/v1/openOrders`, but futures conditional orders report `NEW` there.
   Nothing would ever match ⇒ a fresh `STOP_MARKET` appended each cycle. Fixed by filtering on
   type + exit side + non-terminal status, and pinned by a test that asserts `NEW` counts.
2. **Two engines in one process.** Next compiles `instrumentation.ts` into its own bundle, so the
   module-level `export const engine` existed twice: the loop was genuinely running while
   `/api/engine/status` reported `running:false` — and the second ledger copy would have overwritten
   the first's file with a stale snapshot. Fixed by hoisting the engine and ledger singletons onto
   `globalThis`. Verified live: after the fix the API reports the real `cycles`/`events` and
   `stop`/`start` through the control route affect the loop that is actually running.
3. **`specCache` was not keyed by network** (open item from Phase 1). Testnet filters could be reused
   for a mainnet order after a network flip. Cache is now `{testnet|mainnet}`-keyed (and shared across
   bundles via `globalThis`, for the same reason as #2).
4. **Engine entries were fail-open on tradeability**: `tradeable[symbol] !== false` accepts an absent
   key. Changed to `=== true`.
5. **`-1121` (invalid symbol) triggered a 60 s cooldown**, which would have paused *protection* for
   every other position because one bad symbol was configured. Removed from the cooldown triggers.
6. **Forced closes on uncertain state**: the escalation counter used to increment on any error, so a
   Binance outage or a missing local tick spec could end with the engine closing real positions. Now
   only an *answered* rejection (`BinanceApiError`) counts toward flatten; unreachable/unknown state
   logs `BRACKET_DEFERRED`, marks the position unprotected and retries — it never destroys.
7. **Double-brain accounting**: with the engine owning a symbol, the browser's 2 s monitor now stands
   down, and a close the engine already settled is dropped locally instead of being booked a second
   time with price-derived PnL.

## Runtime evidence gathered here

`TRADE_DATA_DIR` pointed at a real directory, dummy env credentials, a hand-seeded ledger containing
one owned `BTCUSDT LONG` with `slOrderId`, `TRADE_ENGINE_INTERVAL_MS=8000`, and **no egress to
Binance at all** (the sandbox allowlist blocks `testnet.binancefuture.com`) — i.e. a total API outage
with a leveraged position on the books, which is precisely when bad safety code does damage:

- `instrumentation` logged `STARTED … auto-entry OFF (default) · bracket enforcement ON` — it did not
  open anything.
- **27 consecutive failed cycles** (`CYCLE_FAILED … fetch failed`), and across all of them:
  `AUTO_FLATTEN` 0, `CLOSE_FAILED` 0, `TRADE_SETTLED` 0, `BRACKET_REARMED` 0. The position survived in
  the ledger with `unprotectedCycles: 0` — no escalation, no order spam.
- A stale `pnlDay` (`2000-01-01`) with `realizedPnlTodayUsdt: -999` reset to `0` on load, so the daily
  loss breaker cannot stay tripped forever by an old file.
- `GET /api/engine/status` with no `X-TM-Request` header → `403 ORIGIN_REJECTED`; with it → the live
  engine state (`running:true, cycles:5, credentialSource:"env", ledgerDurable:true`).
- `POST /api/engine/control` with a wrong `Origin` → 403 (CSRF guard shared with trading). With correct
  origin: `stop` → `running:false` + `STOPPED` event, `start` → `running:true` and cycles continuing
  from 7, `halt-entries` → `ENTRIES_HALTED`, `flatten-all` without `confirm` → `400 CONFIRM_REQUIRED`
  and the position untouched, unknown action → `UNKNOWN_ACTION`. No action ever reached the ledger file
  destructively.
- Gates on the final tree: `tsc --noEmit` 0 errors · `eslint` 0 problems · `node --test` **42/42**
  (19 of them new for guardian + ledger) · `next build` succeeds with the three `/api/engine/*` routes.

## Still not cleared for live money, and why nothing more in this repo can change that

1. **No exchange response has ever been parsed by this code.** Order acceptance, bracket rejection
   reasons, `MIN_NOTIONAL` behaviour, fill reconciliation and income-based settlement are all written
   against documented behaviour, not observed traffic.
2. **Soak time is the remaining requirement** — ≥ 2 weeks on testnet with roughly 100 reviewed fills,
   plus a deliberate "kill the tab mid-trade" drill and a "block the API for an hour" drill (the
   second one is what the log above demonstrates, at the code level only).
3. **Durability is deployment-dependent**: without a mounted volume `ledgerDurable:false` and the
   engine's ownership knowledge dies with the container (positions then become `foreign` — reported,
   not managed). Never enable `TRADE_ENGINE_AUTO_ENTRY` on an ephemeral filesystem.
4. **The strategy itself is unproven**: still no backtest and no closed-trade history. This is now a
   measurement gap, not a code defect — the ledger will produce that history on testnet.
