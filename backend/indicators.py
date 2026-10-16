"""
Trade Master Indicators
- HVN Profile (High Volume Node)
- Heavy Absorption
- Imbalance Levels 3 (FVG + Orderbook Imbalance)
"""
import pandas as pd
import numpy as np
from typing import Dict, List, Tuple, Optional

def calculate_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high = df['high']
    low = df['low']
    close = df['close']
    tr1 = high - low
    tr2 = (high - close.shift()).abs()
    tr3 = (low - close.shift()).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    atr = tr.rolling(period).mean()
    return atr

def calculate_hvn(df: pd.DataFrame, bins: int = 50, lookback: int = 100) -> Dict:
    """
    Volume Profile HVN detection
    Returns POC price, value area high/low, volume profile distribution
    """
    if len(df) < 20:
        return {"hvn": None, "poc_price": None, "vah": None, "val": None, "profile": []}
    
    subset = df.tail(lookback).copy()
    price_min = subset['low'].min()
    price_max = subset['high'].max()
    if price_max == price_min:
        return {"hvn": None, "poc_price": None, "vah": None, "val": None, "profile": []}
    
    # Create price bins
    bin_edges = np.linspace(price_min, price_max, bins + 1)
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2
    bin_volumes = np.zeros(bins)
    
    for _, row in subset.iterrows():
        # Distribute volume across price range of candle (approx)
        # Simple: assign all volume to close price bin
        # More accurate: distribute proportionally
        close = row['close']
        vol = row['volume']
        # find bin index for close
        idx = np.digitize(close, bin_edges) - 1
        idx = max(0, min(bins - 1, idx))
        bin_volumes[idx] += vol
    
    # POC is bin with max volume (HVN)
    poc_idx = int(np.argmax(bin_volumes))
    poc_price = float(bin_centers[poc_idx])
    max_vol = float(bin_volumes[poc_idx])
    
    # Value Area: 70% of volume around POC
    total_vol = bin_volumes.sum()
    if total_vol == 0:
        return {"hvn": poc_price, "poc_price": poc_price, "vah": None, "val": None, "profile": []}
    
    # Sort bins by distance from POC and accumulate volume
    sorted_indices = sorted(range(bins), key=lambda i: abs(i - poc_idx))
    cum_vol = 0
    va_indices = []
    for idx in sorted_indices:
        cum_vol += bin_volumes[idx]
        va_indices.append(idx)
        if cum_vol >= total_vol * 0.70:
            break
    vah = float(bin_centers[max(va_indices)])
    val = float(bin_centers[min(va_indices)])
    
    # Detect multiple HVNs (secondary high volume nodes)
    # Find local maxima where volume > 80% of max
    hvn_levels = []
    for i in range(1, bins-1):
        if bin_volumes[i] > bin_volumes[i-1] and bin_volumes[i] > bin_volumes[i+1] and bin_volumes[i] > max_vol * 0.6:
            hvn_levels.append(float(bin_centers[i]))
    # Always include POC
    if poc_price not in hvn_levels:
        hvn_levels.append(poc_price)
    hvn_levels = sorted(hvn_levels)
    
    # Strength: how pronounced is HVN
    avg_vol = bin_volumes.mean()
    hvn_strength = max_vol / avg_vol if avg_vol > 0 else 1
    
    # Distance to current price
    current_price = float(df['close'].iloc[-1])
    distance_pct = abs(current_price - poc_price) / current_price * 100 if current_price != 0 else 0
    
    return {
        "hvn": poc_price,
        "poc_price": poc_price,
        "vah": vah,
        "val": val,
        "profile": [{"price": float(bin_centers[i]), "volume": float(bin_volumes[i])} for i in range(bins)],
        "hvn_levels": hvn_levels,
        "hvn_strength": float(hvn_strength),
        "distance_pct": float(distance_pct),
        "is_price_near_hvn": distance_pct < 0.5,  # within 0.5%
        "current_price": current_price
    }

