import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ledger-'));
process.env.TRADE_DATA_DIR = dir;

const { ledger, utcDay } = await import('./position-ledger.ts');
import type { TradePosition } from './trading-engine.ts';
import type { EnginePositionMeta } from './position-ledger.ts';

function position(over: Partial<TradePosition & EnginePositionMeta> = {}): TradePosition & EnginePositionMeta {
  return {
    id: '1',
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 100,
    markPrice: 100,
    margin: 20,
    leverage: 10,
    quantity: 2,
    stopLoss: 98,
    takeProfit: 104,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    entryTime: Date.now(),
    ...over,
  } as TradePosition & EnginePositionMeta;
}

function fresh(): void {
  try {
    fs.rmSync(path.join(dir, 'trade-ledger.json'), { force: true });
  } catch {
    /* ignore */
  }
  ledger.__reset();
}

test('a win compounds 20% of profit onto the next margin; a loss resets to base', () => {
  fresh();
  ledger.upsert(position());
  const win = ledger.recordClose({
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 100,
    exitPrice: 104,
    margin: 20,
    leverage: 10,
    entryTime: Date.now() - 60_000,
    exitTime: Date.now(),
    reason: 'TAKE_PROFIT',
    netPnlUsdt: 6,
  });
  assert.equal(win.trade.isWin, true);
  assert.equal(win.trade.pnl, 6);
  // calculateNextTradeMargin seeds a fresh streak from baseMargin, not from the trade's own margin:
  // 2.00 base + 20% x $6 profit = 3.20. (Pinned by the existing engine test; asserted here so the
  // ledger cannot silently change that rule underneath it.)
  assert.equal(win.nextMargin, 3.2);
  assert.equal(ledger.snapshot().compounding.consecutiveWins, 1);
  assert.equal(ledger.openCount(), 0, 'closing must remove the open position');

  ledger.upsert(position({ symbol: 'ETHUSDT' }));
  const loss = ledger.recordClose({
    symbol: 'ETHUSDT',
    side: 'LONG',
    entryPrice: 100,
    exitPrice: 98,
    margin: 21.2,
    leverage: 10,
    entryTime: Date.now() - 60_000,
    exitTime: Date.now(),
    reason: 'STOP_LOSS',
    netPnlUsdt: -3,
  });
  assert.equal(loss.trade.isWin, false);
  assert.equal(loss.nextMargin, 2, 'a losing trade resets the ladder to base margin');
  assert.equal(ledger.snapshot().compounding.currentMargin, 2);
  assert.equal(ledger.snapshot().compounding.consecutiveWins, 0);
});

test('realized PnL for the UTC day is accumulated and drives the loss breaker figure', () => {
  fresh();
  ledger.upsert(position());
  ledger.recordClose({
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 100,
    exitPrice: 96,
    margin: 20,
    leverage: 10,
    entryTime: Date.now(),
    exitTime: Date.now(),
    reason: 'STOP_LOSS',
    netPnlUsdt: -8,
  });
  assert.equal(ledger.snapshot().realizedPnlTodayUsdt, -8);

  // A day stamped in the past must not carry its total forward.
  ledger.setRealizedPnlToday(-8);
  const s = ledger.snapshot();
  ledger.__reset({ ...s, pnlDay: '2000-01-01' });
  ledger.setRealizedPnlToday(-8);
  assert.equal(ledger.snapshot().pnlDay, utcDay(Date.now()));
  assert.equal(ledger.snapshot().realizedPnlTodayUsdt, -8, 'reset then re-applied from exchange truth, never summed onto a stale day');
});

test('setRealizedPnlToday ignores non-finite values so a Binance outage cannot zero the breaker', () => {
  fresh();
  ledger.setRealizedPnlToday(-40);
  ledger.setRealizedPnlToday(Number.NaN);
  assert.equal(ledger.snapshot().realizedPnlTodayUsdt, -40);
});

test('the ledger survives a restart via atomic write, and adopts the persisted network stamp', () => {
  fresh();
  ledger.setNetwork('testnet');
  ledger.upsert(position({ id: 'pos-9', symbol: 'SOLUSDT' }));
  ledger.flush();

  ledger.__reload();
  assert.equal(ledger.get('SOLUSDT')?.id, 'pos-9', 'positions must survive the process');
  assert.equal(ledger.getNetwork(), 'testnet');
});

