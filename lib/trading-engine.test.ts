import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateNextTradeMargin,
  canOpenNewTrade,
  checkRateLimit,
  calculateHVNProfile,
  calculateHeavyAbsorption,
  calculateImbalanceLevels,
  evaluate3IndicatorSignal,
  type CompoundingState,
  type Candle,
} from './trading-engine.ts';

function generateTestCandles(count: number, basePrice: number, scenario: 'HVN_BULL' | 'ABSORPTION' | 'IMBALANCE'): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    const time = now - (count - i) * 5 * 60 * 1000;
    const open = price;
    let high = open + 0.5;
    let low = open - 0.5;
    let close = open + 0.2;
    let volume = 1000;

    if (scenario === 'ABSORPTION' && i === count - 1) {
      // Create lower wick with heavy volume for Bullish Absorption
      low = open - 2.5;
      close = open + 0.1;
      volume = 8000; // heavy volume surge
    } else if (scenario === 'IMBALANCE' && i === count - 1) {
      // High volume upward surge creating 3:1 buying imbalance
      close = open + 2.0;
      high = close + 0.2;
      volume = 5000;
    } else {
      price += (Math.random() - 0.48) * 0.4;
    }

    candles.push({ time, open, high, low, close, volume });
  }

  return candles;
}

test('Indicator 1 - HVN Profile: Calculates Point of Control & High Volume Nodes', () => {
  const candles = generateTestCandles(30, 100, 'HVN_BULL');
  const profile = calculateHVNProfile(candles, 12);

  assert.ok(profile.pocPrice > 0, 'POC Price must be positive');
  assert.ok(profile.nodes.length > 0, 'Nodes must be populated');
  assert.ok(profile.valueAreaHigh >= profile.valueAreaLow, 'VAH must be >= VAL');
});

test('Indicator 2 - Heavy Absorption: Detects Order Flow Absorption on heavy volume wicks', () => {
  const candles = generateTestCandles(30, 100, 'ABSORPTION');
  const absorption = calculateHeavyAbsorption(candles);

  assert.equal(absorption.isAbsorptionDetected, true);
  assert.equal(absorption.type, 'BULLISH_ABSORPTION');
  assert.ok(absorption.absorptionScore >= 50);
});

test('Indicator 3 - Imbalance Levels: Identifies 3:1 Stacked Buying/Selling Imbalance', () => {
  const candles = generateTestCandles(30, 100, 'IMBALANCE');
  const imbalance = calculateImbalanceLevels(candles, 2.5);

  assert.equal(imbalance.isImbalanceDetected, true);
  assert.equal(imbalance.type, 'BUY_IMBALANCE');
  assert.ok(imbalance.stackedImbalanceCount >= 2);
  assert.ok(imbalance.maxImbalanceRatio >= 2.5);
});

test('3-Indicator Signal Engine: Evaluates HVN + Absorption + Imbalances with TP/SL targets', () => {
  const candles = generateTestCandles(30, 100, 'ABSORPTION');
  const signal = evaluate3IndicatorSignal('BTCUSDT', candles);

  assert.equal(signal.symbol, 'BTCUSDT');
  assert.ok(['STRONG_BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG_SELL'].includes(signal.signal));
  assert.ok(signal.tpPrice > 0);
  assert.ok(signal.slPrice > 0);
  assert.ok(signal.reasons.length > 0);
});

test('Compounding Engine: Adds 20% of profit to next trade margin on win, resets on loss', () => {
  const state: CompoundingState = {
    baseMargin: 2.0,
    currentMargin: 2.0,
    lastProfit: 0,
    compoundingPercent: 20,
    consecutiveWins: 0,
    totalCompoundedProfitPool: 0,
  };

  // Win $2.00 profit -> +0.40 bonus
  const winResult = calculateNextTradeMargin(state, { isWin: true, profit: 2.0 });
  assert.equal(winResult.nextMargin, 2.4);
  assert.equal(winResult.bonusAdded, 0.4);

  // Loss -> Reset to base $2.00
  const lossResult = calculateNextTradeMargin(winResult.newState, { isWin: false, profit: -1.0 });
  assert.equal(lossResult.nextMargin, 2.0);
  assert.equal(lossResult.bonusAdded, 0);
});

test('Position Constraints & Rate Limit Shield: Enforces 5 positions and 95% threshold', () => {
  assert.equal(canOpenNewTrade(4, 5).allowed, true);
  assert.equal(canOpenNewTrade(5, 5).allowed, false);

  const safeRate = checkRateLimit(1000, 1200);
  assert.equal(safeRate.isSafe, true);

  const dangerRate = checkRateLimit(1150, 1200);
  assert.equal(dangerRate.isThrottled, true);
});
