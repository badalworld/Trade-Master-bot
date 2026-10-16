import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotateSignals,
  isActionableSignal,
  resolveScanUniverse,
  scanUniverse,
  selectBestCandidate,
  selectShortlist,
  summarizeSkips,
} from './market-data.ts';
import { loadRiskPolicy } from './risk-policy.ts';
import { evaluate3IndicatorSignal, type Candle, type SignalEvaluation } from './trading-engine.ts';
import { buildOpportunityBoard, parseTicker24h } from './market-scanner.ts';

/**
 * The scanner is a funnel: market-wide board → shortlist → regime gate → best score. These tests
 * cover the decisions that cost money if they are wrong, using a stubbed exchange so every
 * objection is about the logic rather than about Binance being up.
 */

const BAR_MS = 5 * 60 * 1000;

type Shape = 'trend-up' | 'trend-down' | 'chop' | 'dead' | 'violent';

/**
 * Build klines for a named market shape. These are the five shapes the funnel has to tell apart:
 * two trends it should trade, and three it should refuse.
 */
function klines(shape: Shape, count = 90): unknown[] {
  const now = Date.now();
  const rows: unknown[] = [];
  let price = 100;

  for (let i = 0; i < count; i++) {
    const open = price;
    let close: number;
    let wick: number;
    let volume = 1000;

    switch (shape) {
      case 'trend-up':
        close = open * 1.004;
        wick = open * 0.001;
        break;
      case 'trend-down':
        close = open * 0.996;
        wick = open * 0.001;
        break;
      case 'chop':
        // Oscillates around 100: movement, but no progress (ADX low, ER low).
        close = i % 2 === 0 ? 100.6 : 99.4;
        wick = 0.05;
        break;
      case 'dead':
        close = open * 1.00005;
        wick = open * 0.0002;
        break;
      case 'violent':
        close = open * 1.02;
        wick = open * 0.012;
        break;
    }

    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    const time = now - (count - i) * BAR_MS;
    price = close;
    rows.push([
      time,
      String(open),
      String(high),
      String(low),
      String(close),
      String(volume),
      time + BAR_MS - 1, // closeTime in the past: this candle is settled
      '0',
      1,
      String(volume * 0.6),
      '0',
      '0',
    ]);
  }

  return rows;
}

/** Wire rows -> Candle objects, for the single-pair evaluations below. */
function candlesFor(shape: Shape): Candle[] {
  return (klines(shape) as unknown[][]).map((row) => ({
    time: Number(row[0]),
    open: parseFloat(String(row[1])),
    high: parseFloat(String(row[2])),
    low: parseFloat(String(row[3])),
    close: parseFloat(String(row[4])),
    volume: parseFloat(String(row[5])),
    isClosed: true,
  }));
}

/** Raw `/ticker/24hr` rows exactly as Binance sends them (everything is a string). */
const RAW_TICKER = [
  { symbol: 'GOODUSDT', lastPrice: '100', openPrice: '100', highPrice: '104', lowPrice: '96', quoteVolume: '500000000' },
  { symbol: 'CHOPUSDT', lastPrice: '100', openPrice: '100', highPrice: '101', lowPrice: '99', quoteVolume: '400000000' },
  { symbol: 'WILDUSDT', lastPrice: '100', openPrice: '100', highPrice: '140', lowPrice: '60', quoteVolume: '300000000' },
  { symbol: 'QUIETUSDT', lastPrice: '100', openPrice: '100', highPrice: '100.2', lowPrice: '99.8', quoteVolume: '200000000' },
  { symbol: 'OPENUSDT', lastPrice: '100', openPrice: '100', highPrice: '103', lowPrice: '97', quoteVolume: '100000000' },
];
const TICKER = parseTicker24h(RAW_TICKER);

const SHAPES: Record<string, Shape> = {
  GOODUSDT: 'trend-up',
  CHOPUSDT: 'chop',
  WILDUSDT: 'violent',
  QUIETUSDT: 'dead',
  OPENUSDT: 'trend-up',
};

