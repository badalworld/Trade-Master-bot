/**
 * Market-regime measurement: how volatile is this pair, and is it trending or chopping?
 *
 * Three questions the scanner previously could not answer, and each one cost money:
 *
 *  1. **Is this pair moving at all?** A 0.3%-ATR pair produces signals that look like setups and
 *     stop out on spread. Volatility used to be measured for display only (`isHighVol >= 1.5`
 *     coloured a badge) and never gated anything.
 *  2. **Is this pair trending?** Two of the three indicator families (HVN relation, stacked
 *     imbalance) read as "bullish" in a market that is simply oscillating sideways, which is how a
 *     chop market generates a steady supply of losing longs and shorts at 10-15x.
 *  3. **Where does this pair sit in the market?** "Most volatile" is meaningless as a raw number
 *     across regimes — the same 1.2% ATR is the calmest pair in a mania and the wildest in a dead
 *     market — so volatility is also expressed as a percentile of everything scanned.
 *
 * Everything here is pure and operates on **settled** candles: the forming bar changes on every
 * tick, so a gate that reads it flickers on and off within a single 5m candle and the engine can
 * enter on a signal that no longer exists a second later.
 *
 * No I/O, no env, no `@/` imports — directly runnable under `node --test`.
 */

import type { Candle } from './trading-engine.ts';

/** Drop the still-forming candle. Anything without an explicit `isClosed` is treated as settled. */
export function settledCandles(candles: Candle[]): Candle[] {
  return candles.filter((c) => c.isClosed !== false);
}

const sum = (values: number[]): number => values.reduce((acc, v) => acc + v, 0);

function trueRange(current: Candle, previous: Candle): number {
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close)
  );
}

/**
 * Directional movement below this share of the true range is noise, not direction.
 *
 * This floor exists because of a trap in Wilder's DI ratio: `|+DI - -DI| / (+DI + -DI)` keeps its
 * meaning while both DIs are meaningfully large, but as they both approach zero the ratio amplifies
 * rounding rather than information. A market that oscillates inside a fixed range can leave one
 * decayed directional leg against a steady true range — and report DX = 100, i.e. the *least*
 * trending market in the world scored as the most trending. Refusing to score direction when total
 * directional movement is this small a fraction of total range is what keeps "goes nowhere" from
 * reading as "strongest trend".
 */
const DIRECTIONAL_NOISE_FLOOR = 0.1;

/**
 * Wilder's ADX — trend *strength*, directionless, 0–100.
 *
 * The textbook use is >= 25 trending, < 20 ranging. Returns `NaN` when there are not enough
 * candles for a seeded Wilder average (2 x period + 1), because a half-computed ADX would be a
 * confident-looking number with no meaning.
 */
export function computeADX(candles: Candle[], period = 14): number {
  if (!Number.isFinite(period) || period < 2) return NaN;
  if (candles.length < period * 2 + 1) return NaN;

  const trs: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    trs.push(trueRange(candles[i], candles[i - 1]));
  }

  let trSmooth = sum(trs.slice(0, period));
  let plusSmooth = sum(plusDM.slice(0, period));
  let minusSmooth = sum(minusDM.slice(0, period));

  const dxs: number[] = [];
  const pushDx = () => {
    const directional = plusSmooth + minusSmooth;
    // See DIRECTIONAL_NOISE_FLOOR: no direction worth scoring, so score none.
    if (trSmooth <= 0 || directional <= trSmooth * DIRECTIONAL_NOISE_FLOOR) {
      dxs.push(0);
      return;
    }
    const plusDI = (100 * plusSmooth) / trSmooth;
    const minusDI = (100 * minusSmooth) / trSmooth;
    const denom = plusDI + minusDI;
    dxs.push(denom > 0 ? (100 * Math.abs(plusDI - minusDI)) / denom : 0);
  };
  pushDx();

  for (let i = period; i < trs.length; i++) {
    trSmooth = trSmooth - trSmooth / period + trs[i];
    plusSmooth = plusSmooth - plusSmooth / period + plusDM[i];
    minusSmooth = minusSmooth - minusSmooth / period + minusDM[i];
    pushDx();
  }

  if (dxs.length < period) return NaN;
  let adx = sum(dxs.slice(0, period)) / period;
  for (let i = period; i < dxs.length; i++) {
    adx = (adx * (period - 1) + dxs[i]) / period;
  }
  return Number(adx.toFixed(2));
}

