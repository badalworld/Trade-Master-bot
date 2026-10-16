import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPERATOR_COOKIE,
  __resetOperatorLoginState,
  clearOperatorCookieHeader,
  clearOperatorLoginFailures,
  mintOperatorSession,
  operatorAuthRequired,
  operatorCookieHeader,
  operatorLoginLockRemainingMs,
  operatorStatusFromRequest,
  operatorTokenConfigured,
  operatorTokenMatches,
  recordOperatorLoginFailure,
  requireOperator,
  signOperatorSession,
  verifyOperatorSession,
} from './operator-auth.ts';

const TOKEN = 'a'.repeat(48);

const withCookie = (value?: string) =>
  new Request('https://trade.example/api/binance/execute', {
    method: 'POST',
    headers: value ? { cookie: `${OPERATOR_COOKIE}=${value}` } : {},
  });

// ---------------------------------------------------------------------------
// When is an operator session required?
// ---------------------------------------------------------------------------

test('auth is required by default exactly when server-side Binance keys exist', () => {
  const serverKeys = { BINANCE_API_KEY: 'k'.repeat(20), BINANCE_API_SECRET: 's'.repeat(20) };
  assert.equal(operatorAuthRequired(serverKeys), true);
  // Browser-key deployments have no anonymously reachable order path until a session cookie exists.
  assert.equal(operatorAuthRequired({}), false);
  // Explicit modes win over the heuristic.
  assert.equal(operatorAuthRequired({ ...serverKeys, TM_OPERATOR_AUTH: 'off' }), false);
  assert.equal(operatorAuthRequired({ TM_OPERATOR_AUTH: 'on' }), true);
  // A half-configured pair is not "server keys present".
  assert.equal(operatorAuthRequired({ BINANCE_API_KEY: 'k'.repeat(20) }), false);
});

test('a token shorter than 16 characters is not a configured token', () => {
  assert.equal(operatorTokenConfigured({ TM_OPERATOR_TOKEN: 'short' }), false);
  assert.equal(operatorTokenConfigured({ TM_OPERATOR_TOKEN: TOKEN }), true);
});

// ---------------------------------------------------------------------------
// Fail-closed gate
// ---------------------------------------------------------------------------

test('regression (round 2): server keys without an operator token lock every money route', () => {
  const env = { BINANCE_API_KEY: 'k'.repeat(20), BINANCE_API_SECRET: 's'.repeat(20) };
  const result = requireOperator(withCookie(), env);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'OPERATOR_AUTH_NOT_CONFIGURED');
  assert.equal(result.httpStatus, 503);
});

test('regression (round 2): a request with no operator cookie is refused, not executed', () => {
  const env = { BINANCE_API_KEY: 'k'.repeat(20), BINANCE_API_SECRET: 's'.repeat(20), TM_OPERATOR_TOKEN: TOKEN };
  const result = requireOperator(withCookie(), env);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'OPERATOR_AUTH_REQUIRED');
  assert.equal(result.httpStatus, 401);
});

test('a signed operator cookie unlocks the route, and only for that token', () => {
  const env = { BINANCE_API_KEY: 'k'.repeat(20), BINANCE_API_SECRET: 's'.repeat(20), TM_OPERATOR_TOKEN: TOKEN };
  const session = mintOperatorSession(TOKEN);

  const ok = requireOperator(withCookie(session.value), env);
  assert.equal(ok.ok, true);

  // Rotating TM_OPERATOR_TOKEN invalidates every cookie minted with the old one.
  const rotated = { ...env, TM_OPERATOR_TOKEN: 'b'.repeat(48) };
  const stale = requireOperator(withCookie(session.value), rotated);
  assert.equal(stale.ok, false);
});

test('deployments that need no operator session are untouched by the gate', () => {
  const result = requireOperator(withCookie(), {});
  assert.equal(result.ok, true);
  const status = operatorStatusFromRequest(withCookie(), {});
  assert.equal(status.required, false);
  assert.equal(status.authenticated, true);
});

// ---------------------------------------------------------------------------
// Cookie integrity
// ---------------------------------------------------------------------------

test('operator session cookies are tamper-evident and expire', () => {
  const session = mintOperatorSession(TOKEN, 1_000_000);
  assert.equal(verifyOperatorSession(session.value, TOKEN, 1_000_001), true);

  // Expired.
  assert.equal(verifyOperatorSession(session.value, TOKEN, session.expiresAt + 1), false);

  // Tampered expiry (the signature no longer matches) — the classic way to fake a long session.
  const parts = session.value.split('.');
  const forged = `v1.${Number(parts[1]) + 86_400_000}.${parts[2]}`;
  assert.equal(verifyOperatorSession(forged, TOKEN, 1_000_001), false);

  // Tampered signature, wrong token, malformed values.
  assert.equal(verifyOperatorSession(`${session.value}0`, TOKEN, 1_000_001), false);
  assert.equal(verifyOperatorSession(session.value, 'other-token', 1_000_001), false);
  assert.equal(verifyOperatorSession('garbage', TOKEN, 1_000_001), false);
  assert.equal(verifyOperatorSession(undefined, TOKEN, 1_000_001), false);
  assert.equal(verifyOperatorSession(signOperatorSession(1_000_000, TOKEN), '', 1_000_001), false);
});

test('cookies are httpOnly, SameSite=Lax, and Secure on https only', () => {
  const secure = operatorCookieHeader('v', 60, true);
  assert.match(secure, /HttpOnly/);
  assert.match(secure, /SameSite=Lax/);
  assert.match(secure, /Secure/);
  const insecure = operatorCookieHeader('v', 60, false);
  assert.doesNotMatch(insecure, /Secure/);
  assert.match(clearOperatorCookieHeader(true), /Max-Age=0/);
});

test('token comparison rejects empty values and accepts the exact token', () => {
  assert.equal(operatorTokenMatches(TOKEN, TOKEN), true);
  assert.equal(operatorTokenMatches('', TOKEN), false);
  assert.equal(operatorTokenMatches(TOKEN, ''), false);
  assert.equal(operatorTokenMatches(`${TOKEN}x`, TOKEN), false);
});

// ---------------------------------------------------------------------------
// Login throttling
// ---------------------------------------------------------------------------

test('repeated failed sign-ins lock the caller out for a cooling-off period', () => {
  __resetOperatorLoginState();
  const now = 5_000_000;
  assert.equal(operatorLoginLockRemainingMs('1.2.3.4', now), 0);
  for (let i = 0; i < 5; i++) recordOperatorLoginFailure('1.2.3.4', now);
  assert.ok(operatorLoginLockRemainingMs('1.2.3.4', now) > 0);
  // A different caller is unaffected, and a successful sign-in clears the lock.
  assert.equal(operatorLoginLockRemainingMs('5.6.7.8', now), 0);
  clearOperatorLoginFailures('1.2.3.4');
  assert.equal(operatorLoginLockRemainingMs('1.2.3.4', now), 0);
});