/** Stub the two endpoints the scan uses: market-wide ranking and per-pair klines. */
function stubExchange(seen: string[]): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    seen.push(url.pathname + url.search);
    if (url.pathname === '/fapi/v1/ticker/24hr') return new Response(JSON.stringify(RAW_TICKER), { status: 200 });
    if (url.pathname === '/fapi/v1/klines') {
      const symbol = url.searchParams.get('symbol') ?? '';
      const shape = SHAPES[symbol];
      if (!shape) return new Response(JSON.stringify({ code: -1121, msg: 'Invalid symbol.' }), { status: 400 });
      return new Response(JSON.stringify(klines(shape)), { status: 200 });
    }
    if (url.pathname === '/fapi/v1/exchangeInfo') {
      // Shaped like Binance's answer: symbols[] with LOT_SIZE / PRICE_FILTER / MIN_NOTIONAL.
      return new Response(
        JSON.stringify({
          symbols: Object.keys(SHAPES).map((symbol) => ({
            symbol,
            quantityPrecision: 3,
            pricePrecision: 3,
            filters: [
              { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
              { filterType: 'PRICE_FILTER', tickSize: '0.001' },
              { filterType: 'MIN_NOTIONAL', notional: '5' },
            ],
          })),
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify([]), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const policy = () =>
  loadRiskPolicy({
    TRADE_DISCOVERY_MIN_QUOTE_VOLUME: '1000000',
    TRADE_SCAN_TOP_N: '12',
    TRADE_MIN_VOLATILITY_PCT: '0.6',
    TRADE_MAX_VOLATILITY_PCT: '4',
  });

// --------------------------------------------------------------------------- universe
test('the scan universe is the market board, most volatile first — not a fixed list', () => {
  const board = buildOpportunityBoard(TICKER, { topN: 10, minQuoteVolumeUsdt: 1, fallbackSymbols: [] });
  const universe = resolveScanUniverse(board, policy());
  assert.deepEqual(universe, ['WILDUSDT', 'GOODUSDT', 'OPENUSDT', 'CHOPUSDT', 'QUIETUSDT']);
});

test('an operator allowlist overrides the discovered universe, and discovery can be turned off', () => {
  const board = buildOpportunityBoard(TICKER, { topN: 10, minQuoteVolumeUsdt: 1, fallbackSymbols: [] });

  const restricted = policy();
  restricted.symbolAllowlist = ['GOODUSDT'];
  assert.deepEqual(resolveScanUniverse(board, restricted), ['GOODUSDT'], 'the explicit list wins');

  const legacy = loadRiskPolicy({ TRADE_DISCOVERY_ENABLED: 'false' });
  const legacyUniverse = resolveScanUniverse(board, legacy);
  assert.ok(legacyUniverse.includes('BTCUSDT'), 'discovery off restores the built-in majors');
  assert.ok(!legacyUniverse.includes('WILDUSDT'), 'and the market ranking no longer widens it');
});

// --------------------------------------------------------------------------- the funnel
test('the funnel deep-scans the top of the board and gates every pair on the regime', async () => {
  const seen: string[] = [];
  const restore = stubExchange(seen);
  const p = policy();

  try {
    const scan = await scanUniverse({ isTestnet: true, policy: p });

    // Stage 1: one market-wide ranking call, then klines only for the shortlist.
    assert.equal(seen.filter((u) => u.startsWith('/fapi/v1/ticker/24hr')).length, 1);
    // The shortlist walks the ranking most-volatile-first but prefers pairs the wide stage-1 proxy
    // says could be inside the band, so the scan does not spend its weight on pairs that will all be
    // refused on arrival (that failure was observed live). The violent pair is not hidden: it is
    // still scanned, last, and reported as refused.
    assert.deepEqual(scan.requestedPairs, ['GOODUSDT', 'OPENUSDT', 'CHOPUSDT', 'QUIETUSDT', 'WILDUSDT']);
    assert.equal(scan.shortlistSkipped, 0, 'every ranked pair fitted this cycle');
    assert.equal(scan.board.source, 'binance');
    assert.equal(scan.board.liquidCount, 5);

    const bySymbol = new Map(scan.signals.map((s) => [s.symbol, s]));

    // A clean uptrend, sane volatility: tradeable, and top-ranked by score.
    const good = bySymbol.get('GOODUSDT');
    assert.equal(good?.scan?.tradeable, true, 'a trending pair in the band must be tradeable');
    assert.equal(good?.regime.choppy, false);

    // Chop: movements with no progress — refused, with the reason recorded.
    const chop = bySymbol.get('CHOPUSDT');
    assert.equal(chop?.scan?.tradeable, false);
    assert.equal(chop?.scan?.skipReason, 'choppy');
    assert.match(chop?.scan?.skipDetail ?? '', /choppy market \(ADX/);

    // Violent: refused on the ceiling.
    const wild = bySymbol.get('WILDUSDT');
    assert.equal(wild?.scan?.skipReason, 'vol-above-ceiling');
    assert.match(wild?.scan?.skipDetail ?? '', /ceiling/);

    // Dead: refused on the floor.
    const quiet = bySymbol.get('QUIETUSDT');
    assert.equal(quiet?.scan?.skipReason, 'vol-below-floor');
    assert.match(quiet?.scan?.skipDetail ?? '', /floor/);

    assert.deepEqual(scan.skipped, { choppy: 1, 'vol-above-ceiling': 1, 'vol-below-floor': 1 });

    // The exchange-filter resolution is the gate both entry paths require an explicit `true` from.
    // It used to receive the whole `{data, usedWeight}` envelope instead of the payload, so it found
    // no symbols at all and marked everything untradeable — automated entries could never happen.
    assert.equal(scan.tradeable.GOODUSDT, true, 'a symbol with exchange filters must be tradeable');
    assert.equal(Object.values(scan.tradeable).filter(Boolean).length, 5);

    // ...and the best tradeable setup is actually selected, which is the whole point of the funnel.
    assert.equal(selectBestCandidate(scan.signals, scan.tradeable)?.symbol, 'GOODUSDT');
  } finally {
    restore();
  }
});

test('volatility rank is a percentile of this scan, and the list arrives best-score-first', async () => {
  const seen: string[] = [];
  const restore = stubExchange(seen);

  try {
    const scan = await scanUniverse({ isTestnet: true, policy: policy() });

    const wild = scan.signals.find((s) => s.symbol === 'WILDUSDT');
    const quiet = scan.signals.find((s) => s.symbol === 'QUIETUSDT');
    assert.equal(wild?.scan?.volatilityRank, 100, 'the most violent pair scanned is rank 100');
    assert.equal(quiet?.scan?.volatilityRank, 0, 'the calmest is rank 0');

    const scores = scan.signals.map((s) => s.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'best score first, volatility only breaking ties');
  } finally {
    restore();
  }
});

test('pairs already open are skipped, and the shortlist stays inside one cycle budget', async () => {
  const seen: string[] = [];
  const restore = stubExchange(seen);

  try {
    const scan = await scanUniverse({ isTestnet: true, policy: policy(), skip: ['CHOPUSDT', 'QUIETUSDT'] });
    assert.equal(scan.tradeable.GOODUSDT, true, 'skipping a pair must not blind the spec resolution');
    assert.ok(!scan.requestedPairs.includes('CHOPUSDT'), 'an open pair is not re-scanned for entry');
    assert.ok(!scan.requestedPairs.includes('QUIETUSDT'));
    assert.ok(scan.requestedPairs.length <= 24, 'the deep-scan stays bounded');
  } finally {
    restore();
  }
});

// --------------------------------------------------------------------------- shortlist
test('the shortlist prefers in-band pairs but never hides the wild end of the market', () => {
  const board = buildOpportunityBoard(TICKER, { topN: 10, minQuoteVolumeUsdt: 1, fallbackSymbols: [] });
  // 24h amplitudes: WILD 80%, GOOD 8%, OPEN 6%, CHOP 2%, QUIET 0.4%
  const shortlist = selectShortlist(board.candidates, { topN: 3, minPercent: 0.6, maxPercent: 4 });

  // Proxy band = 0.2%..12%: GOOD, OPEN, CHOP and QUIET qualify; WILD (80%) does not.
  assert.deepEqual(shortlist.symbols, ['GOODUSDT', 'OPENUSDT', 'CHOPUSDT']);
  assert.equal(shortlist.proxySkipped, 2, 'and the two it could not fit are reported, not silently dropped');

  // With room for everything, the refused-by-proxy pair is still scanned — last.
  const wholeBoard = selectShortlist(board.candidates, { topN: 10, minPercent: 0.6, maxPercent: 4 });
  assert.deepEqual(wholeBoard.symbols, ['GOODUSDT', 'OPENUSDT', 'CHOPUSDT', 'QUIETUSDT', 'WILDUSDT']);
  assert.equal(wholeBoard.proxySkipped, 0);
});

test('the shortlist never returns nothing, even when the whole market is out of band', () => {
  const board = buildOpportunityBoard(TICKER, { topN: 10, minQuoteVolumeUsdt: 1, fallbackSymbols: [] });
  const violentOnly = selectShortlist(board.candidates, { topN: 2, minPercent: 0.01, maxPercent: 0.05 });
  assert.equal(violentOnly.symbols.length, 2, 'a full shortlist is filled from the ranking regardless');
});

// --------------------------------------------------------------------------- selection
const signal = (over: Partial<SignalEvaluation>): SignalEvaluation => ({ ...makeSignal(), ...over });

function makeSignal(): SignalEvaluation {
  return evaluate3IndicatorSignal('GOODUSDT', candlesFor('trend-up'));
}

/** A signal that would pass the score threshold, with the regime verdict attached by the scanner. */
const annotated = (
  symbol: string,
  score: number,
  volatilityPercent: number,
  opts: { tradeable?: boolean; skipReason?: string; signal?: SignalEvaluation['signal']; action?: SignalEvaluation['action'] } = {}
) =>
  signal({
    symbol,
    score,
    signal: opts.signal ?? 'STRONG_BUY',
    action: opts.action ?? 'LONG',
    volatilityPercent,
    volatilityScore: Math.min(99, Math.round(volatilityPercent * 30)),
    scan: {
      volatilityRank: 50,
      volatilityLevel: 'TRADEABLE',
      tradeable: opts.tradeable ?? true,
      skipReason: opts.skipReason as never,
      skipDetail: opts.skipReason,
    },
  });

test('the best score wins — a calmer pair beats a wilder one with a weaker setup', () => {
  const calmBetter = annotated('CALMUSDT', 92, 1.2);
  const wildWeaker = annotated('WILDUSDT', 66, 4.5);

  const picked = selectBestCandidate([wildWeaker, calmBetter], {});
  assert.equal(picked?.symbol, 'CALMUSDT', 'this is the bug that was reported: volatility must not overrule score');
});

test('volatility breaks a tie between equally good setups', () => {
  const picked = selectBestCandidate([annotated('CALMUSDT', 80, 1.2), annotated('WILDUSDT', 80, 3.4)], {});
  assert.equal(picked?.symbol, 'WILDUSDT', 'when the scores match, take the one with more room to move');
});

test('a pair the regime gate refused is never selected, however high it scores', () => {
  const choppy = annotated('CHOPUSDT', 98, 1.8, { tradeable: false, skipReason: 'choppy' });
  assert.equal(selectBestCandidate([choppy], {}), null, 'a 98% score in a chop market is not a trade');
  assert.equal(isActionableSignal(choppy), false, 'and the shared gate agrees with the engine');

  const tooViolent = annotated('WILDUSDT', 97, 9, { tradeable: false, skipReason: 'vol-above-ceiling' });
  assert.equal(selectBestCandidate([tooViolent], {}), null);

  // A pair whose exchange filters could not be resolved is refused as well (fail closed).
  assert.equal(selectBestCandidate([annotated('GOODUSDT', 90, 1.5)], { GOODUSDT: false }), null);
});

test('a neutral or weak signal is not selected even when it is tradeable', () => {
  const weak = annotated('GOODUSDT', 58, 1.5, { signal: 'BUY', action: 'LONG' });
  const neutral = annotated('GOODUSDT', 80, 1.5, { signal: 'NEUTRAL', action: 'HOLD' });
  assert.equal(selectBestCandidate([neutral], {}), null, 'a NEUTRAL reading is not an entry');
  assert.equal(selectBestCandidate([weak], {}), null, 'below the shared entry threshold');
  assert.equal(isActionableSignal(weak), false);
});

test('summarizeSkips banks refusals by reason for honest reporting', () => {
  const summary = summarizeSkips([
    annotated('AUSDT', 70, 1, { tradeable: false, skipReason: 'choppy' }),
    annotated('BUSDT', 70, 1, { tradeable: false, skipReason: 'choppy' }),
    annotated('CUSDT', 70, 1, { tradeable: false, skipReason: 'vol-below-floor' }),
    annotated('DUSDT', 70, 1),
  ]);
  assert.deepEqual(summary, { choppy: 2, 'vol-below-floor': 1 });
});

test('annotation leaves a tradeable pair alone and marks the band it landed in', () => {
  const [low, high] = annotateSignals(
    [annotated('AUSDT', 70, 0.2), annotated('BUSDT', 70, 12)],
    policy()
  );
  assert.equal(low.scan?.volatilityLevel, 'LOW');
  assert.equal(low.scan?.skipReason, 'vol-below-floor');
  assert.equal(high.scan?.volatilityLevel, 'HIGH');
  assert.equal(high.scan?.skipReason, 'vol-above-ceiling');
  assert.equal(low.scan?.volatilityRank, 0);
  assert.equal(high.scan?.volatilityRank, 100);
});
