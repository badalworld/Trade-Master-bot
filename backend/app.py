from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import httpx
import socket
import asyncio
from pathlib import Path
from datetime import datetime
import sqlite3

from .config import load_config, save_config
from .binance_client import binance_client, rate_limiter
from .logger import get_db, get_recent_logs, get_recent_signals, db_log
from .scanner import scanner
from .trader import trader
from .risk_manager import risk_manager

app = FastAPI(title="Trade Master Bot", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DATA_DIR = BASE_DIR / "data"

class SettingsRequest(BaseModel):
    binance_api_key: str = ""
    binance_api_secret: str = ""
    testnet: bool = True
    base_margin: float = 2.0
    leverage: int = 10
    max_open_trades: int = 5
    scan_interval_seconds: int = 15
    scan_top_n: int = 25
    compounding_enabled: bool = True
    compounding_percent: float = 20
    paper_trading: bool = True

@app.get("/api/health")
async def health():
    return {"status": "ok", "time": datetime.utcnow().isoformat()}

@app.get("/api/ip")
async def get_ip():
    # Get server ipv4
    try:
        hostname = socket.gethostname()
        local_ip = socket.gethostbyname(hostname)
    except:
        local_ip = "127.0.0.1"
    
    # Try to get public ip via ipify
    public_ip = None
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get("https://api.ipify.org?format=json")
            if r.status_code == 200:
                public_ip = r.json().get("ip")
    except:
        pass
    
    # Also try to get via headers if behind proxy (not needed)
    return {
        "local_ip": local_ip,
        "public_ip": public_ip or local_ip,
        "hostname": hostname,
        "note": "Add this IPv4 to Binance API whitelist: https://www.binance.com/en/my/settings/api-management"
    }

@app.get("/api/settings")
async def get_settings():
    cfg = load_config()
    # Mask secret
    masked = cfg.copy()
    if masked.get("binance_api_secret"):
        masked["binance_api_secret_masked"] = masked["binance_api_secret"][:4] + "****" + masked["binance_api_secret"][-4:] if len(masked["binance_api_secret"]) > 8 else "****"
    return masked

@app.post("/api/settings")
async def update_settings(req: SettingsRequest):
    cfg = load_config()
    update = req.dict()
    # If secret empty, keep old one
    if not update.get("binance_api_secret"):
        update["binance_api_secret"] = cfg.get("binance_api_secret", "")
    # Validate
    if update["base_margin"] < 1:
        raise HTTPException(400, "Base margin must be >=1")
    if update["leverage"] < 1 or update["leverage"] > 125:
        raise HTTPException(400, "Leverage 1-125")
    
    new_cfg = {**cfg, **update}
    save_config(new_cfg)
    
    # Update binance client
    binance_client.update_credentials(new_cfg["binance_api_key"], new_cfg["binance_api_secret"], new_cfg["testnet"])
    
    db_log("INFO", f"Settings updated testnet={new_cfg['testnet']} paper={new_cfg['paper_trading']} margin=${new_cfg['base_margin']} lev={new_cfg['leverage']}x max_open={new_cfg['max_open_trades']}", "settings")
    return {"status": "saved", "config": new_cfg}

@app.get("/api/status")
async def get_status():
    cfg = load_config()
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM trades WHERE status='OPEN'")
    open_cnt = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM trades WHERE status='CLOSED'")
    closed_cnt = cur.fetchone()[0]
    cur.execute("SELECT SUM(pnl) as pnl FROM trades WHERE status='CLOSED'")
    total_pnl = cur.fetchone()[0] or 0
    conn.close()
    
    # Binance balance if keys present
    balance = None
    balance_info = None
    try:
        if cfg.get("binance_api_key"):
            bal = await binance_client.get_account_balance()
            if bal:
                # find USDT
                for b in bal:
                    if b.get("asset") == "USDT":
                        balance = float(b.get("balance", 0))
                        balance_info = b
                        break
    except Exception as e:
        db_log("WARNING", f"Balance fetch failed {e}", "api")
    
    return {
        "bot_enabled": cfg.get("bot_enabled", False),
        "trader_running": trader.running,
        "paper_trading": cfg.get("paper_trading", True),
        "testnet": cfg.get("testnet", True),
        "open_trades": open_cnt,
        "closed_trades": closed_cnt,
        "total_pnl": round(total_pnl, 2),
        "balance": balance,
        "balance_info": balance_info,
        "last_scan": scanner.last_scan_time,
        "rate_limit_usage": rate_limiter.current_usage(),
        "rate_limit_max": 2280,
        "uptime": trader.running,
        "config": {
            "base_margin": cfg.get("base_margin"),
            "leverage": cfg.get("leverage"),
            "max_open_trades": cfg.get("max_open_trades"),
            "scan_interval": cfg.get("scan_interval_seconds"),
            "scan_top_n": cfg.get("scan_top_n")
        }
    }

@app.post("/api/bot/start")
async def bot_start():
    ok = await trader.start()
    if not ok:
        return {"status": "already running"}
    return {"status": "started"}

@app.post("/api/bot/stop")
async def bot_stop():
    ok = await trader.stop()
    if not ok:
        return {"status": "already stopped"}
    return {"status": "stopped"}

@app.get("/api/scanner/volatility")
async def volatility_ranked():
    cfg = load_config()
    top_n = cfg.get("scan_top_n", 25)
    ranked = await scanner.get_volatility_ranked_symbols(top_n=top_n)
    return {"count": len(ranked), "data": ranked, "timestamp": datetime.utcnow().isoformat()}

@app.get("/api/scanner/results")
async def scanner_results():
    return {
        "last_scan": scanner.last_scan_time,
        "results": scanner.last_results,
        "count": len(scanner.last_results)
    }

@app.post("/api/scanner/scan-now")
async def scan_now():
    results = await scanner.full_scan()
    return {"count": len(results), "results": results}

@app.get("/api/positions")
async def get_positions():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM trades WHERE status='OPEN' ORDER BY entry_time DESC")
    rows = [dict(r) for r in cur.fetchall()]
    # Enrich with current price and unrealized pnl
    for r in rows:
        try:
            klines = await binance_client.get_klines(r['symbol'], interval="5m", limit=1)
            if klines:
                cur_price = klines[0]['close']
                r['current_price'] = cur_price
                entry = r['entry_price']
                qty = r['quantity']
                if r['side'] == 'LONG':
                    upnl = (cur_price - entry) * qty
                    upnl_pct = (cur_price - entry) / entry * 100 * r['leverage']
                else:
                    upnl = (entry - cur_price) * qty
                    upnl_pct = (entry - cur_price) / entry * 100 * r['leverage']
                r['unrealized_pnl'] = round(upnl, 4)
                r['unrealized_pnl_percent'] = round(upnl_pct, 2)
            else:
                r['current_price'] = r['entry_price']
                r['unrealized_pnl'] = 0
        except:
            r['current_price'] = r['entry_price']
            r['unrealized_pnl'] = 0
    conn.close()
    return {"count": len(rows), "data": rows}

@app.get("/api/history")
async def get_history(limit: int = 100):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM trades WHERE status='CLOSED' ORDER BY exit_time DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"count": len(rows), "data": rows}

