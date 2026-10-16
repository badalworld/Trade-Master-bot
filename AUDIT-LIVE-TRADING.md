# Pre-Live Audit — Trade Master (Binance Futures Bot)

**Date:** 2026-10-16 (round 4 — diagnosis & UI truth) · **Branch:** `arena/5674d799-trade-master-bot`
**Audit verdict:** ❌ still NOT CLEARED for live trading with real funds.
**Remediation status:** round-1 (B1–B5, H1–H4), round-2 (R2-1 … R2-9) and round-3 (R3-1 … R3-7)
items fixed; round-4 items (R4-1 … R4-3) fixed in code, verified by `tsc`, `eslint`, **97/97 unit
tests**, a production build (15 routes) and live route probes.
**Still not cleared for real money** — the strategy has no backtest and no track record, so it must
earn that on testnet first.

The app builds clean and the strategy math is well-tested, but the order-execution path had
nine defects that could lose real money — two of which could leave an **unprotected leveraged
position on the exchange with no stop-loss and no monitoring process**.

> **Corrections to round 1 in this file.** The round-1 text claimed "23 new unit tests" (the suite is
> now 63 and covers the money paths directly), described `npm install` as clean (the committed
> `package-lock.json` was out of sync, so `npm ci` — which both Docker stages run — failed outright),
> and told operators that a no-session probe must return 401/403 (with server-side keys it returned
> the *policy* answer instead, because the endpoints were never authenticated). All three are fixed
> below; the round-1 narrative is kept for history and its claims about the current code should be
> read through this header.

---

## Round 4 — deployment diagnosis and UI truth (branch `arena/5674d799-trade-master-bot`)

**Origin:** an operator deployed on Aiven with real mainnet keys and saw the badge
`TESTNET · PAPER FUNDS` while the log announced `STARTED on MAINNET (REAL MONEY)`, with every
verification attempt reporting *"Binance rejected these credentials"*. Their exported browser log
showed three `-2015` rejections, then `ENV_CREDENTIALS_ACTIVE`, then a "MAINNET START" banner — a
diagnosis failure, not a usage error. These three fixes came out of it.

### R4-1 · HIGH — the browser and the server could disagree about which network was live
The network badge read the **server** (`session.isTestnet`, from `BINANCE_TESTNET` / the credential
session) while the start warning and the start log read the **browser's** `localStorage` toggle
(`settings.isTestnet`). The badge was right and the banner was wrong — the log claimed a real-money
start on a deployment that was actually on testnet. The reverse case is the dangerous one: a
mainnet deployment with a stale testnet toggle would start **with no real-money warning at all**
(`app/page.tsx` line 1536 emitted the warning from the browser value only).

**Fix:** the start path now derives the effective network from the verified session
(`const effectiveIsTestnet = session.isTestnet`), uses it for the warning and the log line, and
writes it back into the stored settings; the session refresh also syncs the browser's view from the
server's answer whenever credentials are active. Settings now states where the network comes from
when the server owns the keys, and the credentials-target picker is labelled as ignored in that case.

### R4-2 · HIGH — every failure was reported as a rejected credential
`POST /api/binance/credentials` answered `401 Binance rejected these credentials: <raw message>` for
*every* failure — including a wrong-network key (`-2015`), an IP-allowlist miss, a `451` geo-block,
a rate limit, a timeout and a DNS outage, none of which evaluate the credentials at all. This is
exactly what sent the operator hunting for a broken key. There was **no 451 handling anywhere in the
codebase** (verified by grep).

