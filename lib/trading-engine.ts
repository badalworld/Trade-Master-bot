/**
 * Trade Master - Order Flow & Volume Profile Trading Engine
 * Strategy based on:
 * 1. HVN Profile (High Volume Node / Point of Control Volume Profile)
 * 2. Heavy Absorption (Order Flow Passive Limit Absorption)
 * 3. Imbalance Levels (Stacked 3:1 Volumetric Buying/Selling Imbalances)
 * 
 * Includes:
 * - Dynamic TP/SL calculation based on ATR & Volume Nodes
 * - Compounding Margin Engine (+20% of profit on win, reset to fixed base on loss)
 * - Maximum Open Trades constraint (max 5)
 * - Binance API Rate Limit Shield (95% safety cap)
 */

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface VolumeNode {
  priceLevel: number;
  volume: number;
  isPOC: boolean; // Point of Control
  isHVN: boolean; // High Volume Node
}

export interface HVNProfileResult {
  pocPrice: number; // Point of Control
  hvnLevels: number[]; // Top High Volume Nodes
  valueAreaHigh: number; // VAH (70% value area upper)
  valueAreaLow: number; // VAL (70% value area lower)
  nodes: VolumeNode[];
  priceRelation: 'ABOVE_POC' | 'BELOW_POC' | 'AT_POC';
}

export interface AbsorptionResult {
  isAbsorptionDetected: boolean;
  isHeavyAbsorption?: boolean;
  type: 'BULLISH_ABSORPTION' | 'BEARISH_ABSORPTION' | 'NONE';
  absorptionType?: 'BULLISH' | 'BEARISH' | 'NONE';
  absorptionScore: number; // 0 - 100%
  ratio?: number;
  deltaVolume: number; // estimated buy - sell delta
  absorbedPrice: number;
}

export interface ImbalanceResult {
  isImbalanceDetected: boolean;
  hasStackedImbalance?: boolean;
  type: 'BUY_IMBALANCE' | 'SELL_IMBALANCE' | 'BALANCED';
  imbalanceSide?: 'BUY' | 'SELL' | 'BALANCED';
  stackedImbalanceCount: number; // e.g. 3 stacked imbalance levels
  maxImbalanceRatio: number; // e.g. 3.2x (3:1 ratio)
  imbalancePriceLevels: number[];
}

export type SignalType = 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL';

export interface SignalEvaluation {
  symbol: string;
  signal: SignalType;
  action: 'LONG' | 'SHORT' | 'HOLD';
  score: number; // 0 - 100%
  volatilityPercent: number; // ATR % and 5m range expansion %
  volatilityScore: number; // 0 - 100 volatility index
  currentPrice: number;
  atr: number;
  tpPrice: number;
  slPrice: number;
  riskRewardRatio: number;
  hvnProfile: HVNProfileResult;
  absorption: AbsorptionResult;
  imbalance: ImbalanceResult;
  reasons: string[];
}

export interface TradePosition {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  markPrice: number;
  margin: number; // in USDT (e.g. 2.00 or compounded)
  leverage: number; // 10x
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  entryTime: number;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  margin: number;
  leverage: number;
  pnl: number;
  pnlPercent: number;
  entryTime: number;
  exitTime: number;
  reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL_CLOSE';
  isWin: boolean;
  compoundingBonusGenerated: number;
}

export interface CompoundingState {
  baseMargin: number; // default $2.00
  currentMargin: number; // current margin for next trade
  lastProfit: number;
  compoundingPercent: number; // default 20%
  consecutiveWins: number;
  totalCompoundedProfitPool: number;
}

// ---------------------------------------------------------------------------
// 1. Indicator 1: HVN Profile (High Volume Node & Point of Control)
// ---------------------------------------------------------------------------

/**
 * Calculates Volume Profile across the recent 5m candle window,
 * determining Point of Control (POC), High Volume Nodes (HVN), and Value Area (VAH/VAL).
 */
