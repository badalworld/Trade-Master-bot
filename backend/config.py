import os
import json
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
LOGS_DIR = BASE_DIR / "logs"
DATA_DIR.mkdir(exist_ok=True)
LOGS_DIR.mkdir(exist_ok=True)

CONFIG_FILE = DATA_DIR / "config.json"

DEFAULT_CONFIG = {
    "binance_api_key": "",
    "binance_api_secret": "",
    "testnet": True,
    "base_margin": 2.0,
    "leverage": 10,
    "max_open_trades": 5,
    "scan_interval_seconds": 15,
    "scan_top_n": 25,
    "timeframe": "5m",
    "use_95_percent_limit": True,
    "risk_percent_per_trade": 1.0,
    "tp_rr_ratio": 1.8,
    "sl_atr_multiplier": 1.5,
    "bot_enabled": False,
    "paper_trading": True,
    "compounding_enabled": True,
    "compounding_percent": 20,
}

def load_config():
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, 'r') as f:
                data = json.load(f)
                # merge with defaults for new keys
                cfg = {**DEFAULT_CONFIG, **data}
                return cfg
        except:
            return DEFAULT_CONFIG.copy()
    return DEFAULT_CONFIG.copy()

def save_config(cfg: dict):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(cfg, f, indent=2)

# Binance endpoints
BINANCE_FAPI_BASE = "https://fapi.binance.com"
BINANCE_FAPI_TESTNET = "https://testnet.binancefuture.com"

# Weight tracking
MAX_WEIGHT_PER_MINUTE = 2400
SAFE_WEIGHT_LIMIT = int(MAX_WEIGHT_PER_MINUTE * 0.95)  # 2280