**Fix:** `lib/binance-errors.ts` classifies a failure into `GEO_BLOCKED`, `IP_NOT_ALLOWED`,
`INVALID_KEY`, `KEY_NETWORK_MISMATCH` (the `-2015`-on-testnet case, named explicitly so the "you
pasted mainnet keys while `BINANCE_TESTNET` was true" trap is self-explaining), `SIGNATURE_INVALID`,
`TIMESTAMP_DRIFT`, `RATE_LIMITED`, `NETWORK_UNREACHABLE`, `TIMEOUT`, `UNKNOWN` — each with a
`title`, an actionable `action` and a `retryable` flag — plus `httpStatusForFailure()` so the route
returns an honest status (451 geo-block, 429 throttle, 502 unreachable) instead of a blanket 401.
Wired into the credentials route and `/api/binance/test-connection`; the UI now logs the remedy next
to the error. **Verified live:** a dummy-key verify from this sandbox now answers
`502 NETWORK_UNREACHABLE — "This server could not reach Binance at all … this is an egress/DNS
problem, not a credential problem"` where it previously answered `401 "Binance rejected these
credentials"`.

### R4-3 · MEDIUM — there was no way to ask the deployment what was wrong with it
Diagnosis meant reading logs and guessing. Added `GET /api/config/check` (operator-gated, app-header
guarded), which reports the verdict, **both** Binance hosts' reachability, whether credentials
resolved and which class of failure came back, plus `BINANCE_TESTNET`'s raw value, engine state,
ledger writability and risk policy. The judgement lives in pure, unit-tested `lib/config-check.ts`.

Verdicts: `READY_TESTNET`, `READY_MAINNET`, `LOCKED_OPERATOR_TOKEN_MISSING`, `NO_CREDENTIALS`,
`CREDENTIALS_REJECTED`, `GEO_BLOCKED`, `BINANCE_UNREACHABLE`, `MAINNET_LOCKED`.

Notably it calls out, as `TESTNET_FLAG_UNSET`, the exact trap from the report: with `BINANCE_TESTNET`
absent the deployment silently targets testnet paper funds, and the warning explains how to leave it.

**Verified live** on three throwaway instances: keyless → `NO_CREDENTIALS` with
`TESTNET_FLAG_UNSET` + `ENGINE_DISABLED` warnings; mainnet keys + token → `BINANCE_UNREACHABLE`
(not a credential rejection) with `MAINNET_LOCKED` as a warning and the endpoint
`https://fapi.binance.com`; only `BINANCE_API_KEY` set → `PARTIAL_ENV_KEYS` naming the missing half.
(One bug was caught by these tests before commit: the `PARTIAL_ENV_KEYS` branch was unreachable
because it required both keys present *and* one missing.)

### Added in this round
- `lib/binance-errors.ts` + `lib/binance-errors.test.ts` (16 tests), `lib/config-check.ts` +
  `lib/config-check.test.ts` (14 tests). Suite: 70 → **97**, still no network dependency in any test.
- README: `/api/config/check` in the API reference, a "something not working" recipe, six new
  troubleshooting rows (testnet badge trap, `KEY_NETWORK_MISMATCH`, `GEO_BLOCKED`, `IP_NOT_ALLOWED`,
  `TIMESTAMP_DRIFT`/`SIGNATURE_INVALID`, `BINANCE_UNREACHABLE`).
- DEPLOYMENT.md §5b: the region requirement (Binance blocks by source-IP region *before*
  authentication, and Binance.US has no futures platform), the verdict table, and a
  config-check step in §6.

### Verification for this round
`npx tsc --noEmit` clean · `npm run lint` clean · `npm test` **97/97** · `NODE_ENV=production next
build` clean (**15 routes**) · live probes on three instances as above (anonymous `/api/config/check`
401, signed-in 200, direct browsing 403).

### Confirmed NOT a problem (ruled out with evidence)
The operator's log also rules out the regional block that this round documents: their scans returned
real market data for 12 pairs and the authenticated call answered in ~215 ms from
`request ip: 54.247.26.145` (AWS eu-west-1), so Binance was reachable and answered a genuine `-2015`
— a credential/flag problem, not HTTP 451.

### Still unproven (unchanged)
No order has ever been placed against a real exchange from this environment, so bracket acceptance
and income settlement remain unverified; the strategy still has no backtest or track record. The
error classifier is unit-tested against Binance's documented responses — a live 451 and a live
allowlist `-2015` have not been observed here.

---

## Round 3 — full-codebase pass (branch `arena/76447d6f-trade-master-bot`)

Every route, component, library module and test file was re-read end to end, then the built app was
exercised route by route. Seven real defects were found and fixed; all were in code paths that
report or reconcile money rather than in the order path itself.

### R3-1 · HIGH — the UI's engine payload contract did not match the server (controls were dead)
`components/EngineStatusPanel.tsx` declared `engine.enabled`, but the server sends
`engine.config.enabled` (verified live against `/api/engine/status`: the payload has no top-level
`enabled`). Because the response is typed on the client only, TypeScript could not catch it, and the
**Start guardian** button and the **Autopilot** toggle read `undefined` — so on a deployment that had
set `TRADE_ENGINE_ENABLED=true`, both controls stayed permanently disabled. **Fix:** read
`config.enabled` (typed) and derive one `engineEnabled` flag used by all three call sites.

### R3-2 · HIGH — a failed close was booked as a completed trade
`finalizePositionClose` handled `401/403` ("Local bookkeeping only") and the generic `!ok` case by
*falling through* to the local booking block. So an unauthorized or failed close still recorded a
closed trade at an estimated price, deducted an estimated fee, mutated the compounding ladder, and
removed the row — hiding a position that was very likely still open on Binance.
**Fix:** `abortClose()` keeps the row on every failure path and says what is actually known
(operator lockout, session rejection, exchange error, thrown transport error). Only a confirmed
close books a trade.

### R3-3 · HIGH — open positions were never reconciled away when Binance went flat
Nothing ever removed or booked a local position whose exchange counterpart had gone (bracket fired
while the tab was closed, closed by hand, or settled elsewhere): the row stayed "open" in the UI
forever, and the 2 s monitor would eventually book it at a candle price whenever the mark crossed the
old bracket. **Fix:** the account sync now reconciles both directions using
`data.balance.positionsVerified` — a new field that distinguishes *"Binance says the account is
flat"* from *"the positionRisk call failed and returned an empty list"* (the latter must never be
read as flat, which is why the field exists rather than reusing `positions.length`). Vanished
positions are booked through the normal close path with `classifyExit()` labelling the reason, so
telemetry, compounding and history stay consistent.

