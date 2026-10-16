/**
 * The opportunity list's rules, pinned.
 *
 * The plan is pure and clock-injected, so each of the operator's requirements can be tested as a
 * sentence: the market scan promotes opportunity assets, the fast scan only ever looks at the list,
 * and a pair that stops qualifying leaves it (and cannot bounce straight back in).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOpportunityVerdicts,
  describeOpportunityChange,
  emptyOpportunityList,
  planOpportunityUniverse,
  proxyVolatilityBand,
  type OpportunityListState,
} from './opportunity-list.ts';
import { parseTicker24h, buildOpportunityBoard } from './market-scanner.ts';

const NOW = 1_700_000_000_000;

/** Raw wire rows: `parseTicker24h` is not idempotent, so stubs must serve strings. */
const RAW = [
  { symbol: 'A1USDT', lastPrice: '100', openPrice: '100', highPrice: '115', lowPrice: '85', quoteVolume: '900000000', volume: '1' },
  { symbol: 'B2USDT', lastPrice: '100', openPrice: '100', highPrice: '110', lowPrice: '90', quoteVolume: '800000000', volume: '1' },
  { symbol: 'C3USDT', lastPrice: '100', openPrice: '100', highPrice: '107', lowPrice: '93', quoteVolume: '700000000', volume: '1' },
  { symbol: 'F6USDT', lastPrice: '100', openPrice: '100', highPrice: '104', lowPrice: '96', quoteVolume: '650000000', volume: '1' },
  { symbol: 'D4USDT', lastPrice: '100', openPrice: '100', highPrice: '103', lowPrice: '97', quoteVolume: '600000000', volume: '1' },
  { symbol: 'G7USDT', lastPrice: '100', openPrice: '100', highPrice: '102.5', lowPrice: '97.5', quoteVolume: '550000000', volume: '1' },
  { symbol: 'E5USDT', lastPrice: '100', openPrice: '100', highPrice: '101', lowPrice: '99', quoteVolume: '500000000', volume: '1' },
  { symbol: 'WILDUSDT', lastPrice: '100', openPrice: '100', highPrice: '190', lowPrice: '10', quoteVolume: '900000000', volume: '1' },
];

// `parseTicker24h` takes the wire payload (an array) and is not idempotent, so the stub serves raw
// strings rather than already-parsed objects.
const board = buildOpportunityBoard(parseTicker24h(RAW), { topN: 40, minQuoteVolumeUsdt: 1, fallbackSymbols: [] });

const baseInput = {
  candidates: board.candidates,
  boardGeneratedAt: NOW,
  allowlist: [] as string[],
  cap: 3,
  minPercent: 0.6,
  maxPercent: 4,
  proxyMultiplier: 3,
  cooldownMs: 300_000,
  now: NOW,
};

function symbolsOf(state: OpportunityListState): string[] {
  return state.entries.map((e) => e.symbol);
}

// ----------------------------------------------------------------------------- promotion

test('the market scan promotes opportunity assets and the fast scan looks only at them', () => {
  const plan = planOpportunityUniverse({ ...baseInput, state: null });

  // 24h ranges: WILD 180%, A1 30%, B2 20%, C3 14%, F6 8%, D4 6%, G7 5%, E5 2%. The screening band is
  // 0.2%..12%, so the ranking promotes most-volatile-first among pairs that could actually be traded:
  // F6 > D4 > G7, not the three wildest names in the market.
  assert.deepEqual(symbolsOf(plan.state), ['F6USDT', 'D4USDT', 'G7USDT']);
  assert.deepEqual(plan.promoted.map((e) => e.symbol), ['F6USDT', 'D4USDT', 'G7USDT']);
  assert.deepEqual(plan.symbols, symbolsOf(plan.state), 'the scanned universe is exactly the list');
  assert.equal(plan.removed.length, 0);
  assert.equal(plan.state.boardGeneratedAt, NOW);
});

test('a pair outside the screening band is never promoted, and the cap is never exceeded', () => {
  const plan = planOpportunityUniverse({ ...baseInput, state: null, cap: 2 });
  assert.equal(plan.state.entries.length, 2);
  assert.deepEqual(plan.symbols, ['F6USDT', 'D4USDT'], 'the two most volatile *tradeable* candidates');
  assert.ok(!plan.symbols.includes('C3USDT'), 'C3 (14% range) is above the screening ceiling');
  assert.ok(!plan.symbols.includes('A1USDT'), 'A1 (30% range) is too violent to screen in');
  assert.ok(!plan.symbols.includes('WILDUSDT'), 'WILD (180% range) is never an opportunity asset');
});