@app.get("/api/signals")
async def get_signals(limit: int = 50):
    signals = get_recent_signals(limit)
    return {"count": len(signals), "data": signals}

@app.get("/api/logs")
async def get_logs(limit: int = 200):
    logs = get_recent_logs(limit)
    return {"count": len(logs), "data": logs}

@app.get("/api/risk")
async def get_risk():
    info = risk_manager.get_risk_info()
    # add explanation
    cfg = load_config()
    last_pnl = 0
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT pnl, is_win FROM trades WHERE status='CLOSED' ORDER BY id DESC LIMIT 1")
    row = cur.fetchone()
    if row:
        last_pnl = row[0] or 0
        is_win = row[1]
        if is_win == 1:
            info["last_trade"] = f"WIN (+${last_pnl:.2f}) -> next margin = ${cfg.get('base_margin')} + 20% * ${last_pnl:.2f} = ${info['next_margin']}"
        else:
            info["last_trade"] = f"LOSS (${last_pnl:.2f}) -> next margin reset to base ${info['next_margin']}"
    else:
        info["last_trade"] = "No trades yet, using base margin"
    conn.close()
    return info

@app.get("/api/klines")
async def get_klines(symbol: str = "BTCUSDT", interval: str = "5m", limit: int = 100):
    data = await binance_client.get_klines(symbol, interval, limit)
    if not data:
        raise HTTPException(500, "Failed to fetch klines")
    return {"symbol": symbol, "interval": interval, "data": data}