def detect_heavy_absorption(df: pd.DataFrame, lookback: int = 20) -> Dict:
    """
    Heavy Absorption detection
    - High volume + small price range = absorption
    - Long wick + high volume
    - Volume spike vs average
    Uses takerBuyVolume if available (not in klines, we estimate)
    """
    if len(df) < lookback + 5:
        return {"score": 0, "is_absorption": False, "type": None, "details": {}}
    
    df = df.copy()
    df['body'] = (df['close'] - df['open']).abs()
    df['range'] = df['high'] - df['low']
    df['upper_wick'] = df['high'] - df[['open', 'close']].max(axis=1)
    df['lower_wick'] = df[['open', 'close']].min(axis=1) - df['low']
    df['avg_volume'] = df['volume'].rolling(lookback).mean()
    df['vol_ratio'] = df['volume'] / df['avg_volume']
    
    atr = calculate_atr(df, 14)
    df['atr'] = atr
    df['range_atr_ratio'] = df['range'] / df['atr']
    
    last = df.iloc[-1]
    prev = df.iloc[-2] if len(df) >= 2 else last
    
    score = 0
    signals = []
    
    # Condition 1: Volume spike > 1.8x avg
    vol_spike = last['vol_ratio'] if not pd.isna(last['vol_ratio']) else 1
    if vol_spike > 1.8:
        score += 30
        signals.append(f"Vol spike {vol_spike:.2f}x")
        if vol_spike > 2.5:
            score += 15
    elif vol_spike > 1.5:
        score += 15
    
    # Condition 2: Small range vs ATR (absorption) but high volume
    range_ratio = last['range_atr_ratio'] if not pd.isna(last['range_atr_ratio']) else 1
    if range_ratio < 0.6 and vol_spike > 1.5:
        score += 35
        signals.append(f"Absorption: small range {range_ratio:.2f} ATR + high vol")
    elif range_ratio < 0.8 and vol_spike > 1.3:
        score += 20
    
    # Condition 3: Long wick + high volume = rejection/absorption
    # Upper wick absorption (selling absorption) -> potential reversal down, buying absorbed
    # Lower wick absorption (buying absorption) -> potential reversal up
    wick_score = 0
    absorption_type = None
    if last['range'] > 0:
        upper_wick_pct = last['upper_wick'] / last['range']
        lower_wick_pct = last['lower_wick'] / last['range']
        body_pct = last['body'] / last['range']
        
        if upper_wick_pct > 0.6 and vol_spike > 1.5:
            wick_score = 25
            absorption_type = "bearish_absorption"  # selling pressure absorbed at top
            signals.append(f"Bearish absorption upper wick {upper_wick_pct:.1%}")
        elif lower_wick_pct > 0.6 and vol_spike > 1.5:
            wick_score = 25
            absorption_type = "bullish_absorption"
            signals.append(f"Bullish absorption lower wick {lower_wick_pct:.1%}")
        elif body_pct < 0.3 and vol_spike > 1.8:
            wick_score = 20
            absorption_type = "indecision_absorption"
            signals.append(f"Doji absorption small body {body_pct:.1%}")
    
    score += wick_score
    
    # Condition 4: Consecutive high volume without progress (multiple candles)
    recent = df.tail(5)
    price_change_5 = (recent['close'].iloc[-1] - recent['open'].iloc[0]) / recent['open'].iloc[0] * 100 if recent['open'].iloc[0] != 0 else 0
    vol_sum_5 = recent['volume'].sum()
    avg_vol_5 = df['volume'].tail(20).mean() * 5
    if abs(price_change_5) < 0.3 and vol_sum_5 > avg_vol_5 * 1.5:
        score += 20
        signals.append(f"5-candle stagnation {price_change_5:.2f}% move + high vol")
        if not absorption_type:
            absorption_type = "bullish_absorption" if price_change_5 > 0 else "bearish_absorption"
    
    # Condition 5: Close near open despite high volume (absorption)
    body_range_ratio = last['body'] / last['range'] if last['range'] != 0 else 1
    if body_range_ratio < 0.25 and vol_spike > 1.6:
        score += 15
    
    is_absorption = score >= 50
    
    # Direction bias from absorption type
    direction = None
    if absorption_type == "bullish_absorption":
        direction = "LONG"  # buyers absorbed sellers, expect up
    elif absorption_type == "bearish_absorption":
        direction = "SHORT"
    
    return {
        "score": min(100, score),
        "is_absorption": is_absorption,
        "type": absorption_type,
        "direction": direction,
        "vol_ratio": float(vol_spike),
        "range_ratio": float(range_ratio) if not pd.isna(range_ratio) else 0,
        "signals": signals,
        "wick_type": absorption_type,
        "details": {
            "volume": float(last['volume']),
            "avg_volume": float(last['avg_volume']) if not pd.isna(last['avg_volume']) else 0,
            "body": float(last['body']),
            "range": float(last['range']),
            "atr": float(last['atr']) if not pd.isna(last['atr']) else 0
        }
    }