/**
 * Kaufman's efficiency ratio: net move divided by the total path walked, 0–1.
 *
 * ADX measures directional strength of *movement*; ER measures how much of that movement actually
 * went anywhere. A market can post a respectable ADX while price saws back and forth (ER ≈ 0.1),
 * and that is where stop-hunting brackets die. Both together are what "choppy" means here.
 */
export function computeEfficiencyRatio(candles: Candle[], period = 10): number {
  if (!Number.isFinite(period) || period < 2) return NaN;
  const rows = candles.slice(-(period + 1));
  if (rows.length < period + 1) return NaN;

  const netChange = Math.abs(rows[rows.length - 1].close - rows[0].close);
  let path = 0;
  for (let i = 1; i < rows.length; i++) path += Math.abs(rows[i].close - rows[i - 1].close);
  if (!(path > 0)) return 0;
  return Number((netChange / path).toFixed(3));
}

/** Per-bar standard deviation of log returns, in percent. A different lens on the same tape as ATR%. */
export function computeRealizedVolPercent(candles: Candle[], period = 20): number {
  const rows = candles.slice(-(period + 1));
  const returns: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].close;
    const curr = rows[i].close;
    if (prev > 0 && curr > 0) returns.push(Math.log(curr / prev));
  }
  if (returns.length < 2) return NaN;
  const mean = sum(returns) / returns.length;
  const variance = sum(returns.map((r) => (r - mean) ** 2)) / (returns.length - 1);
  return Number((Math.sqrt(variance) * 100).toFixed(3));
}

/** High-low expansion over the last `period` settled candles, in percent. */
export function computeRangeExpansionPercent(candles: Candle[], period = 10): number {
  const rows = candles.slice(-period);
  if (rows.length < 2) return NaN;
  const high = Math.max(...rows.map((c) => c.high));
  const low = Math.min(...rows.map((c) => c.low));
  if (!(low > 0)) return NaN;
  return Number((((high - low) / low) * 100).toFixed(3));
}

export type VolatilityLevel = 'LOW' | 'TRADEABLE' | 'HIGH';

export interface VolatilityBand {
  /** Below this the pair is chop/dead — signals there are noise and stops die on spread. */
  minPercent: number;
  /** Above this the pair is violent enough that a 1.x-ATR stop is a coin flip. */
  maxPercent: number;
}

export interface VolatilityVerdict {
  level: VolatilityLevel;
  allowed: boolean;
  /** Human-readable reason when not allowed, for the scanner row and the engine log. */
  reason?: string;
}

/**
 * Band gate. Order matters: an unreadable metric is refused rather than passed, so a broken candle
 * feed cannot silently become a trade.
 */
export function classifyVolatility(volPercent: number, band: VolatilityBand): VolatilityVerdict {
  if (!Number.isFinite(volPercent) || volPercent <= 0) {
    return { level: 'LOW', allowed: false, reason: 'volatility could not be measured from the candles' };
  }
  if (volPercent < band.minPercent) {
    return {
      level: 'LOW',
      allowed: false,
      reason: `volatility ${volPercent.toFixed(2)}% is under the ${band.minPercent}% floor (dead/quiet market)`,
    };
  }
  if (volPercent > band.maxPercent) {
    return {
      level: 'HIGH',
      allowed: false,
      reason: `volatility ${volPercent.toFixed(2)}% is over the ${band.maxPercent}% ceiling (violent market, stop becomes a coin flip)`,
    };
  }
  return { level: 'TRADEABLE', allowed: true };
}