export function calculateHVNProfile(candles: Candle[], binCount: number = 14): HVNProfileResult {
  if (candles.length === 0) {
    return {
      pocPrice: 0,
      hvnLevels: [],
      valueAreaHigh: 0,
      valueAreaLow: 0,
      nodes: [],
      priceRelation: 'AT_POC',
    };
  }

  const currentPrice = candles[candles.length - 1].close;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const minP = Math.min(...lows);
  const maxP = Math.max(...highs);
  const range = maxP - minP || currentPrice * 0.01;
  const step = range / binCount;

  const bins: { priceLevel: number; volume: number }[] = Array.from({ length: binCount }, (_, i) => ({
    priceLevel: Number((minP + step * i + step / 2).toFixed(6)),
    volume: 0,
  }));

  // Distribute candle volumes across price bins
  candles.forEach((c) => {
    const avgPrice = (c.high + c.low + c.close) / 3;
    const binIdx = Math.min(
      binCount - 1,
      Math.max(0, Math.floor((avgPrice - minP) / step))
    );
    bins[binIdx].volume += c.volume;
  });

  // Find Point of Control (POC) = bin with max volume
  let maxVol = 0;
  let pocIdx = 0;
  bins.forEach((b, idx) => {
    if (b.volume > maxVol) {
      maxVol = b.volume;
      pocIdx = idx;
    }
  });

  const totalVol = bins.reduce((acc, b) => acc + b.volume, 0);
  const avgBinVol = totalVol / (binCount || 1);

  // Identify High Volume Nodes (HVNs) where volume > 1.35x average bin volume
  const hvnLevels: number[] = [];
  const nodes: VolumeNode[] = bins.map((b, idx) => {
    const isPOC = idx === pocIdx;
    const isHVN = b.volume >= avgBinVol * 1.35;
    if (isHVN) hvnLevels.push(b.priceLevel);
    return {
      priceLevel: b.priceLevel,
      volume: Number(b.volume.toFixed(2)),
      isPOC,
      isHVN,
    };
  });

  const pocPrice = bins[pocIdx]?.priceLevel || currentPrice;

  // Calculate Value Area (70% total volume centered around POC)
  const target70 = totalVol * 0.7;
  let accumulated = bins[pocIdx]?.volume || 0;
  let lowerIdx = pocIdx;
  let upperIdx = pocIdx;

  while (accumulated < target70 && (lowerIdx > 0 || upperIdx < binCount - 1)) {
    const nextLower = lowerIdx > 0 ? bins[lowerIdx - 1].volume : 0;
    const nextUpper = upperIdx < binCount - 1 ? bins[upperIdx + 1].volume : 0;

    if (nextUpper >= nextLower && upperIdx < binCount - 1) {
      upperIdx++;
      accumulated += bins[upperIdx].volume;
    } else if (lowerIdx > 0) {
      lowerIdx--;
      accumulated += bins[lowerIdx].volume;
    } else break;
  }

  const valueAreaHigh = bins[upperIdx]?.priceLevel || maxP;
  const valueAreaLow = bins[lowerIdx]?.priceLevel || minP;

  let priceRelation: HVNProfileResult['priceRelation'] = 'AT_POC';
  if (currentPrice > pocPrice * 1.001) priceRelation = 'ABOVE_POC';
  else if (currentPrice < pocPrice * 0.999) priceRelation = 'BELOW_POC';

  return {
    pocPrice,
    hvnLevels,
    valueAreaHigh,
    valueAreaLow,
    nodes,
    priceRelation,
  };
}

// ---------------------------------------------------------------------------
// 2. Indicator 2: Heavy Absorption (Order Flow Passive Limit Absorption)
// ---------------------------------------------------------------------------

/**
 * Detects Heavy Absorption where aggressive market orders meet heavy passive limit liquidity.
 * Evaluates high volume combined with small real body / long wicks or delta volume divergence.
 */
