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

## 5. Known architectural limit — read before trusting it unattended

Open positions, PnL accounting and the TP/SL monitor are React state in a browser tab, persisted to
that browser's `localStorage`. **If no browser has the app open, nothing manages the trade** —
only the STOP_MARKET / TAKE_PROFIT_MARKET orders on Binance remain. The exchange bracket is now
mandatory (a position is auto-flattened if the stop cannot be placed), but for genuinely unattended
operation the scan/monitor loop has to move into a server-side worker with a real database for the
trade ledger. That is a rewrite of the persistence layer, not a config change.

## 6. Verifying a deploy

```bash
curl -s https://<service>/api/binance/credentials | jq '{active, source, isTestnet, policy}'
curl -s https://<service>/api/network/ip | jq '{ipv4, verified, warnings}'
curl -s -X POST https://<service>/api/binance/execute \
  -H 'Content-Type: application/json' -H 'X-TM-Request: 1' \
  -d '{"action":"OPEN","symbol":"BTCUSDT","side":"LONG","margin":99999,"leverage":50,"price":111000,"stopLoss":110000,"takeProfit":113000}' | jq
# expect 409 POLICY_BLOCKED with LEVERAGE_OUT_OF_RANGE + MARGIN_TOO_LARGE + NOTIONAL_TOO_LARGE
```

That last probe is the important one: with no session it must be **401/403**, and with a session it
must be **409 POLICY_BLOCKED**. Any other answer means this deployment is exposed — do not fund it.