def detect_imbalance_levels(df: pd.DataFrame) -> Dict:
    """
    Imbalance Levels 3 - detects Fair Value Gaps (FVG / imbalance) and orderbook-like levels
    Uses 3-candle FVG pattern + inefficient price action
    Returns 3 levels (recent strongest)
    """
    if len(df) < 10:
        return {"score": 0, "imbalances": [], "nearest_bullish": None, "nearest_bearish": None, "direction": None}
    
    df = df.copy()
    imbalances = []
    
    # FVG detection: 3-candle pattern
    # Bullish FVG: candle1 high < candle3 low (gap up, buyers strong)
    # Bearish FVG: candle1 low > candle3 high (gap down, sellers strong)
    for i in range(2, len(df)):
        c1 = df.iloc[i-2]
        c2 = df.iloc[i-1]
        c3 = df.iloc[i]
        
        # Bullish FVG
        if c1['high'] < c3['low']:
            gap_size = c3['low'] - c1['high']
            gap_mid = (c1['high'] + c3['low']) / 2
            gap_pct = gap_size / c3['close'] * 100 if c3['close'] != 0 else 0
            # Strength: gap size vs ATR + volume
            atr = calculate_atr(df, 14).iloc[i] if not pd.isna(calculate_atr(df, 14).iloc[i]) else gap_size
            strength = min(100, (gap_size / atr * 50 + gap_pct * 10) if atr != 0 else gap_pct * 10)
            # Age: recent gaps are more relevant
            age = len(df) - i
            recency_bonus = max(0, 20 - age)  # bonus for recent
            strength = min(100, strength + recency_bonus)
            
            imbalances.append({
                "type": "bullish_fvg",
                "index": i,
                "high": float(c3['low']),
                "low": float(c1['high']),
                "mid": float(gap_mid),
                "size": float(gap_size),
                "size_pct": float(gap_pct),
                "strength": float(strength),
                "age": int(age),
                "direction": "LONG",  # bullish FVG acts as support, expect bounce long
                "filled": False  # whether price returned to fill gap
            })
        
        # Bearish FVG
        if c1['low'] > c3['high']:
            gap_size = c1['low'] - c3['high']
            gap_mid = (c1['low'] + c3['high']) / 2
            gap_pct = gap_size / c3['close'] * 100 if c3['close'] != 0 else 0
            atr = calculate_atr(df, 14).iloc[i] if not pd.isna(calculate_atr(df, 14).iloc[i]) else gap_size
            strength = min(100, (gap_size / atr * 50 + gap_pct * 10) if atr != 0 else gap_pct * 10)
            age = len(df) - i
            recency_bonus = max(0, 20 - age)
            strength = min(100, strength + recency_bonus)
            
            imbalances.append({
                "type": "bearish_fvg",
                "index": i,
                "high": float(c1['low']),
                "low": float(c3['high']),
                "mid": float(gap_mid),
                "size": float(gap_size),
                "size_pct": float(gap_pct),
                "strength": float(strength),
                "age": int(age),
                "direction": "SHORT",
                "filled": False
            })
    
    # Check which FVGs are filled (price returned)
    current_high = df['high'].tail(20).max()
    current_low = df['low'].tail(20).min()
    # Actually check each imbalance if later candles filled it
    for imb in imbalances:
        # Look ahead after imb index
        future = df.iloc[imb['index']+1:]
        if len(future) == 0:
            continue
        if imb['type'] == 'bullish_fvg':
            # filled if any future candle low goes below imb high?
            # bullish FVG filled when price returns down into gap
            if (future['low'] <= imb['high']).any():
                # check if fully filled (closed below gap low?)
                if (future['close'] < imb['low']).any():
                    imb['filled'] = True
                    imb['strength'] *= 0.3  # filled gaps weaker
                else:
                    imb['strength'] *= 0.7  # partially filled somewhat weaker
        else:
            if (future['high'] >= imb['low']).any():
                if (future['close'] > imb['high']).any():
                    imb['filled'] = True
                    imb['strength'] *= 0.3
                else:
                    imb['strength'] *= 0.7
    
    # Filter unfilled or strongest, sort by strength and recency
    # Keep recent 3 levels (Levels 3 concept)
    # Prefer unfilled and strong
    valid = [x for x in imbalances if not x['filled']] 
    if len(valid) < 3:
        # add partially filled but strong
        partial = [x for x in imbalances if x['filled'] and x['strength'] > 30]
        valid.extend(partial)
    
    # Sort by strength descending, then by age ascending (recent first)
    valid_sorted = sorted(valid, key=lambda x: (x['strength'], -x['age']), reverse=True)
    
    top3 = valid_sorted[:3]
    
    # Find nearest bullish/bearish levels to current price
    current_price = float(df['close'].iloc[-1])
    nearest_bullish = None
    nearest_bearish = None
    for imb in top3:
        if imb['type'] == 'bullish_fvg' and imb['mid'] < current_price:
            if nearest_bullish is None or abs(current_price - imb['mid']) < abs(current_price - nearest_bullish['mid']):
                nearest_bullish = imb
        if imb['type'] == 'bearish_fvg' and imb['mid'] > current_price:
            if nearest_bearish is None or abs(current_price - imb['mid']) < abs(current_price - nearest_bearish['mid']):
                nearest_bearish = imb
    
    # Overall imbalance score (sum of top3 strength weighted)
    if top3:
        avg_strength = sum(x['strength'] for x in top3) / len(top3)
        # Bonus if we have both bullish and bearish (balanced) or if one is very strong
        imbalance_score = min(100, avg_strength + len(top3)*5)
    else:
        imbalance_score = 0
        avg_strength = 0
    
    # Direction suggestion: if nearest unfilled bullish FVG below price -> expect long bounce
    # if nearest bearish above -> expect short
    direction = None
    # Also check recent price position relative to imbalances
    if nearest_bullish and nearest_bearish:
        dist_bull = current_price - nearest_bullish['mid']
        dist_bear = nearest_bearish['mid'] - current_price
        if dist_bull < dist_bear and dist_bull < current_price * 0.015:  # within 1.5%
            direction = "LONG"
        elif dist_bear < dist_bull and dist_bear < current_price * 0.015:
            direction = "SHORT"
    elif nearest_bullish and current_price - nearest_bullish['mid'] < current_price * 0.01:
        direction = "LONG"
    elif nearest_bearish and nearest_bearish['mid'] - current_price < current_price * 0.01:
        direction = "SHORT"
    
    return {
        "score": float(imbalance_score),
        "imbalances": top3,
        "all_imbalances": imbalances[-10:],  # last 10 for display
        "nearest_bullish": nearest_bullish,
        "nearest_bearish": nearest_bearish,
        "direction": direction,
        "count": len(top3),
        "avg_strength": float(avg_strength) if top3 else 0
    }