### R3-4 · MEDIUM — UI close + engine settlement could double-count one trade
A UI close of a symbol the engine owns could be booked twice: once locally and once by the engine
from the income ledger (whichever raced first), leaving the browser and engine compounding ladders
divergent. **Fix:** while the engine is genuinely running (`engine.running`, tracked in
`engineAuthorityRef`) it is the book of record for positions it owns — the browser stands down, leaves
the ledger row so the engine can settle from real commission + funding, and logs where to look. When
the engine is stopped, local booking takes over again.

### R3-5 · MEDIUM — the Binance credential cookie had no `Secure` attribute
`issueSession` emitted an httpOnly, SameSite=Lax cookie without `Secure`, so on an https deployment
the browser would also send a credential-bearing cookie over plain http on the same host.
**Fix:** `issueSession(creds, { secure })` plus a matching `clearSessionCookie(secure)`, both driven
by the existing `isSecureRequest()` (https-only, so local http development still works).

### R3-6 · MEDIUM — two endpoints still fanned out to third parties, unauthenticated
`GET /api/binance/scan` (up to 13 outbound Binance calls per hit) and `GET /api/network/ip` (four
external IP services) were reachable by anyone, making the deployment a free proxy/amplifier.
**Fix:** both are behind `requireOperator` (a no-op when the deployment requires no session), matching
the rest of the API.

### R3-7 · LOW — the diagnostics log divided by the wrong number
The UI logged `data.requestedPairs.length`, but the scan route never returned that field, so
"N pairs returned no usable candles" printed `5/5` instead of `5/12`. **Fix:** the scan route now
returns `requestedPairs` (the post-filter pair set it actually attempted) and the log reads it.

### Added in this round
- `README.md` — operator-facing overview: architecture, safety model, configuration, API reference,
  troubleshooting and an explicit limitations section.
- `lib/trade-guard.test.ts` — 7 tests for the guards that previously had **no** unit coverage at all:
  credential resolution (env vs session, never from a body), cookie attributes, session round-trip,
  CSRF origin/referer checks, idempotency claims, Binance-safe client order ids. Suite: 63 → **70**.