test('the screening band scales with the tradeable band', () => {
  const wide = proxyVolatilityBand(0.6, 4, 3);
  assert.ok(Math.abs(wide.floor - 0.2) < 1e-9, 'floor = band floor / multiplier');
  assert.equal(wide.ceiling, 12, 'ceiling = band ceiling x multiplier');
  assert.deepEqual(proxyVolatilityBand(1, 2, 1), { floor: 1, ceiling: 2 });
});

// ----------------------------------------------------------------------------- removal by the market scan

test('a pair that drops off the ranked board leaves the list immediately', () => {
  const first = planOpportunityUniverse({ ...baseInput, state: null });
  const stillThere = board.candidates.filter((c) => c.symbol !== 'D4USDT');
  const second = planOpportunityUniverse({ ...baseInput, state: first.state, candidates: stillThere });

  const removed = second.removed.find((r) => r.symbol === 'D4USDT');
  assert.ok(removed, 'D4 left the list');
  assert.equal(removed?.reason, 'not-on-board');
  assert.ok(!second.symbols.includes('D4USDT'), 'and is no longer scanned');
  assert.ok(second.promoted.length > 0, 'the freed slot went to the next opportunity');
});

test('a pair the market moved out of the screening band leaves the list, and one inside it stays', () => {
  const first = planOpportunityUniverse({ ...baseInput, state: null });
  // D4's 24h range collapses from 6% to 0.05%: quiet again, not an opportunity.
  const quiet = board.candidates.map((c) => (c.symbol === 'D4USDT' ? { ...c, amplitudePercent: 0.05 } : c));
  const second = planOpportunityUniverse({ ...baseInput, state: first.state, candidates: quiet });

  assert.equal(second.removed.find((r) => r.symbol === 'D4USDT')?.reason, 'vol-below-floor');
  assert.ok(second.symbols.includes('F6USDT'), 'a pair still inside the band keeps its place');
});

test('a full list only swaps a member out for a clearly more volatile one', () => {
  const first = planOpportunityUniverse({ ...baseInput, state: null, cap: 2 });
  const listed = symbolsOf(first.state);
  assert.equal(listed.length, 2);

  // A newcomer that is barely stronger must not cause churn at the boundary.
  const marginal = [
    { ...board.candidates[0], symbol: 'MARGINALUSDT', ranking: 1, rangeVolScore: first.state.entries[1].rangeVolScore * 1.01, amplitudePercent: 5 },
    ...board.candidates.map((c) => ({ ...c, ranking: c.ranking + 1 })),
  ];
  const noChurn = planOpportunityUniverse({ ...baseInput, state: first.state, cap: 2, candidates: marginal });
  assert.ok(!noChurn.symbols.includes('MARGINALUSDT'), 'a 1% edge is not worth a swap');
  assert.deepEqual(noChurn.removed.map((r) => r.symbol), []);

  // A clearly more volatile one takes the weakest slot.
  const strong = [
    { ...board.candidates[0], symbol: 'STRONGUSDT', ranking: 1, rangeVolScore: first.state.entries[1].rangeVolScore * 2, amplitudePercent: 5 },
    ...marginal.slice(1),
  ];
  const displaced = planOpportunityUniverse({ ...baseInput, state: first.state, cap: 2, candidates: strong });
  assert.ok(displaced.symbols.includes('STRONGUSDT'), 'the stronger pair is now an opportunity asset');
  assert.equal(displaced.removed.length, 1);
  assert.equal(displaced.removed[0].reason, 'displaced');
  assert.equal(displaced.state.entries.length, 2, 'the cap still holds');
});

test('a pair held by an open position keeps its place but is not scanned', () => {
  const first = planOpportunityUniverse({ ...baseInput, state: null });
  const second = planOpportunityUniverse({ ...baseInput, state: first.state, hold: ['D4USDT'] });

  assert.ok(symbolsOf(second.state).includes('D4USDT'), 'still on the list');
  assert.ok(!second.symbols.includes('D4USDT'), 'but not scanned while the position is open');
  assert.deepEqual(second.held, ['D4USDT']);
});

