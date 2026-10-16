# Deploying Trade Master safely

The build is container-ready (`output: 'standalone'`, `Dockerfile`). Deploying it is fine.
**Wiring mainnet keys to it is not, until the checklist below is complete.**

> **Operator authentication is mandatory as soon as server keys are configured.** Round-1 hardening
> left the order endpoints reachable by any HTTP client that sent `X-TM-Request: 1`; that header is a
> CSRF guard, not authentication. If `BINANCE_API_KEY`/`BINANCE_API_SECRET` are set and
> `TM_OPERATOR_TOKEN` is not, every money endpoint now refuses with **503
> `OPERATOR_AUTH_NOT_CONFIGURED`** — locked is better than an open order relay. Set the token (and
> then sign in from the operator screen) before funding anything.

---

## 0. Build prerequisites

- The committed `package-lock.json` must stay in sync with `package.json`, or `npm ci` (used by both
  Docker stages) fails with `EUSAGE` and no image is produced. After changing dependencies run
  `npm install` and commit the lock file. Verify with `npm ci --dry-run`.
- `npm test` runs on Node's native TypeScript support, so the builder needs **Node ≥ 22.18**
  (`node:22-alpine` is fine) or the `test` stage of the Dockerfile will fail the build.

## 1. Phase one — testnet only (recommended first deploy)

```bash
# Build + push (REGION and PROJECT are real values, not placeholders)
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT/trade-master/trade-master:0.1.0
gcloud run deploy trade-master \
  --image REGION-docker.pkg.dev/PROJECT/trade-master/trade-master:0.1.0 \
  --platform managed --region REGION \
  --allow-unauthenticated \
  --min-instances=1 --max-instances=1 \
  --port=8080 \
  --memory=512Mi \
  --set-secrets="BINANCE_API_KEY=binance-key:latest,BINANCE_API_SECRET=binance-secret:latest,TM_OPERATOR_TOKEN=operator-token:latest" \
  --set-env-vars="BINANCE_TESTNET=true,TRADE_ALLOW_MAINNET=false,TRADE_MAX_MARGIN_USDT=25,TRADE_MAX_NOTIONAL_USDT=500"
```

Generate the operator token once and store it as a secret:

```bash
openssl rand -hex 32 | gcloud secrets create operator-token --data-file=-
```

`--allow-unauthenticated` is then acceptable: the app authenticates you itself, and the operator
cookie is a signed httpOnly cookie (12 h). Alternatives, if you prefer to keep the URL private too:

- `--no-allow-unauthenticated` + IAM/IAP (the browser needs an identity-aware proxy; plain IAM alone
  cannot log a browser in), or
- keep `--allow-unauthenticated` and set `TM_OPERATOR_AUTH=off` **only** behind your own
  authenticating reverse proxy.

Two ways to supply Binance credentials:

| Method | How | Notes |
|---|---|---|
| **Server secret (preferred)** | `--set-secrets="BINANCE_API_KEY=binance-key:latest,BINANCE_API_SECRET=binance-secret:latest"` | Keys never touch a browser. Safe to scale past 1 instance. Requires `TM_OPERATOR_TOKEN`. |
| Browser session | Settings → Verify & open session (after operator sign-in) | Keys held in **server memory** behind an 8h httpOnly cookie. Requires `--max-instances=1`, or a session lands on an instance that doesn't have it. |

Either way the keys are **never** written to `localStorage`, never returned to the client, and never
logged. Older builds did all three; on first launch the app now scrubs any leftover key from
browser storage and tells you to rotate it.

**Why `--max-instances=1`:** the credential session and order-idempotency ledger are per-process.
Also, a single instance keeps the per-IP Binance weight accounting coherent.

## 2. Binance key hygiene

- Create a **dedicated** key for this bot. Never reuse a key that can withdraw.
- Enable **Futures** only. Leave "Enable Spot & Margin Trading" **off** and "Can Withdraw" **off** forever.
- IP restriction: use only the address `/api/network/ip` reports with `"verified": true`.
  If it is `null`, your platform has no static egress IP — provision a Cloud Run VPC connector
  or accept a key with no IP binding (and keep it withdrawal-disabled).
  The old build printed a **fabricated** IP here; do not whitelist anything it guessed.