### Verification run for this round
`npx tsc --noEmit` clean · `npm run lint` clean · `npm test` **70/70** · `NODE_ENV=production next
build` clean (14 routes) · `npm ci` (lock file still in sync) · live probes against the built server:
page 200, `/missing` 404, `/api/operator/status` public, `POST /execute` 401 without a session,
keys-in-body 400, `/api/engine/status` 403 without the app header and 200 with it, `scan` returns
`requestedPairs`, `config.enabled` present in the engine payload, and `X-Frame-Options: DENY` +
`frame-ancestors 'none'` on the document.

### Still unproven (unchanged, and the reason the verdict stands)
No order has ever been placed against a real exchange from this environment (egress is allowlisted),
so bracket acceptance, income settlement and every "does Binance accept this" question remain
**unverified** until a live testnet run. The strategy itself still has no backtest and no track record.

---

## Round 2 — findings and fixes (implementation branch `arena/900be1ec-trade-master-bot`)

### R2-1 · BLOCKER — every money endpoint was unauthenticated (verified live)
`X-TM-Request: 1` is a CSRF guard, not authentication: any HTTP client can send it. Proven against
the built server with `BINANCE_API_KEY/SECRET` set — an anonymous caller (no cookie, no Origin) got
through the credential gate on `POST /api/binance/execute` (the request reached Binance's
`positionRisk` call), could `CLOSE` a symbol, could arm autopilot via `/api/engine/control`
(`200`, persisted to the ledger as `autopilot.serverEntries:true`), and could `flatten-all` with the
published confirm string. `DEPLOYMENT.md` recommended exactly that configuration
(`--allow-unauthenticated` + env keys).
**Fix:** `lib/operator-auth.ts` + `/api/operator/{status,login,logout}`. A stateless HMAC-signed
httpOnly cookie (`tm_op`, 12 h, `Secure` on https, `SameSite=Lax`) keyed by `TM_OPERATOR_TOKEN`;
every order/account/engine route calls `requireOperator()`. `TM_OPERATOR_AUTH=auto` (default) turns
the wall on precisely when server keys exist; `off` exists for deployments already behind
IAP/IAM/VPN. Fail-closed: keys present without a token ⇒ **503 `OPERATOR_AUTH_NOT_CONFIGURED`**;
no cookie ⇒ **401 `OPERATOR_AUTH_REQUIRED`**. Login is throttled (5 failures ⇒ 5 min lock) and the
token is compared in constant time. UI: `components/OperatorGate.tsx` blocks the terminal until
signed in, and Settings can sign out.

### R2-2 · BLOCKER (deployment) — the container image could not be built
`npm ci` failed: `EUSAGE … Invalid: lock file's ajv@6.15.0 does not satisfy ajv@8.20.0` (same for
`ajv-formats`, `json-schema-traverse`). Both Docker stages run `npm ci`, so no image was produced.
**Fix:** regenerate `package-lock.json` (3 hoisted versions + nested ajv placements change; the diff
is limited to those). Verified: `npm ci --dry-run` now resolves 1031 packages; `Dockerfile` and
`DEPLOYMENT.md` document the rule.

### R2-3 · HIGH — `GET /api/binance/credentials` leaked the key hint to anyone
Anonymous `200` with `keyHint: "dumm…1234"`, the credential source and the full risk policy.
**Fix:** operator-gated (no-op when no session is required); the UI reads it only after sign-in.

### R2-4 · HIGH — ambiguous entries were protected but forgotten
When an entry threw *after* submission and the position was found (stop re-attached ⇒
`RECOVERED_STOP_ATTACHED`, HTTP 502), the engine logged `ENTRY_SKIPPED`; next cycle it adopted the
position as `foreign`, so it was never re-armed, never settled and never recorded. **Fix:**
`RecoveryBody` now carries `side`/`entryPrice`/`quantity`/`stopLoss`; `lib/engine.ts` adopts the
position into the ledger (`ENTRY_RECOVERED`) and halts new entries until an operator looks
(`ENTRY_UNRESOLVED` when nothing could be adopted).

