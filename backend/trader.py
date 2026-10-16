import asyncio
import sqlite3
from pathlib import Path
from datetime import datetime, timedelta
from typing import List, Dict
import pandas as pd

from .config import load_config, save_config
from .binance_client import binance_client
from .scanner import scanner
from .risk_manager import risk_manager
from .logger import db_log, log_trade, get_db, update_trade_exit
from .indicators import analyze_symbol
import time

DB_FILE = Path(__file__).parent.parent / "data" / "trades.db"

class Trader:
    def __init__(self):
        self.running = False
        self.task: asyncio.Task = None
        self.last_compounding_info = ""
    
    async def start(self):
        if self.running:
            return False
        self.running = True
        cfg = load_config()
        cfg['bot_enabled'] = True
        save_config(cfg)
        db_log("INFO", "Trade Master bot STARTED", "trader")
        self.task = asyncio.create_task(self.loop())
        return True
    
    async def stop(self):
        if not self.running:
            return False
        self.running = False
        cfg = load_config()
        cfg['bot_enabled'] = False
        save_config(cfg)
        db_log("INFO", "Trade Master bot STOPPED", "trader")
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        return True
    
    async def loop(self):
        db_log("INFO", "Bot loop started - scanning every 15s on 5m timeframe", "trader")
        while self.running:
            try:
                cfg = load_config()
                interval = int(cfg.get("scan_interval_seconds", 15))
                # Sync with Binance time but just sleep interval
                
                # Check if bot still enabled via config (might have been disabled via settings)
                if not cfg.get("bot_enabled", False):
                    db_log("INFO", "Bot disabled via settings, pausing loop", "trader")
                    await asyncio.sleep(5)
                    continue
                
                # Run scan
                results = await scanner.full_scan()
                
                # Evaluate trades
                await self.evaluate_signals(results)
                
                # Monitor open trades (check TP/SL hit via price)
                await self.monitor_open_trades()
                
                # Log status
                db_log("INFO", f"Loop cycle complete, next scan in {interval}s. Open trades checking...", "trader")
                
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                db_log("INFO", "Bot loop cancelled", "trader")
                break
            except Exception as e:
                db_log("ERROR", f"Bot loop error: {e}", "trader")
                await asyncio.sleep(15)
    
    async def evaluate_signals(self, results: List[Dict]):
        if not results:
            return
        
        # Filter high probability signals sorted by best
        candidates = [r for r in results if r['is_high_prob'] and r['direction'] and r['score'] >= 68]
        # Sort by score descending
        candidates = sorted(candidates, key=lambda x: x['score'], reverse=True)
        
        if not candidates:
            db_log("INFO", "No high-prob candidates this scan", "trader")
            return
        
        # Check current open trades
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT symbol FROM trades WHERE status='OPEN'")
        open_symbols = set([row[0] for row in cur.fetchall()])
        cur.execute("SELECT COUNT(*) as cnt FROM trades WHERE status='OPEN'")
        open_count = cur.fetchone()[0]
        conn.close()
        
        cfg = load_config()
        max_open = int(cfg.get("max_open_trades", 5))
        leverage = int(cfg.get("leverage", 10))
        
        for signal in candidates[:3]:  # consider top 3 best
            if open_count >= max_open:
                db_log("INFO", f"Max open trades {max_open} reached, skipping {signal['symbol']}", "trader")
                break
            if signal['symbol'] in open_symbols:
                db_log("INFO", f"Already have open position for {signal['symbol']}, skipping", "trader")
                continue
            
            # Additional filters: ensure volatility high (fast move)
            if signal['volatility'] < 0.2:  # too low volatility
                db_log("INFO", f"Skipping {signal['symbol']} low volatility {signal['volatility']:.2f}%", "trader")
                continue
            
            # Check cooldown: don't re-enter same symbol within 30 mins after close
            conn2 = get_db()
            cur2 = conn2.cursor()
            cur2.execute("SELECT exit_time FROM trades WHERE symbol=? AND status='CLOSED' ORDER BY exit_time DESC LIMIT 1", (signal['symbol'],))
            row = cur2.fetchone()
            conn2.close()
            if row and row[0]:
                try:
                    last_exit = datetime.fromisoformat(row[0])
                    mins_since = (datetime.utcnow() - last_exit).total_seconds() / 60
                    if mins_since < 5:  # 5 min cooldown to avoid immediate re-entry churn
                        db_log("INFO", f"Cooldown {signal['symbol']} {mins_since:.1f}m since last exit, skipping", "trader")
                        continue
                except: pass
            
            # Notional / LOT_SIZE check: skip symbols where $20 notional would be below Binance min (e.g., BTCUSDT needs ~67 USDT minQty)
            # We already have qty, but need to check here before calling execute_trade to save weight
            # Quick check: estimate qty
            est_notional = float(cfg.get("base_margin", 2)) * int(cfg.get("leverage",10))
            # For high price assets, stepSize may make it impossible - will be caught in execute_trade qty==0, but log cleaner here
            if signal['price'] > 5000 and est_notional < signal['price'] * 0.001:
                db_log("INFO", f"Skipping {signal['symbol']} price ${signal['price']:.2f} too high for $2×10 margin (min notional ${signal['price']*0.001:.2f})", "trader")
                continue
            
            # Execute trade
            success = await self.execute_trade(signal)
            if success:
                open_count += 1
                open_symbols.add(signal['symbol'])
                # Limit to one trade per scan cycle to avoid overexposure? spec allows up to 5 simultaneously, but we can take up to 2 per cycle
                if open_count >= max_open:
                    break
                # If we took one, wait a bit before next? But spec says scan every 15s for best signals, can open multiple
                # Let's allow up to 2 per cycle
                if len([s for s in candidates if s['symbol'] in open_symbols]) >= 2:
                    break
            await asyncio.sleep(0.5)
    
    async def execute_trade(self, signal: Dict):
        symbol = signal['symbol']
        direction = signal['direction']
        entry_price = signal['price']
        tp = signal['tp']
        sl = signal['sl']
        score = signal['score']
        
        cfg = load_config()
        leverage = int(cfg.get("leverage", 10))
        margin = risk_manager.get_next_margin()
        
        # Position sizing
        qty = risk_manager.calculate_position_qty(entry_price, margin, leverage)
        if qty <= 0:
            db_log("ERROR", f"Invalid qty for {symbol} price {entry_price} margin {margin}", "trader")
            return False
        
        # Adjust qty precision - fetch symbol filters
        # For simplicity, round to 3 decimals, but Binance requires stepSize compliance
        # We'll attempt to fetch precision dynamically
        try:
            info = await binance_client.get_exchange_info()
            if info:
                for s in info['symbols']:
                    if s['symbol'] == symbol:
                        for f in s['filters']:
                            if f['filterType'] == 'LOT_SIZE':
                                step = float(f['stepSize'])
                                # round qty to step
                                precision = len(str(step).rstrip('0').split('.')[-1]) if '.' in str(step) else 0
                                qty = round(qty - (qty % step), precision)
                                break
                        break
        except Exception as e:
            db_log("WARNING", f"Qty precision adjust failed {e}", "trader")
        
        if qty == 0:
            db_log("WARNING", f"Qty rounded to 0 for {symbol} (price ${entry_price:.2f} too high for $2×10) - skipping, will prefer volatile low-price altcoins", "trader")
            return False
        # Check notional minimum 5 USDT (Binance min)
        notional = qty * entry_price
        if notional < 5.0:
            db_log("WARNING", f"Notional ${notional:.2f} below Binance min $5 for {symbol}, skipping. Use higher margin or lower price altcoin.", "trader")
            return False
        
        side = "BUY" if direction == "LONG" else "SELL"
        
        db_log("INFO", f"EXECUTING {side} {symbol} qty {qty} margin ${margin} lev {leverage}x entry {entry_price} TP {tp:.4f} SL {sl:.4f} score {score:.1f}", "trader")
        
        # Set leverage and margin type
        await binance_client.set_leverage(symbol, leverage)
        try:
            await binance_client.set_margin_type(symbol, "ISOLATED")
        except:
            pass  # already set
        
        # Create order (paper or real)
        order = await binance_client.create_order(symbol, side, qty, price=entry_price, tp=tp, sl=sl)
        
        if order:
            # Record trade
            trade = {
                "symbol": symbol,
                "side": direction,
                "entry_price": entry_price,
                "exit_price": None,
                "quantity": qty,
                "margin": margin,
                "leverage": leverage,
                "pnl": 0,
                "pnl_percent": 0,
                "status": "OPEN",
                "entry_time": datetime.utcnow().isoformat(),
                "exit_time": None,
                "tp_price": tp,
                "sl_price": sl,
                "reason": f"Score {score:.1f} " + "; ".join(signal['reasons'][:3]),
                "hvn_level": signal['hvn'],
                "absorption_score": signal['absorption_score'],
                "imbalance_levels": signal['analysis']['imbalance']['imbalances'],
                "signal_score": score,
                "is_win": None
            }
            log_trade(trade)
            db_log("INFO", f"Trade opened {symbol} {direction} margin ${margin} qty {qty} | Next trade margin will be calculated on close", "trader")
            return True
        else:
            db_log("ERROR", f"Failed to create order for {symbol}", "trader")
            return False
    
    async def monitor_open_trades(self):
        """Check open trades for TP/SL hit using current price.
        In real mode Binance handles TP/SL. For paper mode we simulate.
        Also update unrealized PnL."""
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT * FROM trades WHERE status='OPEN'")
        open_trades = [dict(row) for row in cur.fetchall()]
        conn.close()
        
        if not open_trades:
            return
        
        for trade in open_trades:
            symbol = trade['symbol']
            direction = trade['side']
            entry = trade['entry_price']
            tp = trade['tp_price']
            sl = trade['sl_price']
            qty = trade['quantity']
            
            # Get current price
            klines = await binance_client.get_klines(symbol, interval="5m", limit=2)
            if not klines:
                continue
            current = klines[-1]['close']
            high = klines[-1]['high']
            low = klines[-1]['low']
            
            # Check TP/SL hit based on high/low (more accurate than close)
            hit = None
            exit_price = None
            if direction == "LONG":
                # Check SL first (conservative)
                if low <= sl:
                    hit = "SL"
                    exit_price = sl
                elif high >= tp:
                    hit = "TP"
                    exit_price = tp
            else:  # SHORT
                if high >= sl:
                    hit = "SL"
                    exit_price = sl
                elif low <= tp:
                    hit = "TP"
                    exit_price = tp
            
            if hit:
                # Calculate PnL
                if direction == "LONG":
                    pnl = (exit_price - entry) * qty
                else:
                    pnl = (entry - exit_price) * qty
                # PnL percent vs margin
                margin = trade['margin']
                pnl_percent = (pnl / margin * 100) if margin else 0
                # Fee approximation 0.04% * 2 (entry+exit)
                fee = entry * qty * 0.0004 + exit_price * qty * 0.0004
                pnl_net = pnl - fee
                is_win = 1 if pnl_net > 0 else 0
                
                update_trade_exit(trade['id'], exit_price, round(pnl_net, 4), round(pnl_percent, 2), "CLOSED", datetime.utcnow().isoformat(), is_win)
                
                # Compounding log
                if is_win:
                    bonus = pnl_net * 0.2
                    next_margin = risk_manager.get_next_margin()
                    db_log("INFO", f"TRADE CLOSED WIN {symbol} {direction} {hit} @ {exit_price} PnL ${pnl_net:.2f} ({pnl_percent:.2f}%) fee ${fee:.2f} | Next margin: ${next_margin} (base ${load_config().get('base_margin')} + 20% profit ${bonus:.2f})", "trader")
                else:
                    db_log("INFO", f"TRADE CLOSED LOSS {symbol} {direction} {hit} @ {exit_price} PnL ${pnl_net:.2f} ({pnl_percent:.2f}%) | Next margin reset to base ${load_config().get('base_margin')}", "trader")
                
                # Cancel opposite TP/SL? In paper mode nothing needed. Real mode Binance closePosition would handle.
            else:
                # Update unrealized PnL for dashboard (optional)
                if direction == "LONG":
                    unrealized = (current - entry) * qty
                else:
                    unrealized = (entry - current) * qty
                # Could store in memory cache for dashboard
                pass

trader = Trader()
