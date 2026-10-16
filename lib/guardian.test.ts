import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyExit,
  detectBreach,
  evaluateEntryGate,
  findProtectiveStop,
  planBracketEnforcement,
  type GuardedPosition,
} from './guardian.ts';
import type { ConditionalOrder } from './binance-client.ts';

const order = (over: Partial<ConditionalOrder>): ConditionalOrder => ({
  orderId: 1,
  symbol: 'BTCUSDT',
  type: 'STOP_MARKET',
  side: 'SELL',
  stopPrice: 100,
  status: 'NEW', // how Binance reports a working conditional order on openOrders
  ...over,
});

const pos = (over: Partial<GuardedPosition> = {}): GuardedPosition => ({
  symbol: 'BTCUSDT',
  side: 'LONG',
  stopLoss: 99,
  takeProfit: 105,
  markPrice: 100,
  entryPrice: 100,
  ...over,
});

// ---------------------------------------------------------------------------
// Is a protective stop actually on the book?
// ---------------------------------------------------------------------------

test('a LONG is only protected by a SELL stop; a BUY stop or a TP order does not count', () => {
  const orders = [
    order({ side: 'BUY', type: 'STOP_MARKET' }),
    order({ side: 'SELL', type: 'TAKE_PROFIT_MARKET' }),
  ];
  assert.equal(findProtectiveStop(orders, 'LONG'), undefined);
  assert.equal(findProtectiveStop([order({ side: 'SELL', type: 'STOP_MARKET' })], 'LONG')?.type, 'STOP_MARKET');
  // A SHORT is closed by buying.
  assert.ok(findProtectiveStop([order({ side: 'BUY', type: 'STOP_MARKET' })], 'SHORT'));
});

test('a terminal-status order is not protection, and a working one is', () => {
  assert.equal(findProtectiveStop([order({ status: 'EXPIRED' })], 'LONG'), undefined);
  assert.equal(findProtectiveStop([order({ status: 'FILLED' })], 'LONG'), undefined);
  assert.ok(findProtectiveStop([order({ status: 'NEW' })], 'LONG'), 'NEW must count, or the guardian double-arms stops');
  assert.ok(findProtectiveStop([order({ status: 'PARTIALLY_FILLED' })], 'LONG'));
});

// ---------------------------------------------------------------------------
// planBracketEnforcement — the decision that runs when nobody is watching
// ---------------------------------------------------------------------------

test('enforcement disabled => never touches the position', () => {
  const plan = planBracketEnforcement(pos(), [], { enforceBrackets: false, unprotectedTolerance: 2 });
  assert.deepEqual(plan, { kind: 'SKIP', reason: 'enforcement-disabled' });
});

test('a position the engine never set a stop level for is never given an invented one', () => {
  const plan = planBracketEnforcement(pos({ stopLoss: 0 }), [], { enforceBrackets: true, unprotectedTolerance: 2 });
  assert.deepEqual(plan, { kind: 'SKIP', reason: 'no-stop-level-known' });
});

test('missing stop => re-arm attempt, escalating to flatten after the tolerance', () => {
  const cfg = { enforceBrackets: true, unprotectedTolerance: 2 };
  assert.equal(planBracketEnforcement(pos(), [], cfg).kind, 'REARM_STOP');
  assert.equal(planBracketEnforcement(pos({ unprotectedCycles: 1 }), [], cfg).kind, 'REARM_STOP');
  assert.equal(planBracketEnforcement(pos({ unprotectedCycles: 2 }), [], cfg).kind, 'FLATTEN');
  // tolerance 0 means a single failed cycle with no stop is already unacceptable
  assert.equal(planBracketEnforcement(pos(), [], { enforceBrackets: true, unprotectedTolerance: 0 }).kind, 'FLATTEN');
});

test('a stop moved on the exchange is adopted, not fought', () => {
  const plan = planBracketEnforcement(pos({ stopLoss: 99 }), [order({ side: 'SELL', stopPrice: 97.5, orderId: 42 })], {
    enforceBrackets: true,
    unprotectedTolerance: 2,
  });
  assert.equal(plan.kind, 'ADOPT_EXCHANGE_STOP');
  if (plan.kind !== 'ADOPT_EXCHANGE_STOP') return;
  assert.equal(plan.stopPrice, 97.5);
  assert.equal(plan.orderId, 42);
});

test('sub-0.1% difference is treated as tick rounding, not a manual edit', () => {
  const plan = planBracketEnforcement(pos({ stopLoss: 99 }), [order({ side: 'SELL', stopPrice: 98.999 })], {
    enforceBrackets: true,
    unprotectedTolerance: 2,
  });
  assert.equal(plan.kind, 'NONE');
});

