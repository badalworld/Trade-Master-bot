import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Every case here runs against an isolated data dir so the persisted autopilot flag cannot leak
// between tests or onto a real deployment's ledger.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-engine-'));
process.env.TRADE_DATA_DIR = dir;

const { loadEngineConfig, engine } = await import('./engine.ts');
const { ledger } = await import('./position-ledger.ts');

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const freshLedger = () => {
  ledger.__reset();
  try {
    fs.rmSync(path.join(dir, 'trade-ledger.json'), { force: true });
  } catch {
    /* ignore */
  }
};

// --------------------------------------------------------------------------- config
test('engine config is inert by default and clamps anything dangerous', () => {
  withEnv({}, () => {
    const c = loadEngineConfig({});
    assert.equal(c.enabled, false, 'a deploy must not start an unattended trading loop by itself');
    assert.equal(c.autoEntry, false, 'guardian-only until explicitly told otherwise');
    assert.equal(c.enforceBrackets, true, 'stop-loss verification is on unless deliberately disabled');
    assert.equal(c.intervalMs, 15000);
    assert.equal(c.leverage, 10);
  });

  const clamped = loadEngineConfig({
    TRADE_ENGINE_ENABLED: 'YES',
    TRADE_ENGINE_AUTO_ENTRY: '1',
    TRADE_ENGINE_INTERVAL_MS: '1',
    TRADE_ENGINE_LEVERAGE: '500',
    TRADE_ENGINE_BASE_MARGIN: '0',
    TRADE_ENGINE_COMPOUNDING_PCT: '9999',
    TRADE_ENGINE_UNPROTECTED_TOLERANCE: '-5',
  });
  assert.equal(clamped.enabled, true);
  assert.equal(clamped.autoEntry, true);
  assert.equal(clamped.intervalMs, 5000, 'a 1ms loop would burn the rate limit and get the IP banned');
  assert.equal(clamped.leverage, 15, 'the env var cannot exceed the strategy band');
  assert.equal(clamped.baseMargin, 2, 'an unusable value falls back to the documented default, it is not clamped to $1');
  assert.equal(clamped.compoundingPercent, 100);
  assert.equal(clamped.unprotectedTolerance, 0, 'negative tolerance clamps to "flatten immediately", never to a bypass');
});

// --------------------------------------------------------------------------- start gating
test('the loop refuses to start without server credentials', () => {
  withEnv({ BINANCE_API_KEY: undefined, BINANCE_API_SECRET: undefined }, () => {
    const r = engine.start();
    assert.equal(r.ok, false);
    assert.match(r.message, /BINANCE_API_KEY/);
  });
});

test('a ledger from the other network blocks the start instead of adopting foreign positions', () => {
  freshLedger();
  ledger.setNetwork('testnet');
  withEnv(
    {
      BINANCE_API_KEY: 'k',
      BINANCE_API_SECRET: 's',
      BINANCE_TESTNET: 'false',
      TRADE_ALLOW_MAINNET: 'true',
    },
    () => {
      const r = engine.start();
      assert.equal(r.ok, false);
      assert.match(r.message, /different account/i);
    }
  );
  freshLedger();
});

// --------------------------------------------------------------------------- autopilot switch
test('arming unattended MAINNET entries requires confirmation', () => {
  freshLedger();
  withEnv({ BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's', BINANCE_TESTNET: 'false', TRADE_ALLOW_MAINNET: 'true' }, () => {
    const refused = engine.setAutoEntry(true);
    assert.equal(refused.ok, false, 'an idle engine must still not be armable without asking');
    assert.equal(refused.requiresConfirm, true);

    const wrongConfirm = engine.setAutoEntry(true, 'yes');
    assert.equal(wrongConfirm.ok, false, 'only the exact confirmation string counts');

    const armed = engine.setAutoEntry(true, 'ENABLE_AUTOPILOT');
    assert.equal(armed.ok, true);
    assert.equal(ledger.getAutopilot().serverEntries, true, 'the switch has to survive the restart');

    // Turning it back off never needs a confirmation.
    assert.equal(engine.setAutoEntry(false).ok, true);
    assert.equal(ledger.getAutopilot().serverEntries, false);
  });
  freshLedger();
});

test('testnet autopilot needs no ceremony, and nothing can be armed without credentials', () => {
  freshLedger();
  withEnv({ BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's', BINANCE_TESTNET: 'true' }, () => {
    assert.equal(engine.setAutoEntry(true).ok, true, 'paper trading should stay one switch');
  });

  freshLedger(); // start from a clean flag so "not persisted" below means something
  withEnv({ BINANCE_API_KEY: undefined, BINANCE_API_SECRET: undefined }, () => {
    assert.equal(ledger.getAutopilot().serverEntries, false);
    const r = engine.setAutoEntry(true);
    assert.equal(r.ok, false);
    assert.match(r.message, /BINANCE_API_KEY/);
    assert.equal(ledger.getAutopilot().serverEntries, false, 'a refused switch must not be persisted');
  });
  freshLedger();
});
