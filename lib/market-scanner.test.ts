import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetOpportunityBoardCache,
  buildOpportunityBoard,
  fetchOpportunityBoard,
  isDiscoverableSymbol,
  parseTicker24h,
  peekOpportunityBoard,
} from './market-scanner.ts';

/** A ticker row as Binance sends it: every number is a string. */
const row = (
  symbol: string,
  opts: { last?: number; high?: number; low?: number; open?: number; quoteVolume?: number } = {}
) => {
  const last = opts.last ?? 100;
  return {
    symbol,
    lastPrice: String(last),
    openPrice: String(opts.open ?? last),
    highPrice: String(opts.high ?? last * 1.05),
    lowPrice: String(opts.low ?? last * 0.95),
    quoteVolume: String(opts.quoteVolume ?? 1_000_000_000),
    volume: '1000',
  };
};

const OPTS = { topN: 3, minQuoteVolumeUsdt: 50_000_000, fallbackSymbols: ['BTCUSDT', 'ETHUSDT'] };

// --------------------------------------------------------------------------- filters
test('only tradeable USDT perpetuals make it onto the board', () => {
  assert.equal(isDiscoverableSymbol('BTCUSDT'), true);
  assert.equal(isDiscoverableSymbol('1000PEPEUSDT'), true);
  assert.equal(isDiscoverableSymbol('BTCUSDC'), false, 'not a USDT pair');
  assert.equal(isDiscoverableSymbol('USDCUSDT'), false, 'a stablecoin pair has nothing to trade');
  assert.equal(isDiscoverableSymbol('FDUSDUSDT'), false);
  assert.equal(isDiscoverableSymbol('BTCUSDT_250926'), false, 'quarterly contracts are not traded here');
  assert.equal(isDiscoverableSymbol('ETHBTC'), false, 'not quoted in USDT');
  assert.equal(isDiscoverableSymbol('USDT'), false);
});

test('the ranking is volatility, most first — not volume', () => {
  const rows = parseTicker24h([
    // Biggest turnover, but the calmest tape: must NOT be ranked first.
    row('BTCUSDT', { last: 100, high: 101, low: 99, open: 100, quoteVolume: 9_000_000_000 }),
    row('SOLUSDT', { last: 100, high: 108, low: 92, open: 100, quoteVolume: 1_000_000_000 }),
    row('MEMEUSDT', { last: 100, high: 130, low: 70, open: 80, quoteVolume: 200_000_000 }),
  ]);

  const board = buildOpportunityBoard(rows, OPTS);
  assert.deepEqual(
    board.candidates.map((c) => c.symbol),
    ['MEMEUSDT', 'SOLUSDT', 'BTCUSDT'],
    'the board must be ordered most volatile first'
  );
  assert.deepEqual(board.candidates.map((c) => c.ranking), [1, 2, 3]);
  assert.equal(board.candidates[0].symbol, 'MEMEUSDT');
  assert.ok(board.candidates[0].amplitudePercent > board.candidates[1].amplitudePercent);
});

test('illiquid pairs are excluded, and the board is capped to its size', () => {
  const rows = parseTicker24h([
    row('THINUSDT', { last: 100, high: 200, low: 50, quoteVolume: 1_000_000 }), // wild but $1M/day
    row('AUSDT', { quoteVolume: 900_000_000 }),
    row('BUSDT', { quoteVolume: 800_000_000 }),
    row('CUSDT', { quoteVolume: 700_000_000 }),
    row('DUSDT', { quoteVolume: 600_000_000 }),
  ]);

  const board = buildOpportunityBoard(rows, OPTS);
  assert.equal(board.universeSize, 5);
  assert.equal(board.liquidCount, 4, 'the $1M pair is below the floor');
  assert.equal(board.candidates.length, 4);
  assert.equal(board.board.length, 3, 'topN caps the board');
  assert.ok(!board.symbols.includes('THINUSDT'), 'no illiquid symbol may reach stage 2');
});

test('a quiet market falls back to the discovered universe rather than an empty board', () => {
  const rows = parseTicker24h([row('AUSDT', { quoteVolume: 1_000 }), row('BUSDT', { quoteVolume: 2_000 })]);
  const board = buildOpportunityBoard(rows, OPTS);
  assert.equal(board.liquidCount, 0, 'nothing cleared the floor, and that is reported');
  assert.equal(board.board.length, 2, 'but the scanner is not left with nothing to look at');
});