- Set a small USDT balance on the account. The bot has no idea how much is in your wallet beyond
  the caps below.

## 3. Phase two — gate to mainnet (do this only after a clean testnet run)

Checklist before flipping anything:

- [ ] ≥ 2 weeks / ≥ 100 closed trades on testnet, reviewed one by one in `Trade History`.
- [ ] You have read the testnet fills and confirmed sizing matches intent (`sizingNotes`, `effectiveNotional` in the log payload).
- [ ] `TRADE_MAX_MARGIN_USDT` and `TRADE_MAX_NOTIONAL_USDT` set to amounts you can lose entirely.
- [ ] `TRADE_MAX_DAILY_LOSS_USDT` set (breaker locks entries after that much realized loss, UTC day).
- [ ] You understand the strategy has **no backtest and no live track record** in this repo.
- [ ] You will keep a tab open, or accept that **nobody is watching TP/SL if this process stops**.

```bash
gcloud run services update trade-master --region=region \
  --set-env-vars="BINANCE_TESTNET=false,TRADE_ALLOW_MAINNET=true,TRADE_MAX_MARGIN_USDT=10,TRADE_MAX_NOTIONAL_USDT=150,TRADE_MAX_DAILY_LOSS_USDT=75"
```

`TRADE_ALLOW_MAINNET=true` is the only thing standing between a bug and a real position, and the UI
will additionally require typing `I UNDERSTAND` before it accepts mainnet keys.

## 4. Emergency controls

| Situation | Action |
|---|---|
| Stop new entries now | `gcloud run services update trade-master --region=... --set-env-vars="TRADE_HALT=true"` (closes still work, so you can unwind) |
| Flatten + stop everything | Pause the bot in the UI, then close each row in **Positions**; verify in the Binance app |
| Key possibly leaked | Delete the key on Binance first (kills the money path), then revoke the session in Settings |
| Operator token or session possibly exposed | Rotate `TM_OPERATOR_TOKEN` (every signed operator cookie stops verifying at once — the token itself is never stored in a browser), then set a fresh secret and redeploy. `TM_OPERATOR_AUTH=off` should only ever be used behind platform auth |

## 5. Unattended operation: the server-side engine

Before this existed, the honest answer was "if no browser has the app open, nothing manages the
trade". That is no longer true, but it is also not automatic — it is a deployment decision.

**What the engine does** (`lib/engine.ts`, booted by `instrumentation.ts` when
`TRADE_ENGINE_ENABLED=true` and server credentials exist):

1. **Reconciles** the saved ledger against `/fapi/v2/positionRisk` every cycle — exchange truth wins,
   so a bracket that fired while nobody was watching is detected and settled.
2. **Verifies protection**: for every tracked position it checks a live `STOP_MARKET` exists; if the
   stop is gone it re-arms one at the recorded level (tick-aligned), and if the stop cannot be
   established it closes the position to cap the loss instead of holding it naked.
3. **Adopts, never fights**: a stop moved on the exchange by more than 0.1 % is adopted into the
   ledger rather than reset to the old value.
4. **Backstops breaches**: if the mark price is through the bracket and the exchange order did not
   act, it closes from the server.
5. **Settles the ledger** from Binance's own income records (realized PnL + commission + funding), so
   compounding and the daily-loss breaker run on settled numbers, not browser estimates.
6. **Reports, does not touch, what it did not open**: positions on the account that are not in the
   ledger are marked `foreign` and never managed or closed.
7. Optionally (**off by default**) scans and opens entries through the exact same
   `lib/order-executor` path the UI uses, so route and engine cannot diverge on sizing or brackets.

**Enabling it**

```bash
gcloud run services update trade-master --region=... --set-env-vars="\
TRADE_ENGINE_ENABLED=true,TRADE_ENGINE_AUTO_ENTRY=false,TRADE_DATA_DIR=/data"
gcloud run services update trade-master --region=... \
  --min-instances=1 --max-instances=1 --volume cloud-nfs:trade-master-data --volume-mount /data
```

Non-negotiable conditions, all of which are visible in the Positions tab (the engine panel refuses to
be ignored when they are not met):

- **Always-on instance.** `--min-instances=1` — scale-to-zero means the loop sleeps between requests,
  which defeats the entire point. Sessions/idempotency are per-process too, hence `max-instances=1`.
