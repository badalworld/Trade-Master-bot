import asyncio
import pandas as pd
from typing import List, Dict
from .binance_client import binance_client, rate_limiter
from .indicators import analyze_symbol
from .logger import db_log, save_signal
from .config import load_config
from datetime import datetime

class Scanner:
    def __init__(self):
        self.is_scanning = False
        self.last_scan_time = None
        self.last_results: List[Dict] = []
        self.scan_task = None
    
    async def get_volatility_ranked_symbols(self, top_n: int = 25) -> List[Dict]:
        """
        Fetch 24hr tickers and rank by volatility for faster moves
        Volatility score = abs(priceChangePercent) * log(quoteVolume) + volatility factor
        """
        tickers = await binance_client.get_futures_tickers_24hr()
        if not tickers:
            db_log("ERROR", "Failed to fetch tickers for volatility ranking", "scanner")
            return []
        
        # Filter USDT perpetual only
        usdt_tickers = [t for t in tickers if t['symbol'].endswith('USDT')]
        
        ranked = []
        for t in usdt_tickers:
            try:
                price_change_pct = abs(float(t.get('priceChangePercent', 0)))
                quote_volume = float(t.get('quoteVolume', 0))
                volume = float(t.get('volume', 0))
                last_price = float(t.get('lastPrice', 0))
                high = float(t.get('highPrice', 0))
                low = float(t.get('lowPrice', 0))
                # Volatility metrics
                daily_range_pct = (high - low) / last_price * 100 if last_price else 0
                # Quote volume in millions
                vol_m = quote_volume / 1e6
                # Combined score: emphasize high daily range + high volume + high change%
                # Trading on high volatility assets sorting for faster move faster profit
                import math
                volatility_score = (price_change_pct * 0.4 + daily_range_pct * 0.4 + math.log(max(1, vol_m)) * 0.3) * (1 + math.log(max(1, volume/1e6))*0.1)
                # Boost for high volume (>50M)
                if vol_m > 50:
                    volatility_score *= 1.2
                if vol_m > 100:
                    volatility_score *= 1.1
                # Penalize stablecoins / low volatility
                if price_change_pct < 0.5 and daily_range_pct < 1:
                    volatility_score *= 0.5
                
                ranked.append({
                    "symbol": t['symbol'],
                    "price": last_price,
                    "priceChangePercent": price_change_pct,
                    "quoteVolume": quote_volume,
                    "volume": volume,
                    "high": high,
                    "low": low,
                    "daily_range_pct": daily_range_pct,
                    "volatility_score": volatility_score
                })
            except Exception as e:
                continue
        
        ranked_sorted = sorted(ranked, key=lambda x: x['volatility_score'], reverse=True)
        return ranked_sorted[:top_n]
    
    async def scan_symbol(self, symbol: str) -> Dict:
        klines = await binance_client.get_klines(symbol, interval="5m", limit=100)
        if not klines or len(klines) < 50:
            return None
        
        df = pd.DataFrame(klines)
        # Map to expected column names
        df.rename(columns={"open": "open", "high": "high", "low": "low", "close": "close", "volume": "volume"}, inplace=True)
        
        analysis = analyze_symbol(df)
        
        # Build result
        result = {
            "symbol": symbol,
            "price": analysis['current_price'],
            "score": analysis['score'],
            "direction": analysis['direction'],
            "is_high_prob": analysis['is_high_prob'],
            "volatility": analysis['volatility'],
            "tp": analysis['tp_price'],
            "sl": analysis['sl_price'],
            "hvn": analysis['hvn']['poc_price'],
            "hvn_strength": analysis['hvn']['hvn_strength'],
            "absorption_score": analysis['absorption']['score'],
            "absorption_type": analysis['absorption']['type'],
            "imbalance_score": analysis['imbalance']['score'],
            "reasons": analysis['reasons'],
            "analysis": analysis,
            "timestamp": datetime.utcnow().isoformat()
        }
        
        # Save high prob signals to DB
        if analysis['is_high_prob'] and analysis['direction']:
            save_signal({
                "timestamp": result['timestamp'],
                "symbol": symbol,
                "direction": analysis['direction'],
                "score": analysis['score'],
                "price": analysis['current_price'],
                "hvn": analysis['hvn']['poc_price'],
                "absorption": analysis['absorption']['score'],
                "imbalance": analysis['imbalance']['score'],
                "volatility": analysis['volatility'],
                "tp": analysis['tp_price'],
                "sl": analysis['sl_price'],
                "details": {"reasons": analysis['reasons'][:5], "votes": analysis['direction_votes']}
            })
        
        return result
    
    async def full_scan(self) -> List[Dict]:
        cfg = load_config()
        top_n = int(cfg.get("scan_top_n", 25))
        
        db_log("INFO", f"Starting full scan top {top_n} volatile pairs", "scanner")
        
        ranked = await self.get_volatility_ranked_symbols(top_n=top_n*2)  # get more to allow filtering
        if not ranked:
            return []
        
        # Select top_n for scanning to respect 95% rate limit
        scan_list = ranked[:top_n]
        symbols = [x['symbol'] for x in scan_list]
        
        db_log("INFO", f"Scanning {len(symbols)} symbols: {', '.join(symbols[:5])}...", "scanner")
        
        # Create quick map for volatility
        vol_map = {x['symbol']: x for x in ranked}
        
        results = []
        # Scan sequentially with small delay to spread weight, or concurrent with limit
        # We'll do batch of 5 concurrent to stay efficient
        semaphore = asyncio.Semaphore(5)
        
        async def scan_with_sem(sym):
            async with semaphore:
                res = await self.scan_symbol(sym)
                if res:
                    # enrich with volatility ranking data
                    vol_info = vol_map.get(sym, {})
                    res['volatility_score'] = vol_info.get('volatility_score', 0)
                    res['priceChangePercent'] = vol_info.get('priceChangePercent', 0)
                    res['quoteVolume'] = vol_info.get('quoteVolume', 0)
                    res['daily_range_pct'] = vol_info.get('daily_range_pct', 0)
                # small delay to respect ordering
                await asyncio.sleep(0.1)
                return res
        
        tasks = [scan_with_sem(s) for s in symbols]
        raw_results = await asyncio.gather(*tasks)
        
        for r in raw_results:
            if r:
                results.append(r)
        
        # Sort by score + volatility composite for best signals
        # High-probability signals first, then by score and volatility
        results_sorted = sorted(results, key=lambda x: (
            x['is_high_prob'],  # True first
            x['score'],
            x['volatility'],
            x['volatility_score']
        ), reverse=True)
        
        # Also sort volatility table separately
        self.last_results = results_sorted
        self.last_scan_time = datetime.utcnow().isoformat()
        
        # Log top signals
        high_prob = [r for r in results_sorted if r['is_high_prob']]
        if high_prob:
            for hp in high_prob[:3]:
                db_log("INFO", f"SIGNAL {hp['symbol']} {hp['direction']} score {hp['score']:.1f} vol {hp['volatility']:.2f}% TP {hp['tp']:.4f} SL {hp['sl']:.4f} reasons: {'; '.join(hp['reasons'][:2])}", "scanner")
        else:
            db_log("INFO", f"Scan complete: no high-prob signals top score {results_sorted[0]['score']:.1f} {results_sorted[0]['symbol']}" if results_sorted else "Scan complete: no results", "scanner")
        
        db_log("INFO", f"Scan finished {len(results_sorted)} pairs scanned, weight usage {rate_limiter.current_usage()}/{500}", "scanner")
        return results_sorted

scanner = Scanner()
