import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyVolatility,
  computeADX,
  computeEfficiencyRatio,
  computeRangeExpansionPercent,
  computeRealizedVolPercent,
  evaluateChop,
  measureRegime,
  settledCandles,
  trendStrengthFrom,
  volatilityRanks,
} from './market-regime.ts';
import type { Candle } from './trading-engine.ts';

const BAR_MS = 5 * 60 * 1000;

/** Hand-built candles with an explicit high/low envelope, so each scenario is unambiguous. */
function series(closes: number[], opts: { wick?: number; volume?: number; closed?: boolean } = {}): Candle[] {
  const wick = opts.wick ?? 0;
  return closes.map((close, i) => ({
    time: i * BAR_MS,
    open: i === 0 ? close : closes[i - 1],
    high: Math.max(close, i === 0 ? close : closes[i - 1]) + wick,
    low: Math.min(close, i === 0 ? close : closes[i - 1]) - wick,
    close,
    volume: opts.volume ?? 1000,
    isClosed: opts.closed ?? true,
  }));
}

const line = (from: number, to: number, steps: number): number[] =>
  Array.from({ length: steps }, (_, i) => from + ((to - from) * i) / (steps - 1));

/** A market that goes nowhere: price oscillates around a level, bar after bar. */
const oscillating = (center: number, amplitude: number, steps: number): number[] =>
  Array.from({ length: steps }, (_, i) => center + (i % 2 === 0 ? amplitude : -amplitude));

// --------------------------------------------------------------------------- settled candles
test('the forming candle is never part of a regime measurement', () => {
  const candles = series([100, 101, 102, 103]);
  const withForming = [...candles.slice(0, 3), { ...candles[3], isClosed: false }];

  assert.equal(settledCandles(candles).length, 4, 'missing isClosed means settled');
  assert.equal(settledCandles(withForming).length, 3, 'the bar that can still change is excluded');
});

// --------------------------------------------------------------------------- ADX
test('ADX is high on a clean trend and low on a market that only oscillates', () => {
  const trending = computeADX(series(line(100, 130, 60)), 14);
  const chopping = computeADX(series(oscillating(100, 0.4, 60)), 14);

  assert.ok(Number.isFinite(trending) && trending > 40, `trend ADX should be strong, got ${trending}`);
  assert.ok(Number.isFinite(chopping) && chopping < 25, `chop ADX should be weak, got ${chopping}`);
  assert.ok(trending > chopping + 20, 'a trend and a chop market must not look alike');
});

test('a flat oscillation cannot be scored as a maximal trend', () => {
  // The degenerate case: price alternates inside a fixed range, so one directional leg decays while
  // the true range stays put. Wilder's DI ratio alone reads that as DX = 100 — the calmest market in
  // existence reported as the strongest trend, which would have sent the bot straight into it.
  const flat = computeADX(series(oscillating(100, 0.4, 60), { wick: 0.1 }), 14);
  assert.ok(flat < 25, `a market that goes nowhere must not read as trending, got ADX ${flat}`);
});

test('ADX is directionless: an identical downtrend scores the same as an uptrend', () => {
  const up = computeADX(series(line(100, 130, 60)), 14);
  const down = computeADX(series(line(130, 100, 60)), 14);
  assert.ok(Math.abs(up - down) < 1, `up ${up} vs down ${down} should match`);
});

test('ADX refuses to answer when there are not enough candles to seed it', () => {
  assert.ok(Number.isNaN(computeADX(series(line(100, 110, 20)), 14)), '20 candles cannot seed a 14-period ADX');
  assert.ok(Number.isNaN(computeADX([], 14)));
});

// --------------------------------------------------------------------------- efficiency ratio
test('the efficiency ratio separates a straight move from a round trip', () => {
  const straight = computeEfficiencyRatio(series(line(100, 110, 21)), 10);
  const roundTrip = computeEfficiencyRatio(series([...line(100, 110, 6), ...line(110, 100, 5)]), 10);

  assert.ok(straight > 0.9, `a straight 10% move should be efficient, got ${straight}`);
  assert.ok(roundTrip < 0.3, `a round trip should be inefficient, got ${roundTrip}`);
});

test('the efficiency ratio is bounded and safe on degenerate input', () => {
  assert.ok(Number.isNaN(computeEfficiencyRatio(series([100, 101]), 10)), 'not enough candles');
  const flat = computeEfficiencyRatio(series(Array(12).fill(100)), 10);
  assert.equal(flat, 0, 'a market that never moves has no efficiency, and must not divide by zero');
});

// --------------------------------------------------------------------------- volatility shapes
test('realised volatility and range expansion both grow with the violence of the tape', () => {
  const calm = series(line(100, 100.5, 30));
  const wild = series(line(100, 130, 30));

  assert.ok(computeRealizedVolPercent(wild) > computeRealizedVolPercent(calm) * 5);
  assert.ok(computeRangeExpansionPercent(wild) > computeRangeExpansionPercent(calm));
  assert.ok(Number.isNaN(computeRealizedVolPercent(series([100]), 20)));
});

// --------------------------------------------------------------------------- chop filter
const THRESHOLDS = { adxFloor: 20, efficiencyFloor: 0.3 };