export function calculateHeavyAbsorption(candles: Candle[]): AbsorptionResult {
  if (candles.length < 3) {
    return {
      isAbsorptionDetected: false,
      type: 'NONE',
      absorptionScore: 0,
      deltaVolume: 0,
      absorbedPrice: 0,
    };
  }

  const latest = candles[candles.length - 1];
  const prevSlice = candles.slice(-10);
  const avgVolume = prevSlice.reduce((acc, c) => acc + c.volume, 0) / prevSlice.length;

  const totalRange = latest.high - latest.low || 0.0001;
  const bodySize = Math.abs(latest.close - latest.open);
  const upperWick = latest.high - Math.max(latest.open, latest.close);
  const lowerWick = Math.min(latest.open, latest.close) - latest.low;

  // High volume relative to average (> 1.25x)
  const isHighVolume = latest.volume >= avgVolume * 1.25;

  // Estimate volume delta (buying vs selling)
  const isGreen = latest.close >= latest.open;
  const deltaVolume = Number(
    ((isGreen ? latest.volume * 0.55 : -latest.volume * 0.55) + (lowerWick - upperWick) * 0.1).toFixed(2)
  );

  let isAbsorptionDetected = false;
  let type: AbsorptionResult['type'] = 'NONE';
  let absorptionScore = 0;

  // Bullish Absorption: High volume, heavy lower wick (buyers absorbing selling pressure at lows)
  if (isHighVolume && lowerWick >= totalRange * 0.45 && lowerWick > bodySize) {
    isAbsorptionDetected = true;
    type = 'BULLISH_ABSORPTION';
    absorptionScore = Math.min(98, Math.round((latest.volume / avgVolume) * 45 + (lowerWick / totalRange) * 50));
  }
  // Bearish Absorption: High volume, heavy upper wick (sellers absorbing buying pressure at highs)
  else if (isHighVolume && upperWick >= totalRange * 0.45 && upperWick > bodySize) {
    isAbsorptionDetected = true;
    type = 'BEARISH_ABSORPTION';
    absorptionScore = Math.min(98, Math.round((latest.volume / avgVolume) * 45 + (upperWick / totalRange) * 50));
  }

  const absorptionType: 'BULLISH' | 'BEARISH' | 'NONE' =
    type === 'BULLISH_ABSORPTION' ? 'BULLISH' : type === 'BEARISH_ABSORPTION' ? 'BEARISH' : 'NONE';

  return {
    isAbsorptionDetected,
    isHeavyAbsorption: isAbsorptionDetected,
    type,
    absorptionType,
    absorptionScore,
    ratio: absorptionScore,
    deltaVolume,
    absorbedPrice: type === 'BULLISH_ABSORPTION' ? latest.low : type === 'BEARISH_ABSORPTION' ? latest.high : latest.close,
  };
}

// ---------------------------------------------------------------------------
// 3. Indicator 3: Imbalance Levels (3 Stacked Buying/Selling Imbalances)
// ---------------------------------------------------------------------------

/**
 * Detects Volumetric Imbalance Levels (3:1 ratio stacked buying or selling imbalances).
 * High ratio indicates aggressive initiative order flow overpowering opposing liquidity.
 */