test('a shrinking cap trims from the bottom of the ranking, and says so', () => {
  const first = planOpportunityUniverse({ ...baseInput, state: null, cap: 3 });
  const shrunk = planOpportunityUniverse({ ...baseInput, state: first.state, cap: 1 });

  assert.equal(shrunk.state.entries.length, 1);
  assert.equal(shrunk.removed.filter((r) => r.reason === 'over-capacity').length, 2);
});

test('a fallback board (market scan failed) carries the list over instead of wiping it', () => {
  const first = planOpportunityUniverse({ ...baseInput, state: null });
  assert.ok(first.state.entries.length > 0);

  // The built-in majors come back as a placeholder with no volatility readings: if that were read as
  // a ranking, every member would look like it had gone quiet and the list would empty itself over a
  // single failed ticker call.
  const fallback = [
    { symbol: 'BTCUSDT', lastPrice: 0, amplitudePercent: 0, momentumPercent: 0, quoteVolume24h: 0, rangeVolScore: 0, ranking: 1 },
  ];
  const carried = planOpportunityUniverse({
    ...baseInput,
    state: first.state,
    candidates: fallback,
    boardFresh: false,
  });

  assert.deepEqual(symbolsOf(carried.state), symbolsOf(first.state), 'every member is still an opportunity asset');
  assert.deepEqual(carried.symbols, first.symbols, 'and every one is still scanned');
  assert.deepEqual(carried.removed, []);
  assert.deepEqual(carried.promoted, []);
  assert.ok(!carried.symbols.includes('BTCUSDT'), 'a placeholder board never promotes anything');
});

// ----------------------------------------------------------------------------- removal by the deep scan

test('a measured failure strikes the pair, and the strike limit removes it', () => {
  const first = planOpportunityUniverse({ ...baseInput, state: null });
  const target = first.state.entries[0].symbol;

  const strikeOne = applyOpportunityVerdicts({
    state: first.state,
    verdicts: [{ symbol: target, ok: false, reason: 'vol-above-ceiling', detail: 'vol above ceiling (5.1% > 4%)' }],
    strikes: 2,
    cooldownMs: 300_000,
    now: NOW + 15_000,
  });
  assert.equal(strikeOne.removed.length, 0, 'one bad pass is a warning, not an eviction');
  assert.equal(strikeOne.state.entries.find((e) => e.symbol === target)?.strikes, 1);

  const strikeTwo = applyOpportunityVerdicts({
    state: strikeOne.state,
    verdicts: [{ symbol: target, ok: false, reason: 'vol-above-ceiling', detail: 'vol above ceiling (5.2% > 4%)' }],
    strikes: 2,
    cooldownMs: 300_000,
    now: NOW + 30_000,
  });
  assert.equal(strikeTwo.removed.length, 1);
  assert.equal(strikeTwo.removed[0].symbol, target);
  assert.equal(strikeTwo.removed[0].reason, 'vol-above-ceiling');
  assert.ok(!strikeTwo.state.entries.some((e) => e.symbol === target), 'it is no longer an opportunity asset');
  assert.equal(strikeTwo.removed[0].cooldownUntil, NOW + 30_000 + 300_000);
});

test('passing again clears the strike, and an unscanned member is never punished', () => {
  const first = planOpportunityUniverse({ ...baseInput, state: null });
  const [a, b] = first.state.entries.map((e) => e.symbol);

  const struck = applyOpportunityVerdicts({
    state: first.state,
    verdicts: [{ symbol: a, ok: false, reason: 'choppy', detail: 'choppy market (ADX 12.0, ER 0.11)' }],
    strikes: 3,
    cooldownMs: 0,
    now: NOW + 15_000,
  });

  // `b` was not scanned this cycle (open position / weight shield): it keeps strikes 0 and its place.
  const afterGap = applyOpportunityVerdicts({
    state: struck.state,
    verdicts: [],
    strikes: 3,
    cooldownMs: 0,
    now: NOW + 30_000,
  });
  assert.equal(afterGap.state.entries.find((e) => e.symbol === a)?.strikes, 1, 'an unmeasured cycle is not a strike');

  const recovered = applyOpportunityVerdicts({
    state: afterGap.state,
    verdicts: [{ symbol: a, ok: true, volatilityPercent: 1.4 }],
    strikes: 3,
    cooldownMs: 0,
    now: NOW + 45_000,
  });
  const entry = recovered.state.entries.find((e) => e.symbol === a);
  assert.equal(entry?.strikes, 0, 'passing clears the record');
  assert.equal(entry?.volatilityPercent, 1.4, 'and records what was measured');
  assert.ok(recovered.state.entries.some((e) => e.symbol === b));
});