- **Persistent `TRADE_DATA_DIR`.** The ledger is a JSON file written atomically (tmp + rename). On a
  container without a volume, `ledgerDurable` reports `in-process only` and a restart forgets which
  positions the engine owns (it will then treat them as foreign — protected by the exchange brackets,
  but not managed). NFS Filestore / a PVC / a mounted disk is required for real unattended use.
- **Server-side credentials only.** The loop reads `BINANCE_API_KEY`/`BINANCE_API_SECRET` from the
  environment; a browser session cannot outlive the tab, so by design it will not start without them.
- **Start guardian-only, then decide.** `TRADE_ENGINE_AUTO_ENTRY=false` means the loop can only *reduce*
  risk (close, re-arm, settle) — it never opens a position. The same switch is exposed in the app
  (Positions tab → **Autopilot**) and persisted in the ledger, so enabling full automation is one click
  instead of a redeploy, and it survives restarts — which is the whole point of unattended trading.
  On MAINNET that button will not arm anything without a second confirming click, and
  `TRADE_ALLOW_MAINNET=true` must already be set, because "the bot opened a trade I never asked for" is
  precisely the failure these gates exist to prevent.

**Interaction with the browser tab.** A trade opened from the UI is registered with the engine
(`/api/engine/track`), so closing the tab does not orphan it. While the engine reports it owns a
symbol, the browser's own 2-second TP/SL monitor stands down for that symbol — one brain per position,
no duplicated closes and no double-booked trade in history. A close the engine already settled is not
re-booked locally.

**Controls** (same CSRF/origin guard as trading; `GET` status additionally needs the app's
`X-TM-Request` header so a random visitor cannot read your positions):

| Action | Request |
|---|---|
| Status (loop, ledger, policy, events) | `GET /api/engine/status` |
| Start / stop the loop | `POST /api/engine/control {"action":"start"}` |
| Stop opening, keep protecting | `POST /api/engine/control {"action":"halt-entries"}` |
| Close everything the engine owns | `POST /api/engine/control {"action":"flatten-all","confirm":"FLATTEN"}` |
| Arm / disarm unattended entries | `POST /api/engine/control {"action":"set-auto-entry","enabled":true}` (MAINNET also needs `"confirm":"ENABLE_AUTOPILOT"`) |

**What this does *not* fix.** It is not a hosted strategy service: there is still no database, no
multi-user isolation, no alerting, and no recovery if the instance is replaced mid-cycle (the exchange
brackets are what actually protect money while that happens). And nothing here has been exercised
against the live Binance API from the audit environment — the order-placement paths, bracket
acceptance and income settlement still have exactly one source of truth: a real testnet run.

## 5b. Region, reachability and self-diagnosis

**Binance enforces Futures access by the *source IP's region*, before authentication.** Restricted
locations include the United States, Malaysia, Ontario (Canada), Cuba, Iran, Syria, North Korea and
Crimea. The response is **HTTP 451** with *"Service unavailable from a restricted location"*, and it
cannot be worked around: no API key, permission or flag changes it, and Binance.US has no futures
platform to move to. **Pick a cloud region that Binance serves for Futures before you deploy**, or
the bot will never trade regardless of configuration.

One call answers "why isn't this working?":

```bash
curl -s -b /tmp/tm.jar -H 'X-TM-Request: 1' https://<service>/api/config/check | jq
```

| Verdict | Meaning | Fix |
|---|---|---|
| `READY_TESTNET` / `READY_MAINNET` | Credentials resolved, host reachable, gates open | — |
| `LOCKED_OPERATOR_TOKEN_MISSING` | Server keys exist but `TM_OPERATOR_TOKEN` is unset → every money route answers 503 | Set the token secret and redeploy |
| `NO_CREDENTIALS` | No complete key pair (check `PARTIAL_ENV_KEYS`: it names the missing half) | Set both secrets |
| `CREDENTIALS_REJECTED` | Binance answered and refused — the issue carries `INVALID_KEY`, `KEY_NETWORK_MISMATCH`, `IP_NOT_ALLOWED`, `SIGNATURE_INVALID`… | Follow the issue's `action` |
| `GEO_BLOCKED` | HTTP 451 from this region | Move the deployment |
| `BINANCE_UNREACHABLE` | DNS/egress failure — **no key would work** | Fix outbound HTTPS |
| `MAINNET_LOCKED` | Mainnet keys but `TRADE_ALLOW_MAINNET=false` | Intentional until you have a clean testnet run |