test('chop needs both measurements to agree — a clean slow trend is still tradeable', () => {
  const choppy = evaluateChop(12, 0.15, THRESHOLDS);
  assert.equal(choppy.choppy, true);
  assert.match(choppy.reason ?? '', /choppy market/);
  assert.match(choppy.detail, /ADX 12\.0, ER 0\.15/);

  // Low ADX but price is actually travelling somewhere: that is a slow trend, not chop.
  assert.equal(evaluateChop(12, 0.75, THRESHOLDS).choppy, false);

  // Trending hard but sawing: it is moving, and both filter conditions must hold before refusing.
  assert.equal(evaluateChop(35, 0.1, THRESHOLDS).choppy, false);
});

test('missing measurements never invent a chop verdict', () => {
  // No ADX (not enough candles) but ER is available and says "going nowhere".
  assert.equal(evaluateChop(NaN, 0.1, THRESHOLDS).choppy, true);
  // No ER: the pair is not called choppy on an ADX reading alone.
  assert.equal(evaluateChop(10, NaN, THRESHOLDS).choppy, false);
  // Nothing measurable at all.
  assert.equal(evaluateChop(NaN, NaN, THRESHOLDS).choppy, false);
});

test('trend strength is a three-way label, not a boolean', () => {
  assert.equal(trendStrengthFrom(30, 0.6, false), 'TRENDING');
  assert.equal(trendStrengthFrom(15, 0.15, true), 'CHOPPY');
  assert.equal(trendStrengthFrom(18, 0.4, false), 'DEVELOPING');
  // A high efficiency ratio alone is enough to call it trending even at a modest ADX.
  assert.equal(trendStrengthFrom(18, 0.55, false), 'TRENDING');
});

// --------------------------------------------------------------------------- bands
const BAND = { minPercent: 0.6, maxPercent: 4 };

test('the volatility band refuses both dead markets and violent ones', () => {
  assert.equal(classifyVolatility(1.4, BAND).allowed, true);
  assert.equal(classifyVolatility(1.4, BAND).level, 'TRADEABLE');

  const quiet = classifyVolatility(0.25, BAND);
  assert.equal(quiet.level, 'LOW');
  assert.equal(quiet.allowed, false);
  assert.match(quiet.reason ?? '', /floor/);

  const violent = classifyVolatility(7.5, BAND);
  assert.equal(violent.level, 'HIGH');
  assert.equal(violent.allowed, false);
  assert.match(violent.reason ?? '', /ceiling/);
});

test('the band boundaries are inclusive, and an unmeasurable value is refused rather than passed', () => {
  assert.equal(classifyVolatility(0.6, BAND).allowed, true);
  assert.equal(classifyVolatility(4, BAND).allowed, true);

  for (const value of [NaN, Infinity, 0, -1]) {
    const verdict = classifyVolatility(value, BAND);
    assert.equal(verdict.allowed, false, `${value} must not be tradeable`);
    assert.match(verdict.reason ?? '', /could not be measured/);
  }
});

// --------------------------------------------------------------------------- ranking
test('volatility ranks are percentiles: 100 is the most volatile pair scanned', () => {
  const ranks = volatilityRanks([0.5, 2.0, 1.0, 4.0]);
  assert.deepEqual(ranks, [0, 67, 33, 100], 'ranks must be strictly increasing with volatility');
  assert.equal(volatilityRanks([]).length, 0);
  assert.deepEqual(volatilityRanks([1.23]), [100], 'a single pair is trivially the most volatile');
});

test('ties share a rank instead of being ordered arbitrarily', () => {
  const ranks = volatilityRanks([1, 1, 3]);
  assert.equal(ranks[0], ranks[1], 'identical volatility must not produce different ranks');
  assert.equal(ranks[2], 100);
});

// --------------------------------------------------------------------------- end to end
test('measureRegime summarises a pair the way the scanner reads it', () => {
  const trend = measureRegime(series(line(100, 120, 60), { wick: 0.2 }), THRESHOLDS);
  assert.equal(trend.choppy, false);
  assert.equal(trend.trendStrength, 'TRENDING');
  assert.ok(trend.realizedVolPercent > 0);
  assert.match(trend.detail, /ADX \d+\.\d, ER \d\.\d+/);

  const chop = measureRegime(series(oscillating(100, 0.3, 60), { wick: 0.1 }), THRESHOLDS);
  assert.equal(chop.choppy, true);
  assert.equal(chop.trendStrength, 'CHOPPY');
});

test('measureRegime ignores a forming candle that would otherwise flip the verdict', () => {
  const settled = series(line(100, 120, 60), { wick: 0.2 });
  // A wild, still-forming bar at the end: if the regime read it, the pair would look violent.
  const withForming = [
    ...settled,
    { time: 60 * BAR_MS, open: 120, high: 200, low: 50, close: 60, volume: 9999, isClosed: false },
  ];
  const fromSettled = measureRegime(settled, THRESHOLDS);
  const fromForming = measureRegime(withForming, THRESHOLDS);

  assert.deepEqual(
    { adx: fromForming.adx, er: fromForming.efficiencyRatio },
    { adx: fromSettled.adx, er: fromSettled.efficiencyRatio },
    'a bar that can still change must not decide the regime'
  );
  assert.equal(fromForming.choppy, false, 'and it must not invent a chop verdict either');
});
