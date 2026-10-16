# Deploying Trade Master safely

The build is container-ready (`output: 'standalone'`, `Dockerfile`). Deploying it is fine.
**Wiring mainnet keys to it is not, until the checklist below is complete.**

---

## 1. Phase one — testnet only (recommended first deploy)

```bash
# Build + push
gcloud builds submit --tag gcloudbuild/region/trade-master:0.1.0
gcloud run deploy trade-master \
  --image gcloudbuild/region/trade-master:0.1.0 \
  --platform managed --region region \
  --allow-unauthenticated \
  --min-instances=1 --max-instances=1 \
  --port=8080 \
  --memory=512Mi \
  --set-env-vars="BINANCE_TESTNET=true,TRADE_ALLOW_MAINNET=false,TRADE_MAX_MARGIN_USDT=25,TRADE_MAX_NOTIONAL_USDT=500"
```

Two ways to supply credentials:

| Method | How | Notes |
|---|---|---|
| **Server secret (preferred)** | `--set-secrets="BINANCE_API_KEY=binance-key:latest,BINANCE_API_SECRET=binance-secret:latest"` | Keys never touch a browser. Safe to scale past 1 instance. |
| Browser session | Settings → Verify & open session | Keys held in **server memory** behind an 8h httpOnly cookie. Requires `--max-instances=1`, or a session lands on an instance that doesn't have it. |

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
- **Start guardian-only.** `TRADE_ENGINE_AUTO_ENTRY=false` means it can only *reduce* risk (close,
  re-arm, settle) — it never opens a position. Turn auto-entry on only after you have watched the
  guardian's log for a while.

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

**What this does *not* fix.** It is not a hosted strategy service: there is still no database, no
multi-user isolation, no alerting, and no recovery if the instance is replaced mid-cycle (the exchange
brackets are what actually protect money while that happens). And nothing here has been exercised
against the live Binance API from the audit environment — the order-placement paths, bracket
acceptance and income settlement still have exactly one source of truth: a real testnet run.

## 6. Verifying a deploy

```bash
curl -s https://<service>/api/binance/credentials | jq '{active, source, isTestnet, policy}'
curl -s https://<service>/api/network/ip | jq '{ipv4, verified, warnings}'
curl -s -X POST https://<service>/api/binance/execute \
  -H 'Content-Type: application/json' -H 'X-TM-Request: 1' \
  -d '{"action":"OPEN","symbol":"BTCUSDT","side":"LONG","margin":99999,"leverage":50,"price":111000,"stopLoss":110000,"takeProfit":113000}' | jq
# expect 409 POLICY_BLOCKED with LEVERAGE_OUT_OF_RANGE + MARGIN_TOO_LARGE + NOTIONAL_TOO_LARGE

# Engine state (needs the app header; a bare browser visit must be 403):
curl -s -H 'X-TM-Request: 1' https://<service>/api/engine/status | jq '{engine: .engine | {running, enabled: .config.enabled, cycles, credentialSource, network, ledgerDurable, ownedPositions, lastError}, ledger: .ledger.network}'
# With TRADE_ENGINE_ENABLED=true and env credentials you must see running:true, credentialSource:"env",
# cycles increasing every interval, and ledgerDurable:true. With the flag off, running:false is correct.
# A stray visitor gets: curl -s https://<service>/api/engine/status  ->  {"code":"ORIGIN_REJECTED"} (403)
```

That last probe is the important one: with no session it must be **401/403**, and with a session it
must be **409 POLICY_BLOCKED**. Any other answer means this deployment is exposed — do not fund it.