def analyze_symbol(df: pd.DataFrame) -> Dict:
    """
    Master analysis combining all 3 indicators
    Returns composite signal score and direction
    """
    if len(df) < 30:
        return {"score": 0, "direction": None, "reasons": ["Not enough candles"]}
    
    hvn_data = calculate_hvn(df)
    absorption = detect_heavy_absorption(df)
    imbalance = detect_imbalance_levels(df)
    
    # ATR for volatility and TP/SL
    atr = calculate_atr(df, 14).iloc[-1]
    if pd.isna(atr):
        atr = (df['high'].tail(14).max() - df['low'].tail(14).min()) / 14
    
    current_price = float(df['close'].iloc[-1])
    
    # Composite scoring
    score = 0
    reasons = []
    direction_votes = {"LONG": 0, "SHORT": 0}
    
    # HVN contribution (up to 30 points)
    if hvn_data['hvn_strength'] > 1.5:
        hvn_score = min(30, (hvn_data['hvn_strength'] - 1) * 15)
        # If price near HVN, it's a key level - high probability bounce or rejection
        if hvn_data['is_price_near_hvn']:
            hvn_score += 10
            reasons.append(f"Price near HVN {hvn_data['poc_price']:.4f} ({hvn_data['distance_pct']:.2f}%)")
        else:
            reasons.append(f"HVN at {hvn_data['poc_price']:.4f} strength {hvn_data['hvn_strength']:.1f}x")
        # Determine direction based on price vs HVN + recent momentum
        # If price above HVN, HVN acts as support -> bullish bias
        # If price below HVN, HVN acts as resistance -> bearish bias
        if current_price > hvn_data['poc_price']:
            # Also need to consider if volume profile suggests continuation?
            # Check recent close vs POC: if above, bullish
            direction_votes["LONG"] += hvn_score * 0.6
            direction_votes["SHORT"] += hvn_score * 0.2
        else:
            direction_votes["SHORT"] += hvn_score * 0.6
            direction_votes["LONG"] += hvn_score * 0.2
        score += hvn_score * 0.8  # weight
    else:
        reasons.append("Weak HVN")
    
    # Absorption contribution (up to 35 points)
    abs_score = absorption['score']
    if abs_score > 30:
        score += abs_score * 0.35
        reasons.extend(absorption['signals'])
        if absorption['direction']:
            direction_votes[absorption['direction']] += abs_score * 0.7
            reasons.append(f"Absorption {absorption['type']} => {absorption['direction']}")
        else:
            # neutral, use momentum
            recent_return = (df['close'].iloc[-1] - df['close'].iloc[-5]) / df['close'].iloc[-5] * 100
            if recent_return > 0:
                direction_votes["LONG"] += abs_score * 0.3
            else:
                direction_votes["SHORT"] += abs_score * 0.3
    
    # Imbalance contribution (up to 35 points)
    imb_score = imbalance['score']
    if imb_score > 20:
        score += imb_score * 0.35
        if imbalance['nearest_bullish']:
            reasons.append(f"Bullish FVG {imbalance['nearest_bullish']['low']:.4f}-{imbalance['nearest_bullish']['high']:.4f}")
        if imbalance['nearest_bearish']:
            reasons.append(f"Bearish FVG {imbalance['nearest_bearish']['low']:.4f}-{imbalance['nearest_bearish']['high']:.4f}")
        if imbalance['direction']:
            direction_votes[imbalance['direction']] += imb_score * 0.7
            reasons.append(f"Imbalance bias {imbalance['direction']}")
    
    # Momentum / Volatility filter
    # Favour high volatility for faster moves as spec says
    # Calculate recent volatility
    recent_volatility = df['close'].pct_change().tail(20).std() * 100  # in %
    high_vol_bonus = min(15, recent_volatility * 100)  # up to 15 points for high vol
    score += high_vol_bonus
    if recent_volatility > 0.5:
        reasons.append(f"High volatility {recent_volatility:.2f}%")
    
    # Trend alignment (EMA)
    df['ema20'] = df['close'].ewm(span=20).mean()
    df['ema50'] = df['close'].ewm(span=50).mean()
    if len(df) >= 50:
        ema_trend = "up" if df['ema20'].iloc[-1] > df['ema50'].iloc[-1] else "down"
        # Align direction with trend for higher probability (unless absorption suggests reversal)
        if ema_trend == "up":
            direction_votes["LONG"] += 10
        else:
            direction_votes["SHORT"] += 10
        reasons.append(f"EMA trend {ema_trend}")
    
    # Final direction
    final_direction = None
    if direction_votes["LONG"] > direction_votes["SHORT"] and direction_votes["LONG"] > 20:
        final_direction = "LONG"
    elif direction_votes["SHORT"] > direction_votes["LONG"] and direction_votes["SHORT"] > 20:
        final_direction = "SHORT"
    else:
        # fallback to strongest single indicator
        if absorption['direction']:
            final_direction = absorption['direction']
        elif imbalance['direction']:
            final_direction = imbalance['direction']
    
    # Normalize score 0-100
    final_score = min(100, max(0, score))
    
    # High probability threshold: spec wants high-probability entry
    # We consider 70+ high probability, 55+ medium, <55 no trade
    is_high_prob = final_score >= 68
    
    # Calculate TP/SL based on indicators
    tp_price, sl_price = calculate_tp_sl(current_price, final_direction, hvn_data, absorption, imbalance, atr)
    
    return {
        "score": float(final_score),
        "direction": final_direction,
        "is_high_prob": is_high_prob,
        "reasons": reasons,
        "hvn": hvn_data,
        "absorption": absorption,
        "imbalance": imbalance,
        "atr": float(atr) if not pd.isna(atr) else 0,
        "current_price": float(current_price),
        "volatility": float(recent_volatility),
        "tp_price": float(tp_price) if tp_price else None,
        "sl_price": float(sl_price) if sl_price else None,
        "direction_votes": direction_votes
    }

