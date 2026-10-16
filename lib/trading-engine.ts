/**
 * Trade Master - Order Flow & Volume Profile Trading Engine
 * Strategy based on:
 * 1. HVN Profile (High Volume Node / Point of Control Volume Profile & Value Area)
 * 2. Heavy Absorption (Order Flow Passive Limit Absorption & Delta Divergence)
 * 3. Imbalance Levels (Stacked 3:1 Volumetric Buying/Selling Imbalances)
 *
 * Includes:
 * - Indicator-Driven Dynamic TP/SL calculation (anchored to HVN/POC/VAH/VAL, Absorption Wicks, Imbalance Zones & ATR)
 * - Dynamic multi-decimal price rounding (supports BTCUSDT down to micro-cap pairs like PEPEUSDT)
 * - Compounding Margin Engine ($2.00 base margin, +20% of profit compounded on win, reset to base on loss)
 * - Leverage constraint support (10x - 15x Isolated)
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
  takerBuyVolume?: number; // Real aggressive buy volume from Binance kline index [9]
  isClosed?: boolean;
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
  deltaVolume: number; // aggressive buy - aggressive sell volume delta
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
  margin: number; // in USDT (default $2.00 base or compounded)
  leverage: number; // 10x - 15x isolated
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  entryTime: number;
  tpOrderId?: string | number;
  slOrderId?: string | number;
  /** True when the position was discovered on Binance rather than opened by this browser. */
  adoptedFromExchange?: boolean;
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
// 0. Dynamic Multi-Decimal Price Precision Helper
// ---------------------------------------------------------------------------

/**
 * Rounds any crypto asset price to appropriate decimal places based on magnitude
 * so low-priced assets (e.g. PEPEUSDT at $0.00001021) never round to $0.0000.
 */
export function roundCryptoPrice(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  if (price < 0.0001) return Number(price.toFixed(8));
  if (price < 0.01) return Number(price.toFixed(6));
  if (price < 1) return Number(price.toFixed(4));
  if (price < 10) return Number(price.toFixed(3));
  return Number(price.toFixed(2));
}

function formatPriceLabel(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return '0.00';
  if (price < 0.0001) return price.toFixed(8);
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 10) return price.toFixed(3);
  return price.toFixed(2);
}

// ---------------------------------------------------------------------------
// 1. Indicator 1: HVN Profile (High Volume Node & Point of Control)
// ---------------------------------------------------------------------------

/**
 * Calculates Volume Profile across the recent 5m candle window,
 * distributing each candle's volume across the price bins it traded through
 * and determining Point of Control (POC), High Volume Nodes (HVN), and Value Area (VAH/VAL).
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
  const range = maxP - minP || currentPrice * 0.01 || 0.0001;
  const step = range / binCount;

  const bins: { priceLevel: number; volume: number }[] = Array.from({ length: binCount }, (_, i) => ({
    priceLevel: roundCryptoPrice(minP + step * i + step / 2),
    volume: 0,
  }));

  // Distribute each candle's volume across spanned bins (50% across full range, 50% at typical price)
  candles.forEach((c) => {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const typicalIdx = Math.min(
      binCount - 1,
      Math.max(0, Math.floor((typicalPrice - minP) / step))
    );
    const startIdx = Math.min(
      binCount - 1,
      Math.max(0, Math.floor((c.low - minP) / step))
    );
    const endIdx = Math.min(
      binCount - 1,
      Math.max(startIdx, Math.floor((c.high - minP) / step))
    );

    const spannedCount = endIdx - startIdx + 1;
    const rangeWeight = (c.volume * 0.5) / spannedCount;
    for (let idx = startIdx; idx <= endIdx; idx++) {
      bins[idx].volume += rangeWeight;
    }
    bins[typicalIdx].volume += c.volume * 0.5;
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

  // Identify High Volume Nodes (HVNs) where volume >= 1.25x average bin volume
  const hvnLevels: number[] = [];
  const nodes: VolumeNode[] = bins.map((b, idx) => {
    const isPOC = idx === pocIdx;
    const isHVN = b.volume >= avgBinVol * 1.25;
    if (isHVN) hvnLevels.push(b.priceLevel);
    return {
      priceLevel: b.priceLevel,
      volume: Number(b.volume.toFixed(2)),
      isPOC,
      isHVN,
    };
  });

  const pocPrice = roundCryptoPrice(bins[pocIdx]?.priceLevel || currentPrice);

  // Calculate Value Area (70% total volume centered around POC)
  const target70 = totalVol * 0.7;
  let accumulated = bins[pocIdx]?.volume || 0;
  let lowerIdx = pocIdx;
  let upperIdx = pocIdx;

  while (accumulated < target70 && (lowerIdx > 0 || upperIdx < binCount - 1)) {
    const nextLower = lowerIdx > 0 ? bins[lowerIdx - 1].volume : -1;
    const nextUpper = upperIdx < binCount - 1 ? bins[upperIdx + 1].volume : -1;

    if (nextUpper >= nextLower && upperIdx < binCount - 1) {
      upperIdx++;
      accumulated += bins[upperIdx].volume;
    } else if (lowerIdx > 0) {
      lowerIdx--;
      accumulated += bins[lowerIdx].volume;
    } else {
      break;
    }
  }

  const valueAreaHigh = roundCryptoPrice(bins[upperIdx]?.priceLevel || maxP);
  const valueAreaLow = roundCryptoPrice(bins[lowerIdx]?.priceLevel || minP);

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
 * Helper to compute true volume delta (Aggressive Buy Volume - Aggressive Sell Volume)
 * purely in volume units. Uses Binance takerBuyVolume when available, or candle structure fallback.
 */
