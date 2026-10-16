# Trade Master - Binance Futures Trading Bot

**Trade Master** is an automated Binance USDT-M Futures trading bot that scans all futures pairs every **15 seconds** on the **5-minute** timeframe for high-probability entries using three core indicators:

- **HVN Profile** (High Volume Node / POC, Value Area High/Low)
- **Heavy Absorption** (high volume + small range, wick rejection, stagnation)
- **Imbalance Levels 3** (Fair Value Gaps, 3 strongest unfilled levels)

It trades the most **volatile** assets first (faster moves = faster profit), with TP/SL derived directly from indicator levels. Risk is isolated, starting at **$2 margin + 10x leverage**, with **compounding**: after a WIN next margin = base + 20% of profit; after a LOSS reset to base. Max **5 open positions** simultaneously, with **95% Binance API weight protection** to avoid IP ban. Full logs and trade history for diagnosis.

---

## Features

- ⚡ **Volatility-sorted scanner** - 24h ticker ranking → top N volatile pairs → 5m klines → analysis. Refresh 15s.
- 📊 **Three-indicator fusion** - HVN (volume profile 50 bins), Absorption (vol spike + ATR + wick), Imbalance L3 (FVG detection, 70% fill check). Composite score 0-100, ≥68 = high-probability signal.
- 🎯 **TP/SL from indicators** - SL at HVN Value Area / POC ± ATR, TP at next imbalance/HVN + 1:1.8 RR minimum.
- 💸 **$2 • 10x isolated** - Notional $20, quantity auto-adjusted to LOT_SIZE step.
- 📈 **Compounding** - Win → next margin +20% of profit, Loss → reset. Capped at 5× base.
- 🛡️ **95% rate limit guard** - Token bucket 2280/2400 weight per minute, batched requests.
- 🖥️ **Dashboard** - Binance-style dark UI with TradingView 5m chart, volatility table, signal cards, positions, history, live logs, settings + **IPv4 display for Binance whitelist**.
- 📝 **Full logging** - SQLite (`data/trades.db`, `logs/bot.log`), every signal/trade/error.
- 🧪 **Paper trading fallback** - Works without API keys (simulated fills via high/low TP/SL check).

---

## Quick Start

```bash
git clone https://github.com/badalworld/Trade-Master-bot
cd Trade-Master-bot

# Python 3.11 recommended
pip install -r requirements.txt

# Run
python run.py
# or
uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
```

Open http://localhost:8000

### 1) Add Binance API keys

Dashboard → **Settings** (gear icon) → paste **API Key** + **Secret** → see your **Public IPv4** → add it to Binance API Management → **IP access restrictions** → whitelist IP → enable **Futures** + **Trading** permissions → Save.

> Use **Testnet** first: https://testnet.binancefuture.com → generate testnet keys → toggle Testnet ON in settings.

Without keys the bot runs in **Paper mode** (simulated).

### 2) Configure risk

- Base margin: `2` USDT (default)
- Leverage: `10x`
- Max open: `5`
- Compounding: `ON 20%` (win → base + 0.2*profit)

### 3) Start bot

Toggle **BOT OFF → ON** in header. It immediately scans top volatile pairs every 15s, opens high-prob trades, monitors TP/SL.

---

## Dashboard Guide (matches video)

| Panel | Description |
|---|---|
| **Header** | Logo, API status, Rate usage `0/2280`, BOT toggle |
| **Stats** | Balance, Today PnL, Active 0/5 progress, Next margin, Scan countdown |
| **Volatility Rank** | 24h high→low score = 0.4*|%chg|+0.4*dailyRange + log(volume). Click row to chart. |
| **High-Probability Signals** | Score ring, direction LONG/SHORT, HVN price/strength, Absorption score/type, Imbalance count, TP/SL + reasons. Sorted high-prob → score → volatility. |
| **TradingView 5m** | Symbol selector, indicator legend, lightweight-charts with FVG/HVN. TP/SL visible. |
| **Open Positions** | Isolated 10x table: entry, live price, unrealized PnL, TP/SL, Close button. |
| **Risk & Compounding** | Base vs next margin math: `WIN $3.20 profit → next $2 + $0.64 = $2.64` |
| **Trade History** | Closed PnL, fees 0.04%, win check |
| **Logs** | Real-time `bot.log` + DB, levels INFO/WARN/ERROR, module tags |
| **Settings Modal** | IP whitelist (public/local + copy + Binance link), keys, testnet/paper, risk, scanner 95% note |

---

## Indicators Deep Dive

### HVN Profile
- 100 candles × 50 price bins → volume distribution → POC (max vol) = HVN
- Value Area 70% volume around POC → VAH/VAL
- Strength = maxVol/avgVol, distance% to price, secondary HVNs >60% POC

### Heavy Absorption
Score 0-100:
- Volume spike >1.8x avg 20 → +30, >2.5x +15
- Range/ATR <0.6 + high vol → +35 (tight range absorption)
- Wick >60% range + high vol → +25 (bullish lower-wick / bearish upper-wick)
- 5-candle stagnation <0.3% move + high vol → +20
- Doji small body → +20

`is_absorption` when score ≥50.

### Imbalance Levels 3 (FVG)
- Bullish FVG: `low[2] > high[0]` gap, Bearish: `high[2] < low[0]`
- Size/ATR strength + recency bonus, fill check on later candles (partial 0.7×, full 0.3×)
- Keep top 3 strongest unfilled → nearest bullish/bearish mid ±1.5% of price → direction bias