test('a pair with no usable candles collects a strike under its real reason', () => {
  const first = planOpportunityUniverse({ ...baseInput, state: null });
  const target = first.state.entries[0].symbol;
  const applied = applyOpportunityVerdicts({
    state: first.state,
    verdicts: [{ symbol: target, ok: false, reason: 'no-data', detail: 'only 12 candles returned' }],
    strikes: 1,
    cooldownMs: 0,
    now: NOW + 15_000,
  });
  assert.equal(applied.removed[0]?.reason, 'no-data');
  assert.match(applied.removed[0]?.detail ?? '', /only 12 candles/);
});

test('a pair whose exchange filters disappeared is removed at once, not given strikes', () => {
  const first = planOpportunityUniverse({ ...baseInput, state: null });
  const target = first.state.entries[0].symbol;
  const applied = applyOpportunityVerdicts({
    state: first.state,
    verdicts: [{ symbol: target, ok: false, reason: 'filters-unknown', detail: 'exchangeInfo has no filters for this symbol' }],
    strikes: 5,
    cooldownMs: 60_000,
    now: NOW + 1_000,
  });
  assert.deepEqual(applied.removed.map((r) => r.symbol), [target]);
});

// ----------------------------------------------------------------------------- churn control

test('a removed pair cannot bounce back in until its cooldown expires', () => {
  const first = planOpportunityUniverse({ ...baseInput, state: null });
  const target = first.state.entries[0].symbol;

  const removed = applyOpportunityVerdicts({
    state: first.state,
    verdicts: [{ symbol: target, ok: false, reason: 'choppy', detail: 'choppy market (ADX 11.0, ER 0.05)' }],
    strikes: 1,
    cooldownMs: 300_000,
    now: NOW + 15_000,
  });

  // Next market scan a few seconds later: the pair is still inside the screening band, but it just
  // failed, so it stays out.
  const immediate = planOpportunityUniverse({ ...baseInput, state: removed.state, now: NOW + 60_000 });
  assert.ok(!immediate.symbols.includes(target), 'no instant re-promotion');
  assert.equal(immediate.removed.some((r) => r.symbol === target), false);

  // After the cooldown the market scanner may find it again.
  const later = planOpportunityUniverse({ ...baseInput, state: removed.state, now: NOW + 15_000 + 300_001 });
  assert.ok(later.symbols.includes(target), 'the market scan can re-find it afterwards');
});

test('the removal record is bounded and old entries are forgotten', () => {
  let state = planOpportunityUniverse({ ...baseInput, state: null }).state;
  for (let i = 0; i < 120; i++) {
    state = applyOpportunityVerdicts({
      state,
      verdicts: state.entries.map((e) => ({ symbol: e.symbol, ok: false, reason: 'choppy' as const, detail: 'choppy' })),
      strikes: 1,
      cooldownMs: 1_000,
      now: NOW + i * 2_000,
    }).state;
    if (state.entries.length === 0) state = planOpportunityUniverse({ ...baseInput, state, now: NOW + i * 2_000 + 60_000 }).state;
  }
  assert.ok(state.removed.length <= 200, 'the memory does not grow without bound');
});

test('the change description names the pair and the reason', () => {
  assert.equal(
    describeOpportunityChange({ symbol: 'XUSDT', reason: 'choppy', detail: 'choppy market (ADX 12.0, ER 0.11)' }),
    'XUSDT (choppy: choppy market (ADX 12.0, ER 0.11))'
  );
});

test('an empty list is a valid starting point', () => {
  const empty = emptyOpportunityList(NOW);
  assert.deepEqual(symbolsOf(empty), []);
  const plan = planOpportunityUniverse({ ...baseInput, state: empty });
  assert.ok(plan.symbols.length > 0, 'the first market scan fills it');
});