def calculate_tp_sl(entry_price: float, direction: Optional[str], hvn_data: Dict, absorption: Dict, imbalance: Dict, atr: float) -> Tuple[Optional[float], Optional[float]]:
    if not direction or atr == 0 or pd.isna(atr):
        return None, None
    
    atr = float(atr)
    # Default RR
    rr = 1.8
    
    if direction == "LONG":
        # SL: below recent swing, HVN VAL, or absorption low
        candidates_sl = []
        if hvn_data.get('val'):
            candidates_sl.append(hvn_data['val'])
        if hvn_data.get('poc_price') and hvn_data['poc_price'] < entry_price:
            candidates_sl.append(hvn_data['poc_price'] - atr * 0.2)
        # Absorption low
        # Use recent low as fallback
        # SL should be at least atr*1.2 below entry, at most atr*2
        sl_atr = entry_price - atr * 1.5
        candidates_sl.append(sl_atr)
        
        # Choose highest SL that is still below entry (tightest but valid)
        valid_sl = [x for x in candidates_sl if x < entry_price]
        if valid_sl:
            sl_price = max(valid_sl)  # closest to entry
            # Ensure distance not too small (<0.3%) or too large (>2%)
            distance_pct = (entry_price - sl_price) / entry_price * 100
            if distance_pct < 0.3:
                sl_price = entry_price - atr * 1.2
            elif distance_pct > 2.0:
                sl_price = entry_price - entry_price * 0.02
        else:
            sl_price = sl_atr
        
        # TP: next imbalance or HVN above, or RR based
        candidates_tp = []
        if imbalance.get('nearest_bearish'):
            candidates_tp.append(imbalance['nearest_bearish']['mid'])
        if hvn_data.get('vah') and hvn_data['vah'] > entry_price:
            candidates_tp.append(hvn_data['vah'])
        # HVN levels above
        for lvl in hvn_data.get('hvn_levels', []):
            if lvl > entry_price:
                candidates_tp.append(lvl)
                break
        
        rr_tp = entry_price + (entry_price - sl_price) * rr
        candidates_tp.append(rr_tp)
        
        valid_tp = [x for x in candidates_tp if x > entry_price]
        tp_price = min(valid_tp) if valid_tp else rr_tp
        # Ensure TP not too close (at least 0.5%)
        if (tp_price - entry_price) / entry_price * 100 < 0.5:
            tp_price = rr_tp
        
    else:  # SHORT
        candidates_sl = []
        if hvn_data.get('vah'):
            candidates_sl.append(hvn_data['vah'])
        if hvn_data.get('poc_price') and hvn_data['poc_price'] > entry_price:
            candidates_sl.append(hvn_data['poc_price'] + atr * 0.2)
        sl_atr = entry_price + atr * 1.5
        candidates_sl.append(sl_atr)
        
        valid_sl = [x for x in candidates_sl if x > entry_price]
        if valid_sl:
            sl_price = min(valid_sl)
            distance_pct = (sl_price - entry_price) / entry_price * 100
            if distance_pct < 0.3:
                sl_price = entry_price + atr * 1.2
            elif distance_pct > 2.0:
                sl_price = entry_price + entry_price * 0.02
        else:
            sl_price = sl_atr
        
        candidates_tp = []
        if imbalance.get('nearest_bullish'):
            candidates_tp.append(imbalance['nearest_bullish']['mid'])
        if hvn_data.get('val') and hvn_data['val'] < entry_price:
            candidates_tp.append(hvn_data['val'])
        for lvl in hvn_data.get('hvn_levels', []):
            if lvl < entry_price:
                candidates_tp.append(lvl)
                break
        rr_tp = entry_price - (sl_price - entry_price) * rr
        candidates_tp.append(rr_tp)
        
        valid_tp = [x for x in candidates_tp if x < entry_price]
        tp_price = max(valid_tp) if valid_tp else rr_tp
        if (entry_price - tp_price) / entry_price * 100 < 0.5:
            tp_price = rr_tp
    
    return tp_price, sl_price
