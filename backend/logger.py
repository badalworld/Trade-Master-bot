import logging
import sqlite3
from pathlib import Path
from datetime import datetime
import json

BASE_DIR = Path(__file__).parent.parent
LOG_FILE = BASE_DIR / "logs" / "bot.log"
DB_FILE = BASE_DIR / "data" / "trades.db"

# Setup python logger
logger = logging.getLogger("trade_master")
logger.setLevel(logging.DEBUG)

_formatter = logging.Formatter('%(asctime)s | %(levelname)s | %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

# File handler
fh = logging.FileHandler(LOG_FILE)
fh.setLevel(logging.DEBUG)
fh.setFormatter(_formatter)
logger.addHandler(fh)

# Console handler
ch = logging.StreamHandler()
ch.setLevel(logging.INFO)
ch.setFormatter(_formatter)
logger.addHandler(ch)

def get_db():
    conn = sqlite3.connect(str(DB_FILE))
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT,
        side TEXT,
        entry_price REAL,
        exit_price REAL,
        quantity REAL,
        margin REAL,
        leverage INTEGER,
        pnl REAL,
        pnl_percent REAL,
        status TEXT,
        entry_time TEXT,
        exit_time TEXT,
        tp_price REAL,
        sl_price REAL,
        reason TEXT,
        hvn_level REAL,
        absorption_score REAL,
        imbalance_levels TEXT,
        signal_score REAL,
        is_win INTEGER
    )
    """)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        symbol TEXT,
        direction TEXT,
        score REAL,
        price REAL,
        hvn REAL,
        absorption REAL,
        imbalance REAL,
        volatility REAL,
        tp REAL,
        sl REAL,
        details TEXT
    )
    """)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        level TEXT,
        message TEXT,
        module TEXT
    )
    """)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value TEXT
    )
    """)
    conn.commit()
    conn.close()
    logger.info("Database initialized")

def db_log(level: str, message: str, module: str = "bot"):
    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("INSERT INTO logs (timestamp, level, message, module) VALUES (?, ?, ?, ?)",
                    (datetime.utcnow().isoformat(), level, message, module))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.error(f"Failed to write db log: {e}")
    # also python logger
    if level == "ERROR":
        logger.error(f"[{module}] {message}")
    elif level == "WARNING":
        logger.warning(f"[{module}] {message}")
    else:
        logger.info(f"[{module}] {message}")

def log_trade(trade: dict):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
    INSERT INTO trades (symbol, side, entry_price, exit_price, quantity, margin, leverage, pnl, pnl_percent, status, entry_time, exit_time, tp_price, sl_price, reason, hvn_level, absorption_score, imbalance_levels, signal_score, is_win)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        trade.get("symbol"), trade.get("side"), trade.get("entry_price"), trade.get("exit_price"),
        trade.get("quantity"), trade.get("margin"), trade.get("leverage"), trade.get("pnl"), trade.get("pnl_percent"),
        trade.get("status"), trade.get("entry_time"), trade.get("exit_time"), trade.get("tp_price"), trade.get("sl_price"),
        trade.get("reason"), trade.get("hvn_level"), trade.get("absorption_score"), json.dumps(trade.get("imbalance_levels", [])),
        trade.get("signal_score"), trade.get("is_win")
    ))
    conn.commit()
    conn.close()

def update_trade_exit(trade_id: int, exit_price: float, pnl: float, pnl_percent: float, status: str, exit_time: str, is_win: int):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("UPDATE trades SET exit_price=?, pnl=?, pnl_percent=?, status=?, exit_time=?, is_win=? WHERE id=?",
                (exit_price, pnl, pnl_percent, status, exit_time, is_win, trade_id))
    conn.commit()
    conn.close()

def get_recent_logs(limit=200):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM logs ORDER BY id DESC LIMIT ?", (limit,))
    rows = cur.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_recent_signals(limit=100):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM signals ORDER BY id DESC LIMIT ?", (limit,))
    rows = cur.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def save_signal(sig: dict):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
    INSERT INTO signals (timestamp, symbol, direction, score, price, hvn, absorption, imbalance, volatility, tp, sl, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        sig.get("timestamp"), sig.get("symbol"), sig.get("direction"), sig.get("score"), sig.get("price"),
        sig.get("hvn"), sig.get("absorption"), sig.get("imbalance"), sig.get("volatility"), sig.get("tp"), sig.get("sl"),
        json.dumps(sig.get("details", {}))
    ))
    conn.commit()
    conn.close()

init_db()