function computeCandleVolumeDelta(c: Candle): { buyVol: number; sellVol: number; delta: number } {
  if (typeof c.takerBuyVolume === 'number' && c.takerBuyVolume >= 0 && c.takerBuyVolume <= c.volume) {
    const buyVol = c.takerBuyVolume;
    const sellVol = Math.max(0, c.volume - buyVol);
    return {
      buyVol,
      sellVol,
      delta: Number((buyVol - sellVol).toFixed(2)),
    };
  }

  const range = c.high - c.low;
  if (range <= 0) {
    const isGreen = c.close >= c.open;
    const buyVol = isGreen ? c.volume * 0.55 : c.volume * 0.45;
    const sellVol = c.volume - buyVol;
    return { buyVol, sellVol, delta: Number((buyVol - sellVol).toFixed(2)) };
  }

  // Close position within range + wick rejection contribution (all normalized 0..1, multiplied by volume)
  const closeLocation = (c.close - c.low) / range; // 0 at low, 1 at high
  const lowerWickRatio = (Math.min(c.open, c.close) - c.low) / range;
  const upperWickRatio = (c.high - Math.max(c.open, c.close)) / range;

  const buyShare = Math.min(0.92, Math.max(0.08, closeLocation * 0.7 + (0.5 + (lowerWickRatio - upperWickRatio) * 0.5) * 0.3));
  const buyVol = c.volume * buyShare;
  const sellVol = c.volume * (1 - buyShare);

  return {
    buyVol,
    sellVol,
    delta: Number((buyVol - sellVol).toFixed(2)),
  };
}

