import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Every case here runs against an isolated data dir so the persisted autopilot flag cannot leak
// between tests or onto a real deployment's ledger.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-engine-'));
process.env.TRADE_DATA_DIR = dir;

const { loadEngineConfig, planCycleFailure, engine } = await import('./engine.ts');
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

// --------------------------------------------------------------------------- failing cycles
const binanceError = (message: string, httpStatus: number, code?: number) =>
  Object.assign(new Error(message), { name: 'BinanceApiError', httpStatus, code });

test('the first failed cycle is logged in full: what happened, what to do, and Binance\'s own words', () => {
  const plan = planCycleFailure(
    binanceError("Mandatory parameter 'timestamp' was not sent, was empty/null, or malformed.", 400, -1102),
    { isTestnet: false }
  );

  assert.equal(plan.repeats, 1);
  assert.equal(plan.kind, 'CYCLE_FAILED');
  assert.equal(plan.level, 'ERROR');
  assert.equal(plan.log, true);
  assert.equal(plan.failure.code, 'REQUEST_INVALID');
  assert.match(plan.message, /not a credential problem/, 'the remedy has to be in the log, not just in the UI');
  assert.match(plan.message, /Mandatory parameter 'timestamp'/, 'the raw message stays for bug reports');
  assert.equal(plan.cooldownMs, 0, 'a one-off must not slow the loop down');
});

test('an identical failure repeating does not print once per cycle, but is never forgotten', () => {
  const error = binanceError('Invalid API-key, IP, or permissions for action., request ip: 54.247.26.145', 400, -2015);
  let streak: { code: 'IP_NOT_ALLOWED'; repeats: number } | null = null;
  const lines: string[] = [];

  for (let cycle = 1; cycle <= 40; cycle++) {
    const plan = planCycleFailure(error, { isTestnet: false, previous: streak });
    streak = { code: plan.failure.code as 'IP_NOT_ALLOWED', repeats: plan.repeats };
    if (plan.log) lines.push(`${plan.kind}:${plan.repeats}`);
    assert.equal(plan.repeats, cycle, 'repeats must count consecutive cycles, not log lines');
  }

  // 40 failing cycles produced 3 log lines instead of 40, and the first one is the full diagnosis.
  assert.deepEqual(lines, ['CYCLE_FAILED:1', 'CYCLE_STILL_FAILING:20', 'CYCLE_STILL_FAILING:40']);
});

test('a failure no retry can fix backs off, a transient one keeps the fast cadence', () => {
  const deterministic = binanceError('Invalid API-key, IP, or permissions for action., request ip: 54.247.26.145', 400, -2015);
  assert.equal(planCycleFailure(deterministic, { isTestnet: false }).cooldownMs, 0, 'one bad answer could still be a blip');
  assert.equal(
    planCycleFailure(deterministic, { isTestnet: false, previous: { code: 'IP_NOT_ALLOWED', repeats: 2 } }).cooldownMs,
    120_000,
    'after three identical answers the loop should stop every-15s retries and settle into a slow poll'
  );

  // Engine-down is exactly the case the trading audit exercised (27 failed cycles, no escalation):
  // that cadence must not change, because retrying soon is what fixes it.
  const offline = binanceError('fetch failed', 0);
  assert.equal(planCycleFailure(offline, { isTestnet: false, previous: { code: 'NETWORK_UNREACHABLE', repeats: 500 } }).cooldownMs, 0);
  const rateLimited = binanceError('Too many requests', 429);
  assert.equal(planCycleFailure(rateLimited, { isTestnet: false }).cooldownMs, 60_000, 'keep the existing rate-limit cooldown');
});