test('a corrupted ledger file is ignored rather than crashing the guardian loop', () => {
  fresh();
  fs.writeFileSync(path.join(dir, 'trade-ledger.json'), '{ this is not json', 'utf8');
  ledger.__reload();
  assert.equal(ledger.openCount(), 0);
  assert.equal(ledger.snapshot().compounding.baseMargin, 2);
});

test('patches merge without dropping engine metadata', () => {
  fresh();
  ledger.upsert(position({ slOrderId: 111, unprotectedCycles: 1, foreign: false }));
  ledger.patch('BTCUSDT', { markPrice: 103, unprotectedCycles: 0 });
  const p = ledger.get('BTCUSDT');
  assert.equal(p?.markPrice, 103);
  assert.equal(p?.slOrderId, 111);
  assert.equal(p?.unprotectedCycles, 0);
  // Unknown symbols are ignored, never created by a patch.
  ledger.patch('NOPEUSDT', { markPrice: 1 });
  assert.equal(ledger.get('NOPEUSDT'), undefined);
});

test('the autopilot switch survives a restart, and defaults to off', () => {
  fresh();
  assert.deepEqual(ledger.getAutopilot(), { serverEntries: false }, 'a fresh ledger must not trade unattended by accident');

  ledger.setAutopilot({ serverEntries: true });
  ledger.flush();
  ledger.__reload();
  assert.equal(ledger.getAutopilot().serverEntries, true, 'automation that resets on deploy is not automation');

  ledger.setAutopilot({ serverEntries: false });
  ledger.flush();
  ledger.__reload();
  assert.equal(ledger.getAutopilot().serverEntries, false);
});

test('a ledger file predating the autopilot field still loads', () => {
  fresh();
  fs.writeFileSync(
    path.join(dir, 'trade-ledger.json'),
    JSON.stringify({ version: 1, network: 'testnet', positions: {}, closedTrades: [] }),
    'utf8'
  );
  ledger.__reload();
  assert.deepEqual(ledger.getAutopilot(), { serverEntries: false });
});

test('isDurable reports the truth about the mount', () => {
  fresh();
  assert.equal(ledger.isDurable(), true);
  process.env.TRADE_DATA_DIR = path.join(dir, 'nope', 'deeper', 'nope');
  fs.mkdirSync(dir + '/blocked-parent', { recursive: true });
  const blocked = path.join(dir, 'blocked-parent');
  const previous = process.env.TRADE_DATA_DIR;
  process.env.TRADE_DATA_DIR = blocked;
  assert.equal(ledger.isDurable(), true);
  process.env.TRADE_DATA_DIR = previous;
  fs.rmSync(blocked, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------------------------
// Persistence health. Production showed one identical `[ledger] persist failed: EACCES` line per
// save (every ~15s, forever) on a Cloud Run instance whose /app is read-only, and a SIGTERM message
// claiming the ledger had been "flushed to disk" when nothing had been written at all.
// ---------------------------------------------------------------------------------------------

test('a writable data dir reports durable, with no error', () => {
  process.env.TRADE_DATA_DIR = dir;
  const health = ledger.persistence();
  assert.equal(health.durable, true);
  assert.equal(health.error, null);
  assert.equal(health.failures, 0);
  assert.match(health.path, /trade-ledger\.json$/);
});

test('an unwritable data dir is reported as not durable, with the OS error and a failure count', () => {
  // A read-only location that cannot be created by anyone (a file, not a directory, in the path).
  process.env.TRADE_DATA_DIR = '/dev/null/trade-master';
  try {
    ledger.__reset();
    ledger.upsert(position());
    ledger.flush();

    const health = ledger.persistence();
    assert.equal(health.durable, false, 'a read-only path is never durable');
    assert.ok(health.error, 'the OS error is kept, not just printed once');
    assert.ok(health.failures >= 1, 'failures are counted so the status can show a rate');
    assert.ok(health.lastFailureAt && health.lastFailureAt > 0);

    // The write failure must not take the process down: the in-memory ledger stays authoritative.
    assert.equal(ledger.list().length, 1, 'the position is still tracked in memory');
  } finally {
    process.env.TRADE_DATA_DIR = dir;
    ledger.__reset();
  }
});