test('an operator allowlist restricts discovery instead of being widened by it', () => {
  const rows = parseTicker24h([
    row('MEMEUSDT', { high: 300, low: 50 }),
    row('SHIBUSDT', { high: 200, low: 50 }),
    row('BTCUSDT'),
  ]);

  const board = buildOpportunityBoard(rows, { ...OPTS, allowlist: ['btcusdt'] });
  assert.deepEqual(board.symbols, ['BTCUSDT'], 'the allowlist is the universe when it is set');

  // ...and the volatility ranking still applies within it, not across it.
  const twoSymbols = buildOpportunityBoard(rows, { ...OPTS, allowlist: ['BTCUSDT', 'SHIBUSDT'], topN: 5 });
  assert.deepEqual(twoSymbols.symbols, ['SHIBUSDT', 'BTCUSDT']);
});

test('junk rows are ignored rather than ranked', () => {
  const parsed = parseTicker24h([
    { symbol: 'NOUSDT', lastPrice: '0' },
    { symbol: 'BADUSDT', lastPrice: 'not-a-number' },
    { symbol: 'GOODUSDT', lastPrice: '10', openPrice: '10', highPrice: '11', lowPrice: '9', quoteVolume: '5' },
    'nonsense',
  ]);
  assert.deepEqual(parsed.map((r) => r.symbol), ['GOODUSDT']);
  assert.deepEqual(parseTicker24h({ code: -1102 }), [], 'a non-array payload is not a market');
});

// --------------------------------------------------------------------------- fetching + cache
test('one ticker call ranks the market, and the board is reused until its TTL expires', async () => {
  __resetOpportunityBoardCache();
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async (input: unknown) => {
    calls++;
    assert.match(String(input), /\/fapi\/v1\/ticker\/24hr$/, 'discovery must be one market-wide call');
    return new Response(
      JSON.stringify([row('MEMEUSDT', { high: 130, low: 70 }), row('BTCUSDT', { quoteVolume: 9_000_000_000 })]),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    const first = await fetchOpportunityBoard(true, { ...OPTS, ttlMs: 60_000, now: 1_000_000 });
    assert.equal(first.source, 'binance');
    assert.equal(first.candidates[0].symbol, 'MEMEUSDT');

    const cached = await fetchOpportunityBoard(true, { ...OPTS, ttlMs: 60_000, now: 1_030_000 });
    assert.equal(cached.generatedAt, first.generatedAt, 'inside the TTL the board is reused');
    assert.equal(calls, 1, 'a 15s loop must not re-rank the market four times a minute');

    const refreshed = await fetchOpportunityBoard(true, { ...OPTS, ttlMs: 60_000, now: 1_090_000 });
    assert.equal(refreshed.generatedAt, 1_090_000, 'past the TTL the market is ranked again');
    assert.equal(calls, 2);
    assert.equal(peekOpportunityBoard(true)?.candidates.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    __resetOpportunityBoardCache();
  }
});

test('a failing exchange yields the built-in fallback, never an empty universe', async () => {
  __resetOpportunityBoardCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;

  try {
    const board = await fetchOpportunityBoard(true, { ...OPTS, ttlMs: 60_000 });
    assert.equal(board.source, 'fallback');
    assert.match(board.error ?? '', /fetch failed/);
    assert.deepEqual(board.symbols, ['BTCUSDT', 'ETHUSDT'], 'the majors keep the scanner alive');
  } finally {
    globalThis.fetch = originalFetch;
    __resetOpportunityBoardCache();
  }
});

test('a stale board is preferred over a fallback when the exchange blips', async () => {
  __resetOpportunityBoardCache();
  const originalFetch = globalThis.fetch;
  let fail = false;

  globalThis.fetch = (async () => {
    if (fail) throw new TypeError('fetch failed');
    return new Response(JSON.stringify([row('MEMEUSDT', { high: 130, low: 70 })]), { status: 200 });
  }) as typeof fetch;

  try {
    await fetchOpportunityBoard(true, { ...OPTS, ttlMs: 1, now: 1_000 });
    fail = true;
    const stale = await fetchOpportunityBoard(true, { ...OPTS, ttlMs: 1, now: 5_000 });
    assert.equal(stale.source, 'binance', 'the last real ranking beats a list of majors');
    assert.equal(stale.candidates[0].symbol, 'MEMEUSDT');
  } finally {
    globalThis.fetch = originalFetch;
    __resetOpportunityBoardCache();
  }
});
