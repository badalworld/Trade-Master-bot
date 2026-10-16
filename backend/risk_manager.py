from typing import Optional, Dict
import sqlite3
from pathlib import Path
from .config import load_config
from .logger import get_db

DB_FILE = Path(__file__).parent.parent / "data" / "trades.db"

class RiskManager:
    def __init__(self):
        self.cfg = load_config()
    
    def refresh(self):
        self.cfg = load_config()
    
    def get_next_margin(self) -> float:
        """
        Spec: When we win a trade next trade margin increase 20% of my profit amount not my balance.
              If we loss one trade our base margin fixed. Compounding to increase capital.
        Interpret as: next_margin = base_margin + 0.2 * last_win_profit
                      if last trade was loss -> reset to base
        If compounding disabled -> always base
        """
        cfg = load_config()
        base = float(cfg.get("base_margin", 2.0))
        compounding_percent = float(cfg.get("compounding_percent", 20))
        compounding_enabled = cfg.get("compounding_enabled", True)
        
        if not compounding_enabled:
            return base
        
        conn = sqlite3.connect(str(DB_FILE))
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT pnl, is_win, status FROM trades WHERE status='CLOSED' ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        conn.close()
        
        if not row:
            return base
        
        # if last trade was win, add 20% of its profit
        if row["is_win"] == 1 and row["pnl"] and row["pnl"] > 0:
            bonus = float(row["pnl"]) * (compounding_percent / 100)
            next_margin = base + bonus
            # Cap max margin to avoid oversized? maybe 2x base or 10$?
            # But spec says compounding to increase capital, so allow growth but limit to 10x base for safety
            max_margin = base * 5  # allow up to 5x base
            next_margin = min(next_margin, max_margin)
            # Ensure at least base
            next_margin = max(base, next_margin)
            # round to 2 decimals
            return round(next_margin, 2)
        else:
            # loss -> reset
            return base
    
    def calculate_position_qty(self, entry_price: float, margin: float, leverage: int) -> float:
        notional = margin * leverage
        qty = notional / entry_price if entry_price > 0 else 0
        # Binance qty precision: need to handle but for now 3 decimals
        # We'll round to appropriate precision later via symbol filters
        return round(qty, 6)
    
    def can_open_new_trade(self, current_open: int) -> bool:
        cfg = load_config()
        max_open = int(cfg.get("max_open_trades", 5))
        return current_open < max_open
    
    def get_risk_info(self) -> Dict:
        cfg = load_config()
        conn = sqlite3.connect(str(DB_FILE))
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) as cnt FROM trades WHERE status='OPEN'")
        open_cnt = cur.fetchone()["cnt"]
        cur.execute("SELECT SUM(pnl) as total_pnl FROM trades WHERE status='CLOSED'")
        total_pnl = cur.fetchone()["total_pnl"] or 0
        cur.execute("SELECT COUNT(*) as total, SUM(CASE WHEN is_win=1 THEN 1 ELSE 0 END) as wins FROM trades WHERE status='CLOSED'")
        row = cur.fetchone()
        total = row["total"] or 0
        wins = row["wins"] or 0
        win_rate = (wins/total*100) if total>0 else 0
        conn.close()
        
        next_margin = self.get_next_margin()
        
        return {
            "base_margin": cfg.get("base_margin"),
            "leverage": cfg.get("leverage"),
            "next_margin": next_margin,
            "max_open_trades": cfg.get("max_open_trades"),
            "current_open": open_cnt,
            "total_pnl": round(total_pnl, 2),
            "win_rate": round(win_rate, 1),
            "total_trades": total,
            "compounding_enabled": cfg.get("compounding_enabled"),
            "compounding_percent": cfg.get("compounding_percent")
        }

risk_manager = RiskManager()