export interface ChopThresholds {
  /** ADX below this is "no trend". */
  adxFloor: number;
  /** Efficiency ratio below this is "price is going nowhere". */
  efficiencyFloor: number;
}

export interface ChopVerdict {
  choppy: boolean;
  adx: number;
  efficiencyRatio: number;
  detail: string;
  reason?: string;
}

/**
 * The chop filter. Both measurements must agree before a pair is refused, so a clean slow trend
 * (low ADX, high ER) is still traded — refusing on ADX alone throws away exactly the orderly
 * markets a mean-reversion-and-imbalance strategy is built for.
 *
 * Missing data never *creates* a chop verdict: if ADX could not be computed, ER alone decides; if
 * ER could not be computed, the pair is not called choppy (the volatility band still gates it).
 */
export function evaluateChop(adx: number, efficiencyRatio: number, thresholds: ChopThresholds): ChopVerdict {
  const adxKnown = Number.isFinite(adx);
  const erKnown = Number.isFinite(efficiencyRatio);
  const adxLow = adxKnown && adx < thresholds.adxFloor;
  const erLow = erKnown && efficiencyRatio < thresholds.efficiencyFloor;

  const choppy = erKnown ? erLow && (adxLow || !adxKnown) : false;
  const detail = `ADX ${adxKnown ? adx.toFixed(1) : 'n/a'}, ER ${erKnown ? efficiencyRatio.toFixed(2) : 'n/a'}`;

  return {
    choppy,
    adx,
    efficiencyRatio,
    detail,
    reason: choppy ? `choppy market (${detail})` : undefined,
  };
}

export type TrendStrength = 'TRENDING' | 'DEVELOPING' | 'CHOPPY';

export function trendStrengthFrom(adx: number, efficiencyRatio: number, choppy: boolean): TrendStrength {
  if (choppy) return 'CHOPPY';
  const adxOk = Number.isFinite(adx) && adx >= 25;
  const erOk = Number.isFinite(efficiencyRatio) && efficiencyRatio >= 0.5;
  if (adxOk || erOk) return 'TRENDING';
  return 'DEVELOPING';
}

/**
 * Percentile of each value within the set, 0–100, where 100 is the most volatile entry.
 *
 * This is what makes "scan most volatile → least volatile" mean something: the raw percent is only
 * comparable within one market regime, the rank is comparable across all of them and across
 * whatever universe the exchange happens to be listing today. Ties share a rank.
 */
export function volatilityRanks(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [100];

  const sorted = [...values].sort((a, b) => a - b);
  return values.map((value) => {
    let below = 0;
    let equal = 0;
    for (const candidate of sorted) {
      if (candidate < value) below++;
      else if (candidate === value) equal++;
    }
    const midRank = below + (equal - 1) / 2;
    return Math.round((midRank / (n - 1)) * 100);
  });
}

export interface RegimeMetrics {
  /** Wilder ADX on settled candles; NaN when there are not enough of them. */
  adx: number;
  /** Kaufman efficiency ratio 0–1; NaN when there are not enough candles. */
  efficiencyRatio: number;
  realizedVolPercent: number;
  rangeExpansionPercent: number;
  trendStrength: TrendStrength;
  choppy: boolean;
  /** e.g. "ADX 13.8, ER 0.21" — shown verbatim in the scanner and the engine log. */
  detail: string;
}

/** Everything the regime layer can say about one pair, from settled candles only. */
export function measureRegime(candles: Candle[], thresholds: ChopThresholds): RegimeMetrics {
  const settled = settledCandles(candles);
  const adx = computeADX(settled);
  const efficiencyRatio = computeEfficiencyRatio(settled);
  const chop = evaluateChop(adx, efficiencyRatio, thresholds);

  return {
    adx,
    efficiencyRatio,
    realizedVolPercent: computeRealizedVolPercent(settled),
    rangeExpansionPercent: computeRangeExpansionPercent(settled),
    trendStrength: trendStrengthFrom(adx, efficiencyRatio, chop.choppy),
    choppy: chop.choppy,
    detail: chop.detail,
  };
}
