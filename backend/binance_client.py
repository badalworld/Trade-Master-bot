import time
import hmac
import hashlib
import httpx
import json
import random
from urllib.parse import urlencode
from typing import Dict, List, Optional
from .config import BINANCE_FAPI_BASE, BINANCE_FAPI_TESTNET, SAFE_WEIGHT_LIMIT, MAX_WEIGHT_PER_MINUTE
from .logger import db_log
import asyncio

# Mock data for offline/demo when Binance host is blocked (arena sandbox only allows github/pypi)
MOCK_SYMBOLS = [
    "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT",
    "DOTUSDT","MATICUSDT","LINKUSDT","LTCUSDT","TRXUSDT","UNIUSDT","ATOMUSDT","ETCUSDT",
    "FILUSDT","XLMUSDT","APTUSDT","ARBUSDT","OPUSDT","NEARUSDT","AAVEUSDT","ALGOUSDT",
    "SUIUSDT","PEPEUSDT","SHIBUSDT","INJUSDT","RNDRUSDT","SEIUSDT","TIAUSDT","STXUSDT",
    "CFXUSDT","MINAUSDT","WLDUSDT","FETUSDT"
]
MOCK_BASE_PRICES = {
    "BTCUSDT": 67200, "ETHUSDT": 3240, "BNBUSDT": 615, "SOLUSDT": 178, "XRPUSDT": 0.52,
    "DOGEUSDT": 0.162, "ADAUSDT": 0.48, "AVAXUSDT": 36.5, "DOTUSDT": 7.2, "MATICUSDT": 0.62,
    "LINKUSDT": 17.8, "LTCUSDT": 84, "TRXUSDT": 0.11, "UNIUSDT": 11.2, "ATOMUSDT": 10.1,
    "ETCUSDT": 26.4, "FILUSDT": 6.8, "XLMUSDT": 0.11, "APTUSDT": 9.2, "ARBUSDT": 1.18,
    "OPUSDT": 3.1, "NEARUSDT": 7.3, "AAVEUSDT": 132, "ALGOUSDT": 0.21, "SUIUSDT": 1.65,
    "PEPEUSDT": 0.0000081, "SHIBUSDT": 0.000022, "INJUSDT": 28.4, "RNDRUSDT": 11.9,
    "SEIUSDT": 0.52, "TIAUSDT": 11.3, "STXUSDT": 2.1, "CFXUSDT": 0.22, "MINAUSDT": 0.85,
    "WLDUSDT": 5.4, "FETUSDT": 2.45
}
_mock_kline_cache = {}