### Fusion & TP/SL
- HVN near price 0.5% → +10, vote: above POC LONG 0.6, below SHORT 0.6
- Absorption vote ×0.7, Imbalance ×0.7, EMA20/50 trend +10
- Final direction by votes >20, score = weighted sum capped 100
- `is_high_prob` if score ≥68
- TP/SL: `ATR=TR rolling 14`, SL = nearest HVN VAL/POC ±0.2 ATR or ±1.5 ATR (clamped 0.3-2%), TP = nearest opposite imbalance/HVN or RR 1.8

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | Health |
| GET | `/api/ip` | Local + public IPv4 |
| GET/POST | `/api/settings` | Config (masked secret) |
| GET | `/api/status` | Bot state, balance, open/closed, last scan, rate |
| POST | `/api/bot/start` `/stop` | Toggle loop |
| GET | `/api/scanner/volatility` | Volatility ranked 24h tickers |
| GET/POST | `/api/scanner/results` `/scan-now` | Cached or fresh scan |
| GET | `/api/positions` | Open + unrealized PnL |
| GET | `/api/history?limit=100` | Closed trades |
| GET | `/api/signals` | Recent high-prob signals |
| GET | `/api/logs` | Recent logs |
| GET | `/api/risk` | Next margin explanation |
| GET | `/api/klines?symbol=BTCUSDT&interval=5m&limit=100` | Klines |
| GET | `/api/balance` | Futures balance (or paper) |
| DELETE | `/api/trades/{id}` | Manual close at market |
| POST | `/api/reset/paper` | Clear paper data |

---

## Binance API Weight (95% Protection)

Binance Futures: 2400 weight/min.
Bot:
- `GET /fapi/v1/ticker/24hr` = 40 (once per scan)
- `GET /fapi/v1/klines` = 2 per symbol × 25 = 50 per scan → 200/min
- `GET /fapi/v1/exchangeInfo` = 10 cached 1h
- Total ~250/min < 2280 (95%) ✅
- If approaching limit, sleeps remainder of 60s window and logs warning.

To scan **all** pairs (~350) swap `scan_top_n=50` and it auto-batches 5 concurrent + 95% guard. Recommend 20-30 for 15s interval.

---

## Project Structure

```
Trade-Master-bot/
├── backend/
│   ├── app.py            # FastAPI + static frontend
│   ├── config.py         # JSON config + 95% limits
│   ├── binance_client.py # HMAC signed REST + RateLimiter
│   ├── indicators.py     # HVN, Absorption, Imbalance L3, analyze_symbol, tp/sl
│   ├── scanner.py        # Volatility ranking + full_scan()
│   ├── trader.py         # Loop 15s, evaluate_signals, monitor TP/SL, compounding
│   ├── risk_manager.py   # Next margin = base + 0.2*profit or reset
│   ├── logger.py         # SQLite + file log
│   └── __init__.py
├── frontend/
│   └── index.html        # Tailwind dashboard + TradingView/lightweight-charts
├── data/                 # config.json, trades.db (gitignored)
├── logs/                 # bot.log
├── requirements.txt
├── run.py
└── README.md
```

---

## Compounding Example

- Start: base `$2.00`, leverage `10x` → notional `$20`
- Trade 1: WIN profit `+$1.40` (after fees) → next margin = `2.00 + 1.40*0.20 = $2.28`
- Trade 2: WIN profit `+$2.10` → next = `2.00 + 2.10*0.20 = $2.42`
- Trade 3: LOSS `-$0.90` → next reset = `$2.00`

Capped at `5× base = $10.00` to prevent blow-up. Toggle OFF to always use base.

---

## Security

- API keys stored in `data/config.json` (chmod 600), never logged. Secret masked in API.
- Show **public IPv4** for whitelist (Binance → API Management → Restrict access to trusted IPs only → paste IP).
- CORS enabled, but run behind reverse proxy + HTTPS in production. Consider encrypting config with Fernet (`cryptography` ready).

---

## Troubleshooting (logs help diagnose)

- `Balance fetch failed` → check API key permissions (Futures, Trading) + IP whitelisted.
- `Failed to fetch klines` → rate limited? Check `rate_limit_usage` gauge; reduce `scan_top_n`.
- `Qty rounded to 0` → margin too small for price; stepSize lot filter.
- No signals for long time → volatility low; score threshold 68 is strict for high probability - check volatility table.
- Positions not auto-closing in **paper** → TP/SL hit is checked on next 5m high/low; wait one candle.
- Logs location: Dashboard → Logs panel + `logs/bot.log` + `data/trades.db` (sqlite).

---

## Development

```bash
pip install -r requirements.txt
uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
# Frontend is static; edit frontend/index.html and refresh.
```

Tests (manual):
```bash
curl http://localhost:8000/api/health
curl http://localhost:8000/api/ip
curl http://localhost:8000/api/scanner/volatility
```

---

## Disclaimer

Crypto futures are high risk with leverage. This bot is for educational purposes. Past performance ≠ future. Start with **Testnet + Paper + small margin ($2)**. The authors are not responsible for losses. Use at your own risk.

---

## License

MIT - Trade Master

Built with passion for HVN + Absorption + Imbalance L3 ❤️