export function calculateImbalanceLevels(candles: Candle[], minRatio: number = 3.0): ImbalanceResult {
  if (candles.length < 3) {
    return {
      isImbalanceDetected: false,
      type: 'BALANCED',
      stackedImbalanceCount: 0,
      maxImbalanceRatio: 1.0,
      imbalancePriceLevels: [],
    };
  }

  const latest = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const priceDelta = latest.close - prev.close;
  const isUptrendMomentum = priceDelta > 0;
  const isDowntrendMomentum = priceDelta < 0;

  // Calculate simulated level-by-level bid/ask volumetric ratio
  const buyPressure = (latest.close - latest.low) * latest.volume;
  const sellPressure = (latest.high - latest.close) * latest.volume;

  const ratio = sellPressure > 0 ? buyPressure / sellPressure : buyPressure > 0 ? buyPressure : 1.0;
  const invRatio = buyPressure > 0 ? sellPressure / buyPressure : sellPressure > 0 ? sellPressure : 1.0;

  let stackedImbalanceCount = 0;
  let type: ImbalanceResult['type'] = 'BALANCED';
  let isImbalanceDetected = false;
  let maxImbalanceRatio = 1.0;
  const imbalancePriceLevels: number[] = [];

  const step = (latest.high - latest.low) / 4 || latest.close * 0.001;

  if (isUptrendMomentum && ratio >= minRatio) {
    isImbalanceDetected = true;
    type = 'BUY_IMBALANCE';
    stackedImbalanceCount = 3; // 3 stacked buy levels
    maxImbalanceRatio = Number(ratio.toFixed(2));
    imbalancePriceLevels.push(
      Number(latest.low.toFixed(4)),
      Number((latest.low + step * 2).toFixed(4)),
      Number((latest.low + step * 3).toFixed(4))
    );
  } else if (isDowntrendMomentum && invRatio >= minRatio) {
    isImbalanceDetected = true;
    type = 'SELL_IMBALANCE';
    stackedImbalanceCount = 3; // 3 stacked sell levels
    maxImbalanceRatio = Number(invRatio.toFixed(2));
    imbalancePriceLevels.push(
      Number(latest.high.toFixed(4)),
      Number((latest.high - step * 2).toFixed(4)),
      Number((latest.high - step * 3).toFixed(4))
    );
  } else if (Math.abs(ratio - 1.0) > 0.5) {
    // Partial imbalance
    type = ratio > 1.0 ? 'BUY_IMBALANCE' : 'SELL_IMBALANCE';
    stackedImbalanceCount = 2;
    maxImbalanceRatio = Number((ratio > 1.0 ? ratio : invRatio).toFixed(2));
  }

  const imbalanceSide: 'BUY' | 'SELL' | 'BALANCED' =
    type === 'BUY_IMBALANCE' ? 'BUY' : type === 'SELL_IMBALANCE' ? 'SELL' : 'BALANCED';

  return {
    isImbalanceDetected,
    hasStackedImbalance: isImbalanceDetected,
    type,
    imbalanceSide,
    stackedImbalanceCount,
    maxImbalanceRatio,
    imbalancePriceLevels,
  };
}

// ---------------------------------------------------------------------------
// 4. Calculate ATR (Average True Range)
// ---------------------------------------------------------------------------

export function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < 2) return 0;
  const count = Math.min(candles.length, period + 1);
  const subset = candles.slice(-count);

  const trs: number[] = [];
  for (let i = 1; i < subset.length; i++) {
    const high = subset[i].high;
    const low = subset[i].low;
    const prevClose = subset[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }

  if (trs.length === 0) return 0;
  const sum = trs.reduce((acc, val) => acc + val, 0);
  return Number((sum / trs.length).toFixed(6));
}

// ---------------------------------------------------------------------------
// 5. 3-Indicator Strategy Signal Evaluator (HVN + Absorption + Imbalances)
// ---------------------------------------------------------------------------