// ---------------------------------------------------------------------------
// Breach detection
// ---------------------------------------------------------------------------

test('breach detection is directional and ignores unknown brackets', () => {
  assert.equal(detectBreach(pos({ markPrice: 100 }), 98.5), 'STOP_LOSS');
  assert.equal(detectBreach(pos(), 105.2), 'TAKE_PROFIT');
  assert.equal(detectBreach(pos(), 101), null);
  // A SHORT's brackets sit the other way round: stop above entry, target below.
  const short = pos({ side: 'SHORT', stopLoss: 101, takeProfit: 95 });
  assert.equal(detectBreach(short, 100.5), null);
  assert.equal(detectBreach(short, 101.2), 'STOP_LOSS');
  assert.equal(detectBreach(short, 95), 'TAKE_PROFIT');
  assert.equal(detectBreach(short, 94.9), 'TAKE_PROFIT');
  assert.equal(detectBreach(pos({ stopLoss: 0, takeProfit: 0 }), 1), null, 'no bracket => no local trigger');
  assert.equal(detectBreach(pos(), Number.NaN), null);
});

test('classifyExit labels a vanished position without inventing precision', () => {
  assert.equal(classifyExit(pos({ markPrice: 105.4 }), 105.4), 'TAKE_PROFIT');
  assert.equal(classifyExit(pos({ markPrice: 98 }), 98), 'STOP_LOSS');
  assert.equal(classifyExit(pos({ takeProfit: 0, stopLoss: 0 }), 98), 'MANUAL_CLOSE');
  assert.equal(classifyExit(pos({ markPrice: 0 }), 0), 'MANUAL_CLOSE');
});

// ---------------------------------------------------------------------------
// Entry gate — one place decides whether the loop may open anything
// ---------------------------------------------------------------------------

const open = {
  autoEntry: true,
  haltedByOperator: false,
  haltedByPolicy: false,
  canTrade: true,
  dailyLossLocked: false,
  openOwned: 0,
  maxOpenPositions: 5,
};

test('auto-entry is OFF by default, so the engine is a guardian rather than an autonomous trader', () => {
  const gate = evaluateEntryGate({ ...open, autoEntry: false });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /guardian-only mode/);
});

test('a ledger that cannot be persisted blocks automated entries unless explicitly overridden', () => {
  // The deployment this was written for: Cloud Run with a read-only /app, so every write failed and
  // the daily-loss memory, the compounding ladder and the record of which positions are ours would
  // all reset on the next restart. Opening a leveraged position under those conditions is not
  // something the bot should decide to do on its own.
  const blocked = evaluateEntryGate({ ...open, ledgerDurable: false });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /ledger is not writable/);
  assert.match(blocked.reason, /TRADE_ENGINE_ALLOW_NON_DURABLE_LEDGER=true/, 'the override is named');

  // The operator can still choose an ephemeral ledger explicitly.
  const overridden = evaluateEntryGate({ ...open, ledgerDurable: false, allowNonDurableLedger: true });
  assert.equal(overridden.allowed, true);

  // And a durable ledger is not affected by the flag either way.
  assert.equal(evaluateEntryGate({ ...open, ledgerDurable: true }).allowed, true);
  assert.equal(evaluateEntryGate({ ...open, ledgerDurable: true, allowNonDurableLedger: true }).allowed, true);
});

test('guardian-only mode and the ledger gate are independent', () => {
  // With auto-entry off there is nothing to refuse; the durability gate only matters for entries.
  const guardian = evaluateEntryGate({ ...open, autoEntry: false, ledgerDurable: false });
  assert.equal(guardian.allowed, false);
  assert.match(guardian.reason, /guardian-only mode/);
});

test('every halt condition blocks entries independently', () => {
  for (const [key, expected] of [
    ['haltedByOperator', /operator/],
    ['haltedByPolicy', /TRADE_HALT/],
    ['canTrade', /canTrade/],
    ['dailyLossLocked', /daily loss/],
  ] as const) {
    const gate = evaluateEntryGate({ ...open, [key]: key === 'canTrade' ? false : true });
    assert.equal(gate.allowed, false, key);
    assert.match(gate.reason, expected, key);
  }
});

test('the position cap blocks entries at the limit, not above it', () => {
  assert.equal(evaluateEntryGate({ ...open, openOwned: 4 }).allowed, true);
  const gate = evaluateEntryGate({ ...open, openOwned: 5 });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /5\/5/);
});