/**
 * Detects Heavy Absorption where aggressive market orders meet heavy passive limit liquidity.
 * Evaluates high relative volume combined with rejection wicks or delta divergence.
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
  const prev = candles[candles.length - 2];
  const baselineSlice = candles.slice(-12, -1);
  const avgVolume =
    baselineSlice.length > 0
      ? baselineSlice.reduce((acc, c) => acc + c.volume, 0) / baselineSlice.length
      : candles.slice(-10).reduce((acc, c) => acc + c.volume, 0) / Math.min(10, candles.length);

  // If the latest 5m candle just opened and has very low volume compared to the completed candle,
  // also inspect the just-completed candle so confirmed absorption isn't lost on bar rollover
  const target =
    latest.isClosed === false && latest.volume < avgVolume * 0.35 && prev.volume >= avgVolume * 1.15
      ? prev
      : latest;

  const totalRange = target.high - target.low || target.close * 0.0005 || 1e-8;
  const bodySize = Math.abs(target.close - target.open);
  const upperWick = target.high - Math.max(target.open, target.close);
  const lowerWick = Math.min(target.open, target.close) - target.low;

  const volRatio = avgVolume > 0 ? target.volume / avgVolume : 1.0;
  const isHighVolume = volRatio >= 1.2;

  const { delta: deltaVolume } = computeCandleVolumeDelta(target);

  let isAbsorptionDetected = false;
  let type: AbsorptionResult['type'] = 'NONE';
  let absorptionScore = 0;

  const lowerWickShare = lowerWick / totalRange;
  const upperWickShare = upperWick / totalRange;

  // Bullish Absorption:
  // Case A: High volume + strong lower wick rejection (passive limit buyers absorbing aggressive sellers at lows)
  // Case B: High volume + negative delta (aggressive selling) that fails to close near low (delta divergence)
  const isBullishWickAbsorption =
    isHighVolume && lowerWickShare >= 0.42 && lowerWick >= bodySize * 0.85;
  const isBullishDeltaDivergence =
    volRatio >= 1.35 && deltaVolume < 0 && target.close >= target.open && lowerWickShare >= 0.3;

  // Bearish Absorption:
  // Case A: High volume + strong upper wick rejection (passive limit sellers absorbing aggressive buyers at highs)
  // Case B: High volume + positive delta (aggressive buying) that fails to close near high (delta divergence)
  const isBearishWickAbsorption =
    isHighVolume && upperWickShare >= 0.42 && upperWick >= bodySize * 0.85;
  const isBearishDeltaDivergence =
    volRatio >= 1.35 && deltaVolume > 0 && target.close <= target.open && upperWickShare >= 0.3;

  if (isBullishWickAbsorption || isBullishDeltaDivergence) {
    isAbsorptionDetected = true;
    type = 'BULLISH_ABSORPTION';
    absorptionScore = Math.min(
      98,
      Math.max(55, Math.round(Math.min(volRatio, 2.5) * 28 + lowerWickShare * 55))
    );
  } else if (isBearishWickAbsorption || isBearishDeltaDivergence) {
    isAbsorptionDetected = true;
    type = 'BEARISH_ABSORPTION';
    absorptionScore = Math.min(
      98,
      Math.max(55, Math.round(Math.min(volRatio, 2.5) * 28 + upperWickShare * 55))
    );
  }

  const absorptionType: 'BULLISH' | 'BEARISH' | 'NONE' =
    type === 'BULLISH_ABSORPTION' ? 'BULLISH' : type === 'BEARISH_ABSORPTION' ? 'BEARISH' : 'NONE';

  const rawAbsorbedPrice =
    type === 'BULLISH_ABSORPTION'
      ? target.low
      : type === 'BEARISH_ABSORPTION'
      ? target.high
      : target.close;

  return {
    isAbsorptionDetected,
    isHeavyAbsorption: isAbsorptionDetected,
    type,
    absorptionType,
    absorptionScore,
    ratio: absorptionScore,
    deltaVolume,
    absorbedPrice: roundCryptoPrice(rawAbsorbedPrice),
  };
}

// ---------------------------------------------------------------------------
// 3. Indicator 3: Imbalance Levels (3 Stacked Buying/Selling Imbalances)
// ---------------------------------------------------------------------------

/**
 * Detects Volumetric Imbalance Levels (3:1 ratio stacked buying or selling imbalances).
 * Combines real aggressive buy/sell volume ratio with price expansion and clamps extreme division ratios.
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
  const baselineSlice = candles.slice(-12, -1);
  const avgVolume =
    baselineSlice.length > 0
      ? baselineSlice.reduce((acc, c) => acc + c.volume, 0) / baselineSlice.length
      : latest.volume || 1;

  // If current candle just started with negligible volume, inspect the just-closed candle
  const targetIdx =
    latest.isClosed === false && latest.volume < avgVolume * 0.3 && candles.length >= 3
      ? candles.length - 2
      : candles.length - 1;
  const target = candles[targetIdx];
  const prior = candles[Math.max(0, targetIdx - 1)];

  const priceDelta = target.close - prior.close;
  const isUptrendMomentum = priceDelta > 0 || target.close > target.open;
  const isDowntrendMomentum = priceDelta < 0 || target.close < target.open;

  const totalRange = target.high - target.low || target.close * 0.001 || 1e-8;
  // Regularize denominator to at least 8% of candle range so close === high never divides by zero
  const effectiveFloor = totalRange * 0.08;
  const buySpan = Math.max(effectiveFloor, target.close - target.low);
  const sellSpan = Math.max(effectiveFloor, target.high - target.close);

  const volMultiplier = avgVolume > 0 ? Math.min(2.2, Math.max(0.6, target.volume / avgVolume)) : 1.0;

  // Incorporate real takerBuyVolume ratio if available from Binance kline data
  let takerBuyRatio = 1.0;
  let takerSellRatio = 1.0;
  if (
    typeof target.takerBuyVolume === 'number' &&
    target.takerBuyVolume > 0 &&
    target.volume > target.takerBuyVolume
  ) {
    const buyV = target.takerBuyVolume;
    const sellV = Math.max(target.volume * 0.08, target.volume - buyV);
    takerBuyRatio = buyV / sellV;
    takerSellRatio = sellV / Math.max(target.volume * 0.08, buyV);
  }

  const rawBuyRatio = ((buySpan / sellSpan) * 0.65 + takerBuyRatio * 0.35) * Math.sqrt(volMultiplier);
  const rawSellRatio = ((sellSpan / buySpan) * 0.65 + takerSellRatio * 0.35) * Math.sqrt(volMultiplier);

  // Clamp ratio to a realistic order-flow footprint range [1.0, 12.0]
  const buyRatio = Math.min(12.0, Math.max(1.0, rawBuyRatio));
  const sellRatio = Math.min(12.0, Math.max(1.0, rawSellRatio));

  let stackedImbalanceCount = 0;
  let type: ImbalanceResult['type'] = 'BALANCED';
  let isImbalanceDetected = false;
  let maxImbalanceRatio = 1.0;
  const imbalancePriceLevels: number[] = [];

  const step = totalRange / 4;

  if (isUptrendMomentum && buyRatio >= minRatio) {
    isImbalanceDetected = true;
    type = 'BUY_IMBALANCE';
    stackedImbalanceCount = 3;
    maxImbalanceRatio = Number(buyRatio.toFixed(2));
    imbalancePriceLevels.push(
      roundCryptoPrice(target.low + step),
      roundCryptoPrice(target.low + step * 2),
      roundCryptoPrice(target.low + step * 3)
    );
  } else if (isDowntrendMomentum && sellRatio >= minRatio) {
    isImbalanceDetected = true;
    type = 'SELL_IMBALANCE';
    stackedImbalanceCount = 3;
    maxImbalanceRatio = Number(sellRatio.toFixed(2));
    imbalancePriceLevels.push(
      roundCryptoPrice(target.high - step),
      roundCryptoPrice(target.high - step * 2),
      roundCryptoPrice(target.high - step * 3)
    );
  } else if (Math.max(buyRatio, sellRatio) >= 1.65) {
    type = buyRatio >= sellRatio ? 'BUY_IMBALANCE' : 'SELL_IMBALANCE';
    stackedImbalanceCount = 2;
    maxImbalanceRatio = Number(Math.max(buyRatio, sellRatio).toFixed(2));
    if (type === 'BUY_IMBALANCE') {
      imbalancePriceLevels.push(
        roundCryptoPrice(target.low + step),
        roundCryptoPrice(target.low + step * 2)
      );
    } else {
      imbalancePriceLevels.push(
        roundCryptoPrice(target.high - step),
        roundCryptoPrice(target.high - step * 2)
      );
    }
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
  return Number((sum / trs.length).toFixed(8));
}

// ---------------------------------------------------------------------------
// 5. 3-Indicator Strategy Signal Evaluator (HVN + Absorption + Imbalances)
// ---------------------------------------------------------------------------

export function evaluate3IndicatorSignal(
  symbol: string,
  candles: Candle[]
): SignalEvaluation {
  const rawPrice = candles[candles.length - 1]?.close || 0;
  const currentPrice = roundCryptoPrice(rawPrice);
  const atr = calculateATR(candles, 14);

  const hvnProfile = calculateHVNProfile(candles, 14);
  const absorption = calculateHeavyAbsorption(candles);
  const imbalance = calculateImbalanceLevels(candles, 3.0);

  const reasons: string[] = [];
  let bullPoints = 0;
  let bearPoints = 0;

  // 1. Indicator 1: HVN Profile Evaluation (Point of Control & Value Area Nodes)
  if (hvnProfile.priceRelation === 'ABOVE_POC') {
    bullPoints += 35;
    reasons.push(`Price trading above Point of Control (POC: $${formatPriceLabel(hvnProfile.pocPrice)})`);
  } else if (hvnProfile.priceRelation === 'BELOW_POC') {
    bearPoints += 35;
    reasons.push(`Price trading below Point of Control (POC: $${formatPriceLabel(hvnProfile.pocPrice)})`);
  } else {
    bullPoints += 20;
    bearPoints += 20;
    reasons.push(`Price testing Point of Control value node ($${formatPriceLabel(hvnProfile.pocPrice)})`);
  }

  // 2. Indicator 2: Heavy Absorption Evaluation
  if (absorption.type === 'BULLISH_ABSORPTION') {
    bullPoints += 35;
    reasons.push(
      `Heavy Bullish Absorption (${absorption.absorptionScore}%) at $${formatPriceLabel(absorption.absorbedPrice)}`
    );
  } else if (absorption.type === 'BEARISH_ABSORPTION') {
    bearPoints += 35;
    reasons.push(
      `Heavy Bearish Absorption (${absorption.absorptionScore}%) at $${formatPriceLabel(absorption.absorbedPrice)}`
    );
  } else if (absorption.deltaVolume > 0 && hvnProfile.priceRelation === 'ABOVE_POC') {
    bullPoints += 10;
  } else if (absorption.deltaVolume < 0 && hvnProfile.priceRelation === 'BELOW_POC') {
    bearPoints += 10;
  }

  // 3. Indicator 3: Imbalance Levels Evaluation (Stacked 3:1 Imbalance)
  if (imbalance.isImbalanceDetected && imbalance.type === 'BUY_IMBALANCE') {
    bullPoints += 30;
    reasons.push(`Stacked 3:1 Buying Imbalance (${imbalance.maxImbalanceRatio}x across ${imbalance.stackedImbalanceCount} levels)`);
  } else if (imbalance.isImbalanceDetected && imbalance.type === 'SELL_IMBALANCE') {
    bearPoints += 30;
    reasons.push(`Stacked 3:1 Selling Imbalance (${imbalance.maxImbalanceRatio}x across ${imbalance.stackedImbalanceCount} levels)`);
  } else if (imbalance.stackedImbalanceCount === 2 && imbalance.type === 'BUY_IMBALANCE') {
    bullPoints += 15;
    reasons.push(`Developing Buy Imbalance (${imbalance.maxImbalanceRatio}x, 2 stacked levels)`);
  } else if (imbalance.stackedImbalanceCount === 2 && imbalance.type === 'SELL_IMBALANCE') {
    bearPoints += 15;
    reasons.push(`Developing Sell Imbalance (${imbalance.maxImbalanceRatio}x, 2 stacked levels)`);
  }

  // Penalize conflicting Order Flow (e.g. Bullish Imbalance running straight into Bearish Absorption)
  if (absorption.type === 'BEARISH_ABSORPTION' && bullPoints > bearPoints) {
    bullPoints = Math.max(0, bullPoints - 25);
  }
  if (absorption.type === 'BULLISH_ABSORPTION' && bearPoints > bullPoints) {
    bearPoints = Math.max(0, bearPoints - 25);
  }

  // Determine Final Signal & Action
  let signal: SignalType = 'NEUTRAL';
  let action: 'LONG' | 'SHORT' | 'HOLD' = 'HOLD';
  let score = 50;

  if (bullPoints >= 70 && bullPoints > bearPoints) {
    signal = 'STRONG_BUY';
    action = 'LONG';
    score = Math.min(98, bullPoints);
  } else if (bullPoints >= 55 && bullPoints > bearPoints) {
    signal = 'BUY';
    action = 'LONG';
    score = bullPoints;
  } else if (bearPoints >= 70 && bearPoints > bullPoints) {
    signal = 'STRONG_SELL';
    action = 'SHORT';
    score = Math.min(98, bearPoints);
  } else if (bearPoints >= 55 && bearPoints > bullPoints) {
    signal = 'SELL';
    action = 'SHORT';
    score = bearPoints;
  } else {
    signal = 'NEUTRAL';
    action = 'HOLD';
    score = Math.max(bullPoints, bearPoints, 35);
  }

  // -------------------------------------------------------------------------
  // Indicator-Driven Dynamic TP and SL (Anchored to HVN, Absorption & Imbalance)
  // -------------------------------------------------------------------------
  const safeAtr = atr > 0 ? atr : currentPrice * 0.008 || 1e-6;
  let tpPrice = currentPrice;
  let slPrice = currentPrice;

  if (action === 'LONG') {
    // Candidate structural support levels from our 3 indicators below currentPrice:
    // 1. Absorption wick low (if bullish absorption detected)
    // 2. Lowest stacked buy imbalance level
    // 3. HVN / POC / VAL node below price
    const structuralSupports: number[] = [];
    if (absorption.type === 'BULLISH_ABSORPTION' && absorption.absorbedPrice < currentPrice) {
      structuralSupports.push(absorption.absorbedPrice * 0.9985);
    }
    if (imbalance.type === 'BUY_IMBALANCE' && imbalance.imbalancePriceLevels.length > 0) {
      const lowestImb = Math.min(...imbalance.imbalancePriceLevels);
      if (lowestImb < currentPrice) structuralSupports.push(lowestImb * 0.9985);
    }
    if (hvnProfile.pocPrice < currentPrice) {
      structuralSupports.push(hvnProfile.pocPrice * 0.998);
    }
    if (hvnProfile.valueAreaLow < currentPrice) {
      structuralSupports.push(hvnProfile.valueAreaLow * 0.998);
    }

    // Pick the tightest structural indicator support that gives at least 0.8 * ATR breathing room,
    // and cap maximum SL distance at 1.6 * ATR so Risk/Reward is never inverted.
    const minSl = currentPrice - 1.6 * safeAtr;
    const maxSl = currentPrice - 0.85 * safeAtr;
    const validSupports = structuralSupports.filter((s) => s >= minSl && s <= maxSl);
    const rawSl =
      validSupports.length > 0
        ? Math.max(...validSupports)
        : Math.max(minSl, Math.min(maxSl, currentPrice - 1.4 * safeAtr));
    slPrice = roundCryptoPrice(rawSl);

    // Ensure SL is strictly below currentPrice
    if (slPrice >= currentPrice) {
      slPrice = roundCryptoPrice(currentPrice * 0.99);
    }

    const riskDist = Math.max(currentPrice - slPrice, safeAtr * 0.8);

    // Indicator-based Take Profit target: upper HVN / VAH node or Volume Profile extension (>= 1.67x risk)
    const upperNodes = [
      ...hvnProfile.hvnLevels.filter((lvl) => lvl > currentPrice + riskDist * 1.4),
      hvnProfile.valueAreaHigh > currentPrice + riskDist * 1.4 ? hvnProfile.valueAreaHigh : 0,
    ].filter((lvl) => lvl > 0 && lvl <= currentPrice + 3.5 * safeAtr);

    const rawTp =
      upperNodes.length > 0
        ? Math.max(...upperNodes, currentPrice + riskDist * 1.67)
        : currentPrice + Math.max(2.4 * safeAtr, riskDist * 1.67);
    tpPrice = roundCryptoPrice(rawTp);
  } else if (action === 'SHORT') {
    // Candidate structural resistance levels from our 3 indicators above currentPrice:
    const structuralResistances: number[] = [];
    if (absorption.type === 'BEARISH_ABSORPTION' && absorption.absorbedPrice > currentPrice) {
      structuralResistances.push(absorption.absorbedPrice * 1.0015);
    }
    if (imbalance.type === 'SELL_IMBALANCE' && imbalance.imbalancePriceLevels.length > 0) {
      const highestImb = Math.max(...imbalance.imbalancePriceLevels);
      if (highestImb > currentPrice) structuralResistances.push(highestImb * 1.0015);
    }
    if (hvnProfile.pocPrice > currentPrice) {
      structuralResistances.push(hvnProfile.pocPrice * 1.002);
    }
    if (hvnProfile.valueAreaHigh > currentPrice) {
      structuralResistances.push(hvnProfile.valueAreaHigh * 1.002);
    }

    const minSl = currentPrice + 0.85 * safeAtr;
    const maxSl = currentPrice + 1.6 * safeAtr;
    const validResistances = structuralResistances.filter((r) => r >= minSl && r <= maxSl);
    const rawSl =
      validResistances.length > 0
        ? Math.min(...validResistances)
        : Math.min(maxSl, Math.max(minSl, currentPrice + 1.4 * safeAtr));
    slPrice = roundCryptoPrice(rawSl);

    if (slPrice <= currentPrice) {
      slPrice = roundCryptoPrice(currentPrice * 1.01);
    }

    const riskDist = Math.max(slPrice - currentPrice, safeAtr * 0.8);

    const lowerNodes = [
      ...hvnProfile.hvnLevels.filter((lvl) => lvl < currentPrice - riskDist * 1.4),
      hvnProfile.valueAreaLow < currentPrice - riskDist * 1.4 ? hvnProfile.valueAreaLow : 0,
    ].filter((lvl) => lvl > 0 && lvl >= currentPrice - 3.5 * safeAtr);

    const rawTp =
      lowerNodes.length > 0
        ? Math.min(...lowerNodes, currentPrice - riskDist * 1.67)
        : currentPrice - Math.max(2.4 * safeAtr, riskDist * 1.67);
    tpPrice = roundCryptoPrice( Math.max(rawTp, currentPrice * 0.1) );
  } else {
    tpPrice = roundCryptoPrice(currentPrice + 2.2 * safeAtr);
    slPrice = roundCryptoPrice(Math.max(currentPrice * 0.1, currentPrice - 1.4 * safeAtr));
  }

  const actualRisk = Math.abs(currentPrice - slPrice);
  const actualReward = Math.abs(tpPrice - currentPrice);
  const riskRewardRatio =
    actualRisk > 0 ? Number((actualReward / actualRisk).toFixed(2)) : 1.67;

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
    riskRewardRatio,
    hvnProfile,
    absorption,
    imbalance,
    reasons,
  };
}

/**
 * Sorts scanned Futures pairs by actionable signal quality & High Volatility
 */