@app.get("/api/balance")
async def get_balance():
    cfg = load_config()
    if not cfg.get("binance_api_key"):
        # Paper balance simulated
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT SUM(pnl) FROM trades WHERE status='CLOSED'")
        pnl = cur.fetchone()[0] or 0
        conn.close()
        return {"mode": "paper", "balance": round(100 + pnl, 2), "pnl": round(pnl, 2), "note": "Paper trading mode - no real Binance keys"}
    bal = await binance_client.get_account_balance()
    if not bal:
        raise HTTPException(500, "Failed to fetch balance - check API keys")
    return {"mode": "live", "data": bal}

@app.delete("/api/trades/{trade_id}")
async def close_trade_manual(trade_id: int):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM trades WHERE id=? AND status='OPEN'", (trade_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Open trade not found")
    trade = dict(row)
    # Get current price to close
    klines = await binance_client.get_klines(trade['symbol'], interval="5m", limit=1)
    close_price = klines[0]['close'] if klines else trade['entry_price']
    qty = trade['quantity']
    entry = trade['entry_price']
    if trade['side'] == 'LONG':
        pnl = (close_price - entry) * qty
    else:
        pnl = (entry - close_price) * qty
    fee = close_price * qty * 0.0004
    pnl_net = pnl - fee
    is_win = 1 if pnl_net > 0 else 0
    update_trade_exit(trade_id, close_price, round(pnl_net,4), round(pnl_net/trade['margin']*100,2), "CLOSED", datetime.utcnow().isoformat(), is_win)
    conn = get_db()
    db_log("INFO", f"Manually closed trade {trade_id} {trade['symbol']} @ {close_price} PnL ${pnl_net:.2f}", "trader")
    return {"status": "closed", "pnl": pnl_net, "price": close_price}

@app.post("/api/reset/paper")
async def reset_paper():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("DELETE FROM trades")
    cur.execute("DELETE FROM signals")
    cur.execute("DELETE FROM logs")
    conn.commit()
    conn.close()
    db_log("INFO", "Paper trading data reset", "api")
    return {"status": "reset"}

# Mount frontend
if FRONTEND_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR / "assets") if (FRONTEND_DIR / "assets").exists() else str(FRONTEND_DIR)), name="assets")
    # Serve static frontend - catch all
    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        # If API path, let it 404
        if full_path.startswith("api/"):
            raise HTTPException(404, "Not found")
        # Serve index.html for SPA
        file_path = FRONTEND_DIR / full_path
        if full_path and file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
        # Default to index.html
        index = FRONTEND_DIR / "index.html"
        if index.exists():
            return FileResponse(str(index))
        return JSONResponse({"detail": "Frontend not found"}, status_code=404)

@app.on_event("startup")
async def startup():
    cfg = load_config()
    binance_client.update_credentials(cfg.get("binance_api_key",""), cfg.get("binance_api_secret",""), cfg.get("testnet", True))
    db_log("INFO", "Trade Master API started", "api")
    # Auto start bot if enabled in config
    if cfg.get("bot_enabled"):
        await trader.start()