It also reports both hosts' reachability, the effective `BINANCE_TESTNET` value (with a warning when
it is unset — the trap that silently keeps a deployment on testnet paper funds), engine state,
ledger writability and the resolved risk policy.

## 6. Verifying a deploy

Run these in order. The first block is the one that matters: a stranger must not be able to trade.

```bash
# 1. Does this deployment demand an operator session?
curl -s https://<service>/api/operator/status | jq
# expect {"required":true,"configured":true,"mode":"auto","authenticated":false}

# 2. Anonymous order attempt — must be refused by AUTH, not by policy or by the network:
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<service>/api/binance/execute \
  -H 'Content-Type: application/json' -H 'X-TM-Request: 1' \
  -d '{"action":"OPEN","symbol":"BTCUSDT","side":"LONG","margin":2,"leverage":10,"price":111000,"stopLoss":110000,"takeProfit":113000}'
# expect 401  (503 OPERATOR_AUTH_NOT_CONFIGURED means TM_OPERATOR_TOKEN is missing; 200/409 means EXPOSED)

# 3. Anonymous engine control — must also be refused:
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<service>/api/engine/control \
  -H 'Content-Type: application/json' -H 'X-TM-Request: 1' -d '{"action":"set-auto-entry","enabled":true}'
# expect 401

# 4. Sign in and confirm policy still blocks absurd sizes (cookie jar keeps the session):
curl -s -c /tmp/tm.jar -X POST https://<service>/api/operator/login \
  -H 'Content-Type: application/json' -H 'X-TM-Request: 1' -d '{"token":"<TM_OPERATOR_TOKEN>"}' | jq '{success, expiresAt}'
curl -s -b /tmp/tm.jar -X POST https://<service>/api/binance/execute \
  -H 'Content-Type: application/json' -H 'X-TM-Request: 1' \
  -d '{"action":"OPEN","symbol":"BTCUSDT","side":"LONG","margin":99999,"leverage":50,"price":111000,"stopLoss":110000,"takeProfit":113000}' | jq '.code, .violations[].code'
# expect 409 POLICY_BLOCKED with LEVERAGE_OUT_OF_RANGE + MARGIN_TOO_LARGE + NOTIONAL_TOO_LARGE
# (the order is still never submitted — the caps are independent of the session)

# 5. Session state + engine:
curl -s -b /tmp/tm.jar https://<service>/api/binance/credentials | jq '{active, source, isTestnet, policy}'
curl -s -b /tmp/tm.jar -H 'X-TM-Request: 1' https://<service>/api/engine/status \
  | jq '{engine: .engine | {running, enabled: .config.enabled, cycles, credentialSource, network, ledgerDurable, ownedPositions, lastError}, ledger: .ledger.network}'
# With TRADE_ENGINE_ENABLED=true and env credentials you must see running:true, credentialSource:"env",
# cycles increasing every interval, and ledgerDurable:true. With the flag off, running:false is correct.

# 6. Egress IP for the Binance key whitelist (never whitelist anything it did not verify):
curl -s https://<service>/api/network/ip | jq '{ipv4, verified, warnings}'
```

Rules of thumb: **401 is the correct answer for every anonymous money call.**

Then ask the deployment to diagnose itself, which must answer without any guessing:

```bash
curl -s -b /tmp/tm.jar -H 'X-TM-Request: 1' https://<service>/api/config/check \
  | jq '{verdict, targetNetwork, blockers, issues: [.issues[] | {severity, code, title}]}'
```

A correct production deployment reports `READY_MAINNET` (or `READY_TESTNET` while validating) with
`blockers: 0`. Anything else names the exact problem and the fix — including
`TESTNET_FLAG_UNSET` when `BINANCE_TESTNET` was never set, which is why a deployment can look
configured while still trading paper funds. If step 2 or 3 returns
anything else, do not fund the deployment. Clickjacking is blocked by `X-Frame-Options: DENY` +
`frame-ancestors 'none'`, so this page cannot be embedded in another site (if you *need* it embedded
in an applet shell, that trade-off has to be made deliberately in `next.config.ts`).