export function sortByVolatility(signals: SignalEvaluation[]): SignalEvaluation[] {
  return [...signals].sort((a, b) => b.volatilityPercent - a.volatilityPercent);
}

// ---------------------------------------------------------------------------
// 6. Compounding & Position Management ($2 Base Margin, +20% Win Compounding)
// ---------------------------------------------------------------------------

export const MAX_OPEN_TRADES = 5;

export function calculateNextTradeMargin(
  state: CompoundingState,
  lastTradeResult: { isWin: boolean; profit: number }
): { nextMargin: number; bonusAdded: number; newState: CompoundingState } {
  const { baseMargin, compoundingPercent } = state;

  if (lastTradeResult.isWin && lastTradeResult.profit > 0) {
    const bonus = Number((lastTradeResult.profit * (compoundingPercent / 100)).toFixed(4));
    // Accumulate onto currentMargin when on a winning streak, starting from baseMargin ($2.00)
    const activeBase = state.consecutiveWins > 0 ? state.currentMargin : baseMargin;
    const nextMargin = Number((activeBase + bonus).toFixed(2));

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
  maxLimit: number = BINANCE_DEFAULT_WEIGHT_LIMIT,
  safetyThresholdRatio: number = RATE_LIMIT_SAFETY_THRESHOLD
): RateLimitStatus {
  const effectiveThreshold =
    safetyThresholdRatio > 1 ? safetyThresholdRatio / 100 : safetyThresholdRatio;
  const usageRatio = maxLimit > 0 ? usedWeight / maxLimit : 0;
  const usagePercent = Number((usageRatio * 100).toFixed(1));
  const isThrottled = usageRatio >= effectiveThreshold;
  const isSafe = !isThrottled;
  const remainingWeight = Math.max(0, Math.floor(maxLimit * effectiveThreshold - usedWeight));

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
