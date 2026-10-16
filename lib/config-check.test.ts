import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfigCheck, type ConfigCheckInput } from './config-check.ts';
import type { BinanceFailure } from './binance-errors.ts';

const failure = (code: BinanceFailure['code']): BinanceFailure => ({
  code,
  title: `${code} title`,
  action: `${code} action`,
  retryable: false,
  httpStatus: code === 'GEO_BLOCKED' ? 451 : 400,
  binanceCode: null,
});

const reachable = { reachable: true, latencyMs: 120, failure: null };

/** A deployment that is fully correct on testnet; each test perturbs one field. */
function base(over: Partial<ConfigCheckInput> = {}): ConfigCheckInput {
  return {
    operator: { required: true, configured: true, authenticated: true, mode: 'auto' },
    keys: { apiKeyPresent: true, apiSecretPresent: true, testnetRaw: 'true', isTestnet: true },
    credentials: { source: 'env', keyHint: 'abcd…wxyz' },
    verification: { attempted: true, ok: true, failure: null },
    reachability: { testnet: reachable, mainnet: reachable },
    engine: { enabled: true, autoEntry: false, running: true },
    ledger: { durable: true, path: '/data/trade-ledger.json' },
    policy: { halted: false, allowMainnet: false, maxMarginUsdt: 25, maxDailyLossUsdt: 50, maxOpenPositions: 5 },
    ...over,
  };
}

const codes = (r: ReturnType<typeof buildConfigCheck>) => r.issues.map((i) => i.code);

test('a correctly configured testnet deployment is READY with no blockers', () => {
  const r = buildConfigCheck(base());
  assert.equal(r.verdict, 'READY_TESTNET');
  assert.equal(r.targetNetwork, 'testnet');
  assert.equal(r.issues.filter((i) => i.severity === 'blocker').length, 0);
  // Server-side keys + unattended engine + durable ledger + explicit flag = nothing to warn about
  assert.deepEqual(codes(r), []);
});

test('THE operator-reported case: keys set, no operator token => locked, and it says exactly that', () => {
  const r = buildConfigCheck(base({ operator: { required: true, configured: false, authenticated: false, mode: 'auto' } }));
  assert.equal(r.verdict, 'LOCKED_OPERATOR_TOKEN_MISSING');
  const issue = r.issues.find((i) => i.code === 'OPERATOR_TOKEN_MISSING');
  assert.ok(issue, 'OPERATOR_TOKEN_MISSING must be reported');
  assert.equal(issue.severity, 'blocker');
  assert.match(issue.detail, /503/);
  assert.match(issue.action, /TM_OPERATOR_TOKEN/);
  assert.match(issue.action, /openssl rand -hex 32/);
});

test('THE other reported case: BINANCE_TESTNET unset explains the testnet badge', () => {
  const r = buildConfigCheck(base({ keys: { apiKeyPresent: true, apiSecretPresent: true, testnetRaw: null, isTestnet: true } }));
  const issue = r.issues.find((i) => i.code === 'TESTNET_FLAG_UNSET');
  assert.ok(issue, 'an unset BINANCE_TESTNET must be called out');
  assert.equal(issue.severity, 'warning');
  assert.match(issue.title, /TESTNET \(paper funds\)/);
  assert.match(issue.action, /BINANCE_TESTNET=false/);
  // Still a usable deployment: the warning must not block it.
  assert.equal(r.verdict, 'READY_TESTNET');
});

test('a geo-blocked host is a blocker, and the verdict says only relocation fixes it', () => {
  const r = buildConfigCheck(
    base({
      reachability: { testnet: { reachable: false, latencyMs: 140, failure: failure('GEO_BLOCKED') }, mainnet: reachable },
      verification: { attempted: true, ok: false, failure: failure('GEO_BLOCKED') },
    })
  );
  assert.equal(r.verdict, 'GEO_BLOCKED');
  const issue = r.issues.find((i) => i.code === 'GEO_BLOCKED');
  assert.ok(issue);
  assert.equal(issue.severity, 'blocker');
});

test('an unreachable host with env keys never blames the credentials', () => {
  const r = buildConfigCheck(
    base({
      reachability: {
        testnet: { reachable: false, latencyMs: 4000, failure: failure('NETWORK_UNREACHABLE') },
        mainnet: reachable,
      },
      verification: { attempted: true, ok: false, failure: failure('NETWORK_UNREACHABLE') },
    })
  );
  assert.equal(r.verdict, 'BINANCE_UNREACHABLE');
  const issue = r.issues.find((i) => i.code === 'BINANCE_UNREACHABLE');
  assert.ok(issue);
  assert.equal(issue.severity, 'blocker');
  // and the same transport failure must NOT be repeated as a second credential-shaped blocker
  assert.ok(!codes(r).includes('CREDENTIALS_REJECTED'));
  assert.ok(!codes(r).includes('NETWORK_UNREACHABLE'));
  assert.equal(r.issues.filter((i) => i.severity === 'blocker').length, 1);
});