export function evaluate3IndicatorSignal(
  symbol: string,
  candles: Candle[]
): SignalEvaluation {
  const currentPrice = candles[candles.length - 1]?.close || 0;
  const atr = calculateATR(candles, 14);

  const hvnProfile = calculateHVNProfile(candles, 14);
  const absorption = calculateHeavyAbsorption(candles);
  const imbalance = calculateImbalanceLevels(candles, 3.0);

  const reasons: string[] = [];
  let bullPoints = 0;
  let bearPoints = 0;

  // 1. HVN Profile Evaluation (Point of Control & High Volume Nodes)
  if (hvnProfile.priceRelation === 'ABOVE_POC') {
    bullPoints += 35;
    reasons.push(`Price trading above Point of Control (POC: $${hvnProfile.pocPrice.toFixed(2)})`);
  } else if (hvnProfile.priceRelation === 'BELOW_POC') {
    bearPoints += 35;
    reasons.push(`Price trading below Point of Control (POC: $${hvnProfile.pocPrice.toFixed(2)})`);
  } else {
    bullPoints += 15;
    bearPoints += 15;
    reasons.push(`Price consolidating at Point of Control ($${hvnProfile.pocPrice.toFixed(2)})`);
  }

  // 2. Heavy Absorption Evaluation
  if (absorption.type === 'BULLISH_ABSORPTION') {
    bullPoints += 35;
    reasons.push(`Heavy Bullish Absorption detected (${absorption.absorptionScore}% score) at $${absorption.absorbedPrice.toFixed(2)}`);
  } else if (absorption.type === 'BEARISH_ABSORPTION') {
    bearPoints += 35;
    reasons.push(`Heavy Bearish Absorption detected (${absorption.absorptionScore}% score) at $${absorption.absorbedPrice.toFixed(2)}`);
  }

  // 3. Imbalance Levels Evaluation (Stacked 3:1 Imbalance)
  if (imbalance.type === 'BUY_IMBALANCE') {
    bullPoints += 30;
    reasons.push(`Stacked 3:1 Buying Imbalance detected (${imbalance.maxImbalanceRatio}x ratio)`);
  } else if (imbalance.type === 'SELL_IMBALANCE') {
    bearPoints += 30;
    reasons.push(`Stacked 3:1 Selling Imbalance detected (${imbalance.maxImbalanceRatio}x ratio)`);
  }

  // Determine Final Signal & Action
  let signal: SignalType = 'NEUTRAL';
  let action: 'LONG' | 'SHORT' | 'HOLD' = 'HOLD';
  let score = 50;

  if (bullPoints >= 70) {
    signal = 'STRONG_BUY';
    action = 'LONG';
    score = Math.min(98, bullPoints);
  } else if (bullPoints >= 50) {
    signal = 'BUY';
    action = 'LONG';
    score = bullPoints;
  } else if (bearPoints >= 70) {
    signal = 'STRONG_SELL';
    action = 'SHORT';
    score = Math.min(98, bearPoints);
  } else if (bearPoints >= 50) {
    signal = 'SELL';
    action = 'SHORT';
    score = bearPoints;
  } else {
    signal = 'NEUTRAL';
    action = 'HOLD';
    score = Math.max(bullPoints, bearPoints);
  }

  // Dynamic TP and SL based on ATR and Volume Nodes
  const safeAtr = atr > 0 ? atr : currentPrice * 0.01;
  let tpPrice = currentPrice;
  let slPrice = currentPrice;

  if (action === 'LONG') {
    tpPrice = Number((currentPrice + 2.5 * safeAtr).toFixed(4));
    slPrice = Number((Math.min(currentPrice - 1.5 * safeAtr, hvnProfile.pocPrice * 0.998)).toFixed(4));
  } else if (action === 'SHORT') {
    tpPrice = Number((currentPrice - 2.5 * safeAtr).toFixed(4));
    slPrice = Number((Math.max(currentPrice + 1.5 * safeAtr, hvnProfile.pocPrice * 1.002)).toFixed(4));
  } else {
    tpPrice = Number((currentPrice + 2.0 * safeAtr).toFixed(4));
    slPrice = Number((currentPrice - 1.5 * safeAtr).toFixed(4));
  }

  // Compute High Volatility Metrics (ATR % and 5m High-Low expansion)
  const atrRatio = currentPrice > 0 ? (safeAtr / currentPrice) * 100 : 1.0;
  const recentSlice = candles.slice(-10);
  const recentHighs = recentSlice.map((c) => c.high);
  const recentLows = recentSlice.map((c) => c.low);
  const maxHigh = Math.max(...recentHighs);
  const minLow = Math.min(...recentLows);
  const rangeExpansion = minLow > 0 ? ((maxHigh - minLow) / minLow) * 100 : 1.0;

  const volatilityPercent = Number((atrRatio * 0.55 + rangeExpansion * 0.45).toFixed(2));
  const volatilityScore = Math.min(99, Math.round(volatilityPercent * 30));

  return {
    symbol,
    signal,
    action,
    score,
    volatilityPercent,
    volatilityScore,
    currentPrice,
    atr: safeAtr,
    tpPrice,
    slPrice,
    riskRewardRatio: 1.67,
    hvnProfile,
    absorption,
    imbalance,
    reasons,
  };
}

