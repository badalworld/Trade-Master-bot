import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_COOKIE,
  checkRequestIntegrity,
  claimIdempotency,
  clearSessionCookie,
  envCredentials,
  issueSession,
  makeClientOrderId,
  readSessionToken,
  releaseIdempotency,
  resolveCredentials,
  revokeSession,
  sessionStatus,
} from './trade-guard.ts';

const ENV_KEYS = ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'BINANCE_TESTNET'];
function withoutEnvKeys<T>(fn: () => T): T {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of ENV_KEYS) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Credential resolution — the rule that keeps keys out of the browser
// ---------------------------------------------------------------------------

test('env credentials win, and a request that carries none gets NO_SESSION rather than a default', () => {
  const saved = { ...process.env };
  try {
    delete process.env.BINANCE_API_KEY;
    delete process.env.BINANCE_API_SECRET;

    const anonymous = new Request('https://trade.example/api/binance/execute');
    const refused = resolveCredentials(anonymous);
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.code, 'NO_SESSION');
    assert.equal(refused.status, 401);

    // Keys in a request body are not read at all: resolution is env or session cookie only.
    const withBodyKeys = new Request('https://trade.example/api/binance/execute', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'k'.repeat(20), apiSecret: 's'.repeat(20) }),
    });
    assert.equal(resolveCredentials(withBodyKeys).ok, false);
  } finally {
    process.env = saved;
  }
});

test('a session cookie round-trips: issued token resolves, revoked token does not', () => {
  withoutEnvKeys(() => {
    const session = issueSession({ apiKey: 'k'.repeat(20), apiSecret: 's'.repeat(20), isTestnet: true });
    assert.ok(session.cookie.includes(`${SESSION_COOKIE}=${session.token}`));

    const req = new Request('https://trade.example/api/binance/execute', {
      headers: { cookie: session.cookie.split(';')[0]! },
    });
    assert.equal(readSessionToken(req), session.token);
    const resolved = resolveCredentials(req);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.creds.source, 'session');
    assert.equal(resolved.creds.isTestnet, true);

    revokeSession(session.token);
    assert.equal(resolveCredentials(req).ok, false);
  });
});

test('the credential cookie is httpOnly/SameSite=Lax and only Secure when the transport is https', () => {
  const insecure = withoutEnvKeys(() => issueSession({ apiKey: 'k', apiSecret: 's', isTestnet: true }));
  assert.match(insecure.cookie, /HttpOnly/);
  assert.match(insecure.cookie, /SameSite=Lax/);
  // Plain-http local development must still work.
  assert.doesNotMatch(insecure.cookie, /Secure/);

  const secure = withoutEnvKeys(() =>
    issueSession({ apiKey: 'k', apiSecret: 's', isTestnet: true }, { secure: true })
  );
  assert.match(secure.cookie, /; Secure/);

  // The clearing header must match the attributes of the cookie it removes.
  assert.match(clearSessionCookie(false), /Max-Age=0/);
  assert.doesNotMatch(clearSessionCookie(false), /Secure/);
  assert.match(clearSessionCookie(true), /; Secure/);
});

test('envCredentials prefers testnet unless BINANCE_TESTNET is explicitly false', () => {
  const saved = { ...process.env };
  try {
    process.env.BINANCE_API_KEY = 'k'.repeat(20);
    process.env.BINANCE_API_SECRET = 's'.repeat(20);
    delete process.env.BINANCE_TESTNET;
    assert.equal(envCredentials()?.isTestnet, true);

    process.env.BINANCE_TESTNET = 'false';
    assert.equal(envCredentials()?.isTestnet, false);
    assert.equal(sessionStatus(new Request('https://x/')).source, 'env');

    delete process.env.BINANCE_API_SECRET;
    assert.equal(envCredentials(), null);
  } finally {
    process.env = saved;
  }
});

// ---------------------------------------------------------------------------
// CSRF guard
// ---------------------------------------------------------------------------

test('the request-integrity guard rejects missing headers and cross-origin callers', () => {
  const noHeader = new Request('https://trade.example/api/binance/execute', { method: 'POST' });
  assert.equal(checkRequestIntegrity(noHeader).ok, false);

  const crossOrigin = new Request('https://trade.example/api/binance/execute', {
    method: 'POST',
    headers: { 'x-tm-request': '1', origin: 'https://evil.example', host: 'trade.example' },
  });
  const cross = checkRequestIntegrity(crossOrigin);
  assert.equal(cross.ok, false);
  if (!cross.ok) assert.match(cross.error, /Cross-origin/);

  const good = new Request('https://trade.example/api/binance/execute', {
    method: 'POST',
    headers: { 'x-tm-request': '1', origin: 'https://trade.example', host: 'trade.example' },
  });
  assert.equal(checkRequestIntegrity(good).ok, true);

  // A referer is only checked when there is no origin.
  const refererOnly = new Request('https://trade.example/api/binance/execute', {
    method: 'POST',
    headers: { 'x-tm-request': '1', referer: 'https://evil.example/page', host: 'trade.example' },
  });
  assert.equal(checkRequestIntegrity(refererOnly).ok, false);
});

// ---------------------------------------------------------------------------
// Idempotency + client order ids
// ---------------------------------------------------------------------------

test('one idempotency key claims exactly once, and a released key can be reused', () => {
  const key = `k-${Date.now()}`;
  const first = claimIdempotency(key);
  assert.equal(first.claimed, true);
  const second = claimIdempotency(key);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, 'REPLAY');

  releaseIdempotency(key);
  assert.equal(claimIdempotency(key).claimed, true);

  // A missing key never blocks (callers pass one for every real signal).
  assert.equal(claimIdempotency(undefined).claimed, true);
});

test('client order ids are Binance-safe, unique per nonce, and stable for one nonce', () => {
  const a = makeClientOrderId('tm', 'BTCUSDT', 'nonce-1');
  const b = makeClientOrderId('tm', 'BTCUSDT', 'nonce-1');
  const c = makeClientOrderId('tm', 'BTCUSDT', 'nonce-2');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.length <= 36, a);
  assert.match(a, /^tm-BTCUSDT-[0-9a-f]{16}$/);

  // Symbols with characters Binance would reject are stripped, not passed through.
  const weird = makeClientOrderId('tm', '1000PEPE/USDT', 'n');
  assert.match(weird, /^[A-Za-z0-9-]+$/);
});