test('a transport failure while the host IS reachable is still reported', () => {
  const r = buildConfigCheck(
    base({ verification: { attempted: true, ok: false, failure: failure('TIMEOUT') } })
  );
  assert.equal(r.verdict, 'BINANCE_UNREACHABLE');
  assert.equal(r.issues.filter((i) => i.severity === 'blocker').length, 1);
});

test('a rejected key is reported with the classifier code and its action', () => {
  const r = buildConfigCheck(
    base({ verification: { attempted: true, ok: false, failure: failure('KEY_NETWORK_MISMATCH') } })
  );
  assert.equal(r.verdict, 'CREDENTIALS_REJECTED');
  const issue = r.issues.find((i) => i.severity === 'blocker');
  assert.ok(issue);
  assert.equal(issue.code, 'KEY_NETWORK_MISMATCH');
  assert.match(issue.action, /KEY_NETWORK_MISMATCH action/);
});

test('no credentials at all is its own verdict, not a key rejection', () => {
  const r = buildConfigCheck(
    base({
      keys: { apiKeyPresent: false, apiSecretPresent: false, testnetRaw: null, isTestnet: true },
      credentials: { source: 'none', keyHint: null },
      verification: { attempted: false, ok: false, failure: null },
    })
  );
  assert.equal(r.verdict, 'NO_CREDENTIALS');
  assert.ok(codes(r).includes('NO_CREDENTIALS'));
});

test('mainnet keys with the mainnet gate still closed are flagged before anything real happens', () => {
  const r = buildConfigCheck(
    base({ keys: { apiKeyPresent: true, apiSecretPresent: true, testnetRaw: 'false', isTestnet: false } })
  );
  assert.equal(r.verdict, 'MAINNET_LOCKED');
  assert.equal(r.targetNetwork, 'mainnet');
  const issue = r.issues.find((i) => i.code === 'MAINNET_LOCKED');
  assert.ok(issue);
  assert.equal(issue.severity, 'warning');
  assert.match(issue.action, /TRADE_ALLOW_MAINNET=true/);
});

test('mainnet with everything enabled is READY_MAINNET, and warns about exactly one thing', () => {
  const r = buildConfigCheck(
    base({
      keys: { apiKeyPresent: true, apiSecretPresent: true, testnetRaw: 'false', isTestnet: false },
      policy: { halted: false, allowMainnet: true, maxMarginUsdt: 25, maxDailyLossUsdt: 50, maxOpenPositions: 5 },
    })
  );
  assert.equal(r.verdict, 'READY_MAINNET');
  assert.deepEqual(codes(r), []);
});

test('operational warnings each surface independently', () => {
  const engineOff = buildConfigCheck(base({ engine: { enabled: false, autoEntry: false, running: false } }));
  assert.ok(codes(engineOff).includes('ENGINE_DISABLED'));

  const engineStalled = buildConfigCheck(base({ engine: { enabled: true, autoEntry: false, running: false } }));
  assert.ok(codes(engineStalled).includes('ENGINE_NOT_RUNNING'));
  assert.ok(!codes(engineStalled).includes('ENGINE_DISABLED'));

  const ephemeral = buildConfigCheck(base({ ledger: { durable: false, path: '/tmp/ledger.json' } }));
  assert.ok(codes(ephemeral).includes('LEDGER_EPHEMERAL'));

  const halted = buildConfigCheck(base({ policy: { halted: true, allowMainnet: false, maxMarginUsdt: 25, maxDailyLossUsdt: 50, maxOpenPositions: 5 } }));
  assert.ok(codes(halted).includes('TRADE_HALTED'));
});

test('browser-session credentials are called out as ephemeral', () => {
  const r = buildConfigCheck(
    base({ credentials: { source: 'session', keyHint: 'abcd…wxyz' }, keys: { apiKeyPresent: false, apiSecretPresent: false, testnetRaw: null, isTestnet: true } })
  );
  const issue = r.issues.find((i) => i.code === 'SESSION_CREDENTIALS_EPHEMERAL');
  assert.ok(issue);
  assert.match(issue.detail, /lost on every restart/);
});

test('only one of the two env keys set is a blocker', () => {
  const r = buildConfigCheck(
    base({
      keys: { apiKeyPresent: true, apiSecretPresent: false, testnetRaw: 'true', isTestnet: true },
      credentials: { source: 'none', keyHint: null },
    })
  );
  assert.ok(codes(r).includes('PARTIAL_ENV_KEYS'));
});