test('a different failure restarts the count instead of inheriting the old streak', () => {
  const plan = planCycleFailure(binanceError('fetch failed', 0), {
    isTestnet: false,
    previous: { code: 'INVALID_KEY', repeats: 9 },
  });
  assert.equal(plan.repeats, 1);
  assert.equal(plan.failure.code, 'NETWORK_UNREACHABLE');
  assert.equal(plan.log, true, 'a new failure is news even if the old one had gone quiet');
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

// --------------------------------------------------------------------------- live cycle, real path
test('a cycle Binance rejects ends up in the status as a diagnosis, not a bare string', async () => {
  freshLedger();

  // Exactly the answer that rejected every signed read in production, returned for every request.
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    requests.push(String(input));
    return new Response(
      JSON.stringify({
        code: -1102,
        msg: "Mandatory parameter 'timestamp' was not sent, was empty/null, or malformed.",
      }),
      { status: 400 }
    );
  }) as typeof fetch;

  const env: Record<string, string | undefined> = {
    BINANCE_API_KEY: 'k',
    BINANCE_API_SECRET: 's',
    BINANCE_TESTNET: 'true',
    TRADE_ENGINE_ENABLED: 'true',
    TRADE_ENGINE_INTERVAL_MS: '5000',
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  try {
    const started = engine.start();
    assert.equal(started.ok, true, started.message);

    // The first cycle is scheduled with no delay, so this settles in a few ticks.
    const deadline = Date.now() + 4000;
    while (!engine.getStatus().lastFailure && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    engine.stop('test finished');
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const status = engine.getStatus();
  assert.ok(requests.length > 0, 'the cycle must actually have called the exchange');
  assert.equal(status.lastFailure?.code, 'REQUEST_INVALID');
  assert.match(status.lastFailure?.raw ?? '', /Mandatory parameter 'timestamp'/);
  assert.match(status.lastFailure?.action ?? '', /not a credential problem/);
  assert.equal(status.lastFailure?.repeats, 1);
  assert.match(status.lastError ?? '', /rejected the request/, 'the one-line summary is the diagnosis too');
  assert.ok(
    status.events.some((e) => e.kind === 'CYCLE_FAILED' && /not a credential problem/.test(e.message)),
    'the operator sees the remedy in the event log'
  );
  assert.equal(
    status.events.some((e) => e.kind === 'AUTO_FLATTEN' || e.kind === 'CLOSE_FAILED'),
    false,
    'a rejected API call must never escalate into closing a position'
  );

  freshLedger();
});


// ---------------------------------------------------------------------------------------------
// The ledger that cannot be written (a Cloud Run instance whose /app is read-only, 2026-10-16).
// The failure mode was: one identical EACCES line per save forever, no operator-facing explanation,
// silent automated trading with an in-memory daily-loss counter, and a SIGTERM message claiming the
// ledger had been "flushed to disk".
// ---------------------------------------------------------------------------------------------
test('an unwritable ledger is reported once, blocks entries, and is not claimed as persisted', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ code: -1102, msg: 'rejected' }), { status: 400 });
  }) as typeof fetch;

  const saved: Record<string, string | undefined> = {};
  const set = (k: string, v: string | undefined) => {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  set('TRADE_DATA_DIR', '/dev/null/trade-master');
  set('BINANCE_API_KEY', 'k');
  set('BINANCE_API_SECRET', 's');
  set('BINANCE_TESTNET', 'true');
  set('TRADE_ENGINE_ENABLED', 'true');
  set('TRADE_ENGINE_AUTO_ENTRY', 'true');
  set('TRADE_ENGINE_INTERVAL_MS', '5000');
  set('TRADE_ENGINE_ALLOW_NON_DURABLE_LEDGER', undefined);

  try {
    freshLedger();
    const started = engine.start();
    assert.equal(started.ok, true, started.message);

    const status = engine.getStatus();
    assert.equal(status.ledgerDurable, false, 'the status must not claim persistence that does not happen');
    assert.equal(status.ledgerPath, '/dev/null/trade-master/trade-ledger.json');
    assert.ok(status.ledgerError, 'the OS error is carried in the status, not only in the log');
    assert.equal(status.config.allowNonDurableLedger, false, 'entries are refused unless explicitly overridden');

    const warning = status.events.find((e) => e.kind === 'LEDGER_NOT_DURABLE');
    assert.ok(warning, 'the operator gets an explanation, once');
    assert.match(warning.message, /cannot be written to/);
    assert.match(warning.message, /TRADE_DATA_DIR/, 'with the knob that fixes it');
    assert.match(warning.message, /REFUSED/, 'and the consequence for automated entries');
    assert.equal(
      status.events.filter((e) => e.kind === 'LEDGER_NOT_DURABLE').length,
      1,
      'one explanation, not one per cycle'
    );

    const stopped = engine.stop('test finished');
    assert.equal(stopped.ok, true);
    const stopEvent = engine.getStatus().events.find((e) => e.kind === 'STOPPED');
    assert.match(stopEvent?.message ?? '', /NOT persisted/, 'the stop message tells the truth');
    assert.doesNotMatch(stopEvent?.message ?? '', /flushed to disk/);
  } finally {
    try {
      engine.stop('test cleanup');
    } catch {
      /* already stopped */
    }
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    freshLedger();
  }
});

test('the ephemeral-ledger override is explicit and reachable from env', () => {
  const c = loadEngineConfig({ TRADE_ENGINE_ALLOW_NON_DURABLE_LEDGER: 'true' });
  assert.equal(c.allowNonDurableLedger, true);
  assert.equal(loadEngineConfig({}).allowNonDurableLedger, false, 'off unless asked for');
});