### R2-5 · HIGH — the daily-loss breaker failed *open* and under-counted
`getRealizedPnlToday()` returned `NaN` on any error and the order path coerced it to `0`, i.e. "no
losses today"; it also summed only `REALIZED_PNL`, ignoring commission and funding.
**Fix:** the same call now returns realized + commission + funding, and `dailyLossGate()` blocks
with `DAILY_LOSS_UNKNOWN` when the number cannot be read (only when a breaker is configured) and
`DAILY_LOSS_BREAKER` when the day's net loss exceeds the cap.

### R2-6 · MEDIUM — a whole-number close could be sent as the invalid quantity `"2."`
`Math.abs(amt).toFixed(8).replace(/0+$/, '')` produced `"2."`, which Binance rejects — after the
exchange brackets had already been cancelled. **Fix:** `formatQtyFallback()` trims the separator
too; used by the close path when no filters are available.

### R2-7 · MEDIUM — the builtin filter table was a *guess* presented as exchange truth
With `exchangeInfo` unreachable, `resolveSpec()` returned `known: true, source: 'builtin'` for the 12
default symbols, so tick sizes and min-notional came from a frozen copy — the same class of bug as
B1/B2. **Fix:** builtin specs are now `known: false` (display hint only); sizing and stop alignment
refuse with `SPEC_UNKNOWN` until real filters load.

### R2-8 · MEDIUM — hedge-mode accounts failed only at the exchange
No `positionSide`, `reduceOnly` closes — Hedge Mode rejects both. **Fix:** `getPositionMode()`
(5-min cache) + `positionModeViolation()` refuse entries up front with an actionable message; an
undeterminable mode is left to the exchange rather than blocking trading on a metadata blip.

### R2-9 · MEDIUM/LOW — two books that could diverge, plus clickjacking and cookie hygiene
The browser still books closes on a flat 0.1% fee estimate into its own localStorage compounding
ladder (the engine books settled income), so the two ladders can drift; the browser TP/SL monitor
triggers on the last 5m candle close rather than mark price. The page was also framable by any site
(clickjacking a START/CLOSE button) — **fixed** with `X-Frame-Options: DENY` +
`frame-ancestors 'none'` — and the Binance session cookie still lacks `Secure` (**not** changed in
this round). Still open: no backtest, no alerting, browser-side PnL estimates, and the strategy's
record is zero.

### Verification run for this round
`npx tsc --noEmit` clean · `npm run lint` clean · `npm test` **63/63** · `NODE_ENV=production next
build` OK (14 routes, incl. the 3 new operator routes) · `npm ci --dry-run` OK ·
live probes: anonymous `POST /execute` → 401 `OPERATOR_AUTH_REQUIRED` (was: reached Binance),
anonymous `/api/engine/control` → 401 (was: 200 + persisted), `/api/operator/status` → `required:
true, configured: true, authenticated: false`, signed-in request → 409 `POLICY_BLOCKED` with the
three cap violations.

### Not verified here (unchanged from round 1)
No order was ever placed against a real exchange in this environment (egress is allowlisted), so
bracket acceptance — in particular whether Binance accepts `timeInForce` on `STOP_MARKET` with
`closePosition=true` — still has exactly one way to be proven: a live testnet run.

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

---

# Phase 3 — "fully automated" made true, and the UI scoped to one page

Requested behaviour: *the user pastes a Binance API key, presses Start, and the bot does everything —
market scan, trade execution, TP/SL, closes. No manual task.* That claim was tested against the code
rather than accepted, and both halves of it needed work.

## Verified: what is automatic after pressing Start

| Step | Who does it | Evidence |
|---|---|---|
| Scan the allowlist (HVN profile + absorption + stacked imbalance, 5m) | `runMarketScan` on the 15 s interval; server-side `scanUniverse` when the engine runs | no click path exists to "approve" a scan |
| Position sizing (LOT_SIZE / MIN_NOTIONAL / tick rounding) | `lib/order-executor.ts` only | fail-closed: no `exchangeInfo` ⇒ `422`, no order |
| Risk policy (margin/leverage/notional/cap/daily loss/allowlist/mainnet gate) | `validateOpenRequest` inside the executor, so **both** UI and engine pass through it | `POLICY_BLOCKED` probes above |
| Entry order → read the fill → place STOP_MARKET + TAKE_PROFIT_MARKET | `openPosition`; a stop that cannot be placed triggers auto-flatten | B1 remediation |
| TP/SL monitoring and closing | browser 2 s monitor for UI-owned trades; engine guardian for engine-owned ones; the exchange brackets always | `engineManagedRef` stand-down prevents double closes |
| Ledger, realized PnL, +20 % compounding | `recordClose` (settled from Binance income when the engine closes) | `position-ledger.test.ts` |