def _mock_klines(symbol: str, limit: int = 100):
    """Generate realistic mock klines with patterns that sometimes trigger signals"""
    now_ms = int(time.time()*1000)
    interval_ms = 5*60*1000
    base = MOCK_BASE_PRICES.get(symbol, random.uniform(1, 100))
    # Use symbol hash to seed for consistent but varied evolution
    seed = hash(symbol) % 10000
    rnd = random.Random(seed + int(time.time() // 300) )  # changes slowly
    klines = []
    price = base
    # generate trend: some symbols trending volatile to trigger signals
    # Pick regime: high_vol symbols will have patterns
    volatility_rank = {
        "BTCUSDT": 0.015, "ETHUSDT": 0.018, "SOLUSDT": 0.035, "PEPEUSDT": 0.065, "WLDUSDT": 0.045,
        "FETUSDT": 0.04, "SEIUSDT": 0.03, "TIAUSDT": 0.038, "INJUSDT": 0.032, "RNDRUSDT": 0.03
    }
    base_vol = volatility_rank.get(symbol, rnd.uniform(0.008, 0.025))
    for i in range(limit):
        open_time = now_ms - (limit - i) * interval_ms
        # regime changes
        # inject specific patterns for demonstration at recent candles
        is_recent = i >= limit - 5
        high_vol_spike = False
        # 30% chance recent candle is absorption pattern for top volatile symbols
        if is_recent and rnd.random() < 0.35 and symbol in ["BTCUSDT","SOLUSDT","PEPEUSDT","WLDUSDT","FETUSDT","BNBUSDT","ETHUSDT","TIAUSDT"]:
            # absorption: high volume small range
            change = rnd.uniform(-0.002, 0.002)
            vol_mult = rnd.uniform(2.0, 3.5)
            high = price * (1 + abs(change) + rnd.uniform(0.001, 0.004))
            low = price * (1 - abs(change) - rnd.uniform(0.001, 0.004))
            # force wick: upper/admin
            if rnd.random() > 0.5:
                # bearish absorption: high wick
                close = price * (1 + rnd.uniform(-0.002, 0.001))
                open_p = price * (1 + rnd.uniform(-0.001, 0.002))
            else:
                close = price * (1 + rnd.uniform(-0.001, 0.002))
                open_p = price * (1 + rnd.uniform(-0.002, 0.001))
            volume = rnd.uniform(800000, 3000000) * vol_mult
            # Occasionally create FVG gap
            if rnd.random() < 0.25:
                # gap up for bullish FVG
                if rnd.random() > 0.5 and i >= 2:
                    # make this candle low above second previous high
                    # will be handled by next loop; just enlarge gap
                    pass
        else:
            change = rnd.gauss(0, base_vol*0.4) * (1.5 if rnd.random()<0.1 else 1)
            # add momentum
            open_p = price
            close = open_p * (1 + change)
            high = max(open_p, close) * (1 + rnd.uniform(0, base_vol*0.5))
            low = min(open_p, close) * (1 - rnd.uniform(0, base_vol*0.5))
            volume = rnd.uniform(300000, 2500000) * (1 + abs(change)*50)
            # Inject FVG every ~20 candles
            if i % 20 == 3 and rnd.random() < 0.6:
                # bullish FVG: low above previous2 high
                if len(klines) >= 2:
                    prev2_high = klines[-2]['high']
                    # ensure gap
                    low = prev2_high * (1 + rnd.uniform(0.005, 0.012))
                    high = low * (1 + rnd.uniform(0.002, 0.008))
                    close = (low+high)/2 * (1 + rnd.uniform(-0.002,0.002))
                    open_p = low * (1 + rnd.uniform(0,0.003))
            elif i % 23 == 7 and rnd.random() < 0.6:
                # bearish FVG
                if len(klines) >= 2:
                    prev2_low = klines[-2]['low']
                    high = prev2_low * (1 - rnd.uniform(0.005, 0.012))
                    low = high * (1 - rnd.uniform(0.002, 0.008))
                    close = (low+high)/2
                    open_p = high * (1 - rnd.uniform(0,0.003))
        price = close
        klines.append({
            "open_time": open_time,
            "open": float(open_p),
            "high": float(high),
            "low": float(low),
            "close": float(close),
            "volume": float(volume),
            "close_time": open_time + interval_ms - 1,
            "quote_volume": float(volume * close),
            "trades": rnd.randint(5000, 50000),
            "taker_buy_base": float(volume * rnd.uniform(0.4, 0.6)),
            "taker_buy_quote": float(volume * close * rnd.uniform(0.4,0.6)),
        })
    # store to evolve smoothly
    _mock_kline_cache[symbol] = klines
    return klines

def _mock_tickers():
    tickers = []
    for symbol in MOCK_SYMBOLS:
        base = MOCK_BASE_PRICES.get(symbol, 10)
        klines = _mock_klines(symbol, limit=100)
        last_price = klines[-1]['close']
        # daily range from klines last 24h (288 *5m candles, but we have 100; approximate)
        high_24 = max(k['high'] for k in klines[-20:])
        low_24 = min(k['low'] for k in klines[-20:])
        price_change = (last_price - klines[-20]['open']) / klines[-20]['open'] * 100 if klines[-20]['open'] else 0
        quote_vol = sum(k['quote_volume'] for k in klines[-20:]) * (288/20) * random.uniform(0.8,1.3)
        tickers.append({
            "symbol": symbol,
            "priceChange": str(last_price - klines[-20]['open']),
            "priceChangePercent": str(round(price_change + random.uniform(-0.5,0.5), 3)),
            "lastPrice": str(round(last_price, 6)),
            "highPrice": str(round(high_24, 6)),
            "lowPrice": str(round(low_24, 6)),
            "volume": str(round(sum(k['volume'] for k in klines[-20:])* (288/20), 2)),
            "quoteVolume": str(round(quote_vol, 2)),
        })
    # sort will be done by scanner, but we return all
    return tickers

def _mock_exchange_info():
    symbols = []
    for s in MOCK_SYMBOLS:
        symbols.append({
            "symbol": s,
            "status": "TRADING",
            "contractType": "PERPETUAL",
            "quoteAsset": "USDT",
            "filters": [
                {"filterType": "LOT_SIZE", "stepSize": "0.001" if MOCK_BASE_PRICES.get(s,10) < 100 else "0.01"},
                {"filterType": "PRICE_FILTER", "tickSize": "0.01" if MOCK_BASE_PRICES.get(s,10) < 100 else "0.1"}
            ]
        })
    return {"symbols": symbols}

class RateLimiter:
    def __init__(self, max_weight_per_minute: int = SAFE_WEIGHT_LIMIT):
        self.max_weight = max_weight_per_minute
        self.window_weights = []  # list of (timestamp, weight)
        self.lock = asyncio.Lock()
    
    async def check_and_consume(self, weight: int):
        async with self.lock:
            now = time.time()
            # remove older than 60s
            self.window_weights = [(t, w) for t, w in self.window_weights if now - t < 60]
            current = sum(w for _, w in self.window_weights)
            if current + weight > self.max_weight:
                # need to wait
                oldest = min(t for t, _ in self.window_weights) if self.window_weights else now
                wait = 60 - (now - oldest) + 1
                db_log("WARNING", f"Rate limit approaching {current}/{self.max_weight}, waiting {wait:.1f}s", "rate_limiter")
                await asyncio.sleep(max(1, wait))
                # clean again
                now = time.time()
                self.window_weights = [(t, w) for t, w in self.window_weights if now - t < 60]
            self.window_weights.append((now, weight))
            return True
    
    def current_usage(self):
        now = time.time()
        self.window_weights = [(t, w) for t, w in self.window_weights if now - t < 60]
        return sum(w for _, w in self.window_weights)

rate_limiter = RateLimiter()

class BinanceClient:
    def __init__(self, api_key: str = "", api_secret: str = "", testnet: bool = True):
        self.api_key = api_key
        self.api_secret = api_secret
        self.testnet = testnet
        self.base_url = BINANCE_FAPI_TESTNET if testnet else BINANCE_FAPI_BASE
        self.client = httpx.AsyncClient(timeout=15)
        self.exchange_info_cache = None
        self.exchange_info_time = 0
    
    def update_credentials(self, api_key: str, api_secret: str, testnet: bool):
        self.api_key = api_key
        self.api_secret = api_secret
        self.testnet = testnet
        self.base_url = BINANCE_FAPI_TESTNET if testnet else BINANCE_FAPI_BASE
        db_log("INFO", f"Binance credentials updated testnet={testnet}", "binance")
    
    def _sign(self, params: dict):
        query = urlencode(params)
        sig = hmac.new(self.api_secret.encode(), query.encode(), hashlib.sha256).hexdigest()
        params['signature'] = sig
        return params
    
    async def _request(self, method: str, endpoint: str, params: dict = None, signed: bool = False, weight: int = 1):
        await rate_limiter.check_and_consume(weight)
        url = self.base_url + endpoint
        headers = {}
        if self.api_key:
            headers['X-MBX-APIKEY'] = self.api_key
        if params is None:
            params = {}
        if signed:
            params['timestamp'] = int(time.time() * 1000)
            params = self._sign(params)
        
        try:
            if method == "GET":
                r = await self.client.get(url, params=params, headers=headers)
            elif method == "POST":
                r = await self.client.post(url, params=params, headers=headers)
            elif method == "DELETE":
                r = await self.client.delete(url, params=params, headers=headers)
            else:
                r = await self.client.request(method, url, params=params, headers=headers)
            
            # Update weight usage from header if present
            used_weight = r.headers.get('x-mbx-used-weight-1m')
            if used_weight:
                db_log("INFO", f"Binance weight used: {used_weight}/{SAFE_WEIGHT_LIMIT}", "binance")
            
            if r.status_code != 200:
                db_log("WARNING", f"Binance {endpoint} status {r.status_code}: {r.text[:200]} (fallback to MOCK demo if needed)", "binance")
                return None
            return r.json()
        except Exception as e:
            # In sandbox, Binance host is blocked (only github/pypi allowed) -> fallback to MOCK is expected, don't spam ERROR
            db_log("WARNING", f"Binance {endpoint} unreachable ({e}) - using offline MOCK demo data (still simulates 95% limit & indicators)", "binance")
            return None
    
    async def get_exchange_info(self):
        if self.exchange_info_cache and time.time() - self.exchange_info_time < 3600:
            return self.exchange_info_cache
        data = await self._request("GET", "/fapi/v1/exchangeInfo", weight=10)
        if data:
            self.exchange_info_cache = data
            self.exchange_info_time = time.time()
            return data
        # fallback mock when Binance blocked or fails
        mock = _mock_exchange_info()
        self.exchange_info_cache = mock
        self.exchange_info_time = time.time()
        # mock exchangeInfo silent (already logged via _request warning)
        return mock
    
    async def get_futures_tickers_24hr(self):
        """Weight 40"""
        data = await self._request("GET", "/fapi/v1/ticker/24hr", weight=40)
        if data:
            return data
        return _mock_tickers()
    
    async def get_symbols(self):
        info = await self.get_exchange_info()
        if not info:
            return []
        symbols = []
        for s in info.get('symbols', []):
            if s['status'] == 'TRADING' and s['contractType'] == 'PERPETUAL' and s['quoteAsset'] == 'USDT':
                symbols.append(s['symbol'])
        return symbols
    
    async def get_klines(self, symbol: str, interval: str = "5m", limit: int = 100):
        """Weight 2 per symbol"""
        data = await self._request("GET", "/fapi/v1/klines", params={"symbol": symbol, "interval": interval, "limit": limit}, weight=2)
        if data:
            # Convert to dict format
            klines = []
            for k in data:
                klines.append({
                    "open_time": k[0],
                    "open": float(k[1]),
                    "high": float(k[2]),
                    "low": float(k[3]),
                    "close": float(k[4]),
                    "volume": float(k[5]),
                    "close_time": k[6],
                    "quote_volume": float(k[7]),
                    "trades": k[8],
                    "taker_buy_base": float(k[9]),
                    "taker_buy_quote": float(k[10]),
                })
            return klines
        # fallback mock klines (already consumed weight via _request) - silent to avoid log spam
        return _mock_klines(symbol, limit=limit)
    
    async def get_orderbook(self, symbol: str, limit: int = 20):
        data = await self._request("GET", "/fapi/v1/depth", params={"symbol": symbol, "limit": limit}, weight=5)
        return data
    
    async def get_account_balance(self):
        if not self.api_key or not self.api_secret:
            return None
        data = await self._request("GET", "/fapi/v2/balance", signed=True, weight=5)
        return data
    
    async def get_position_risk(self):
        if not self.api_key or not self.api_secret:
            return None
        data = await self._request("GET", "/fapi/v2/positionRisk", signed=True, weight=5)
        return data
    
    async def get_open_orders(self, symbol: str = None):
        if not self.api_key or not self.api_secret:
            return None
        params = {}
        if symbol:
            params['symbol'] = symbol
        data = await self._request("GET", "/fapi/v1/openOrders", params=params, signed=True, weight=5)
        return data
    
    async def set_leverage(self, symbol: str, leverage: int):
        if not self.api_key or not self.api_secret:
            db_log("WARNING", "No API keys, skip set leverage", "binance")
            return {"symbol": symbol, "leverage": leverage, "paper": True}
        data = await self._request("POST", "/fapi/v1/leverage", params={"symbol": symbol, "leverage": leverage}, signed=True, weight=1)
        return data
    
    async def set_margin_type(self, symbol: str, margin_type: str = "ISOLATED"):
        if not self.api_key or not self.api_secret:
            return {"paper": True}
        data = await self._request("POST", "/fapi/v1/marginType", params={"symbol": symbol, "marginType": margin_type}, signed=True, weight=1)
        return data
    
    async def create_order(self, symbol: str, side: str, quantity: float, price: float = None, order_type: str = "MARKET", tp: float = None, sl: float = None):
        """
        Simulated or real order. For futures, use MARKET entry with TP/SL as separate orders.
        """
        if not self.api_key or not self.api_secret:
            db_log("INFO", f"PAPER ORDER {symbol} {side} qty {quantity} @ {price} TP {tp} SL {sl}", "trader")
            return {
                "symbol": symbol,
                "side": side,
                "origQty": str(quantity),
                "price": str(price or 0),
                "status": "FILLED",
                "paper": True,
                "orderId": int(time.time()*1000)
            }
        params = {
            "symbol": symbol,
            "side": side,
            "type": order_type,
            "quantity": quantity
        }
        if order_type == "LIMIT" and price:
            params["price"] = price
            params["timeInForce"] = "GTC"
        
        data = await self._request("POST", "/fapi/v1/order", params=params, signed=True, weight=1)
        if data and tp and sl:
            # Place TP/SL orders (reduce only)
            # TP: TAKE_PROFIT_MARKET
            # SL: STOP_MARKET
            # need to handle side inversion for closing
            close_side = "SELL" if side == "BUY" else "BUY"
            # TP order
            await self._request("POST", "/fapi/v1/order", params={
                "symbol": symbol,
                "side": close_side,
                "type": "TAKE_PROFIT_MARKET",
                "stopPrice": tp,
                "closePosition": "true"
            }, signed=True, weight=1)
            # SL order
            await self._request("POST", "/fapi/v1/order", params={
                "symbol": symbol,
                "side": close_side,
                "type": "STOP_MARKET",
                "stopPrice": sl,
                "closePosition": "true"
            }, signed=True, weight=1)
        
        return data
    
    async def close_position(self, symbol: str, quantity: float = None):
        pos = await self.get_position_risk()
        if pos:
            for p in pos:
                if p['symbol'] == symbol and float(p['positionAmt']) != 0:
                    side = "SELL" if float(p['positionAmt']) > 0 else "BUY"
                    qty = abs(float(p['positionAmt']))
                    return await self.create_order(symbol, side, qty)
        return None

# Global instance
binance_client = BinanceClient()