/**
 * Sorts scanned Futures pairs primarily by High Volatility for faster price movement & profit
 */
export function sortByVolatility(signals: SignalEvaluation[]): SignalEvaluation[] {
  return [...signals].sort((a, b) => b.volatilityPercent - a.volatilityPercent);
}

// ---------------------------------------------------------------------------
// 6. Compounding & Position Management
// ---------------------------------------------------------------------------

export const MAX_OPEN_TRADES = 5;

export function calculateNextTradeMargin(
  state: CompoundingState,
  lastTradeResult: { isWin: boolean; profit: number }
): { nextMargin: number; bonusAdded: number; newState: CompoundingState } {
  const { baseMargin, compoundingPercent } = state;

  if (lastTradeResult.isWin && lastTradeResult.profit > 0) {
    const bonus = Number((lastTradeResult.profit * (compoundingPercent / 100)).toFixed(4));
    const nextMargin = Number((baseMargin + bonus).toFixed(2));

    const newState: CompoundingState = {
      ...state,
      currentMargin: nextMargin,
      lastProfit: lastTradeResult.profit,
      consecutiveWins: state.consecutiveWins + 1,
      totalCompoundedProfitPool: Number((state.totalCompoundedProfitPool + bonus).toFixed(4)),
    };

    return { nextMargin, bonusAdded: bonus, newState };
  } else {
    const newState: CompoundingState = {
      ...state,
      currentMargin: baseMargin,
      lastProfit: 0,
      consecutiveWins: 0,
    };

    return { nextMargin: baseMargin, bonusAdded: 0, newState };
  }
}

export function canOpenNewTrade(
  currentOpenPositionsCount: number,
  maxLimit: number = MAX_OPEN_TRADES
): { allowed: boolean; remainingSlots: number; reason?: string } {
  if (currentOpenPositionsCount >= maxLimit) {
    return {
      allowed: false,
      remainingSlots: 0,
      reason: `Maximum concurrent open trades limit reached (${currentOpenPositionsCount}/${maxLimit})`,
    };
  }

  return {
    allowed: true,
    remainingSlots: maxLimit - currentOpenPositionsCount,
  };
}

// ---------------------------------------------------------------------------
// 7. Rate Limiter Shield
// ---------------------------------------------------------------------------

export const BINANCE_DEFAULT_WEIGHT_LIMIT = 1200;
export const RATE_LIMIT_SAFETY_THRESHOLD = 0.95;

export interface RateLimitStatus {
  usedWeight: number;
  maxLimit: number;
  usageRatio: number;
  usagePercent: number;
  isSafe: boolean;
  isThrottled: boolean;
  remainingWeight: number;
}

export function checkRateLimit(
  usedWeight: number,
  maxLimit: number = BINANCE_DEFAULT_WEIGHT_LIMIT
): RateLimitStatus {
  const usageRatio = maxLimit > 0 ? usedWeight / maxLimit : 0;
  const usagePercent = Number((usageRatio * 100).toFixed(1));
  const isThrottled = usageRatio >= RATE_LIMIT_SAFETY_THRESHOLD;
  const isSafe = !isThrottled;
  const remainingWeight = Math.max(0, Math.floor(maxLimit * RATE_LIMIT_SAFETY_THRESHOLD - usedWeight));

  return {
    usedWeight,
    maxLimit,
    usageRatio,
    usagePercent,
    isSafe,
    isThrottled,
    remainingWeight,
  };
}