Nothing in that list requires a human between Start and the closed trade. What *was* manual, and is
now fixed, is the part outside the tab — see below.

## The one remaining manual step, removed

Server-side unattended entries previously needed `TRADE_ENGINE_AUTO_ENTRY=true` **plus a redeploy**,
which contradicts "no manual task". There is now an **Autopilot** switch in the engine panel
(`POST /api/engine/control {"action":"set-auto-entry","enabled":true}`), persisted in the ledger as
`autopilot.serverEntries`, and re-applied on every start. Proved live: enabled through the API,
process killed, restarted →

```
[engine:success] STARTED: Guardian loop active on testnet every 12s · auto-entry ON (autopilot switch) · bracket enforcement ON
```

The env var remains the floor (if it is `true`, the UI cannot switch entries off), and the switch still
cannot bypass `TRADE_ALLOW_MAINNET`, the symbol allowlist or any cap — it only decides whether the loop
is allowed to *try*.

## Two defects found while wiring it (both fixed, both with tests)

1. **The dashboard could not see the switch it had just flipped.** `getStatus()` was re-reading
   `loadEngineConfig()` wholesale, so the runtime override was overwritten by env on every read:
   autopilot was genuinely ON (log showed `AUTOPILOT_ON`, entries were being attempted) while the API
   answered `autoEntry: false`. A monitoring surface that contradicts the thing it monitors is worse
   than none, so `autoEntry` is now overlaid explicitly, and while the loop is idle `getStatus()`
   reports what the *next start would do* rather than the env default.
2. **Unattended MAINNET entries could be armed with no confirmation.** The confirm requirement keyed
   off `engine.getStatus().network`, which is still the safe `'testnet'` default on an engine that has
   never started — so a fresh instance with mainnet keys and the loop idle accepted
   `set-auto-entry {enabled:true}` silently (observed: HTTP 200, `autopilot.serverEntries: true`
   written to disk). The decision now lives in `engine.setAutoEntry`, derives the network from the
   credentials that *would* be used, and requires `confirm:"ENABLE_AUTOPILOT"` (HTTP 428 without it).
   While there: `enabled` is parsed strictly — `{"enabled":"maybe"}` used to mean "off", which is a
   silent no-op a UI bug could hide behind; it is now `400 ENABLE_REQUIRED`.

## UI scope change

The interactive 3D telemetry cards (balance, equity, fees, funding, realized PnL, win rate, positions,
next margin, API weight, scan cycle) were rendered above the tabs, so they appeared on every screen
including Settings. They now render only on the first tab (the terminal), where the numbers belong.
The footer no longer repeats configuration values — margin/leverage are live settings shown in
Settings and in the KPI strip, and duplicating them in a footer invites the reader to trust a number
that may not match what the server will actually accept. The footer is now the copyright/credit line.

## Status

`tsc` 0 errors · `eslint` 0 problems · `node --test` **49/49** (7 new: 2 ledger autopilot, 5 engine
gating) · `next build` clean. Live probes: `400 ENABLE_REQUIRED` on missing/bogus `enabled`, `200` +
`autoEntry:true` in status + persisted flag on testnet, refusal-and-confirm shape on mainnet, cards
absent from the Settings-tab SSR HTML, new footer present in it.

The blocking condition for real money is unchanged and cannot be changed by code written in a sandbox
that cannot reach the exchange: **no Binance response has been parsed by this code, and the strategy
has no profitable-trade history or backtest.** Full automation makes that soak *more* important, not
less — an unattended loop that trades badly is worse than a manual one.
