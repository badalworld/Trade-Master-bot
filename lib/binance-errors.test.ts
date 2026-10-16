import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBinanceFailure,
  classifyError,
  failureMessage,
  httpStatusForFailure,
  toRawFailure,
} from './binance-errors.ts';

// Simulates what lib/binance-client throws: BinanceApiError carries httpStatus and Binance's own code.
const err = (message: string, httpStatus: number, code?: number) => ({ name: 'BinanceApiError', message, httpStatus, code });

test('a 451 geo-block is reported as a location problem, never as a bad key', () => {
  const f = classifyError(
    err(
      "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms",
      451,
      0
    ),
    false
  );
  assert.equal(f.code, 'GEO_BLOCKED');
  assert.equal(f.retryable, false);
  assert.equal(f.httpStatus, 451);
  assert.match(f.action, /Move the deployment/);
  assert.match(f.action, /no API key|cannot bypass|No API key/i);
});

test('a geo-block is detected from the message even when the status is not 451', () => {
  const f = classifyError(err('Service unavailable from a restricted location', 200), true);
  assert.equal(f.code, 'GEO_BLOCKED');
});

test('rate limiting is classified as retryable', () => {
  assert.equal(classifyError(err('Too many requests', 429), false).code, 'RATE_LIMITED');
  assert.equal(classifyError(err('Banned until 1700000000000', 418), false).code, 'RATE_LIMITED');
  const byCode = classifyError(err('Way too much request weight used', 400, -1003), false);
  assert.equal(byCode.code, 'RATE_LIMITED');
  assert.equal(byCode.retryable, true);
});

test('clock skew and signature mismatches get their own diagnosis and fix', () => {
  const clock = classifyError(err('Timestamp for this request is outside of the recvWindow', 400, -1021), true);
  assert.equal(clock.code, 'TIMESTAMP_DRIFT');
  assert.equal(clock.retryable, true);

  const sig = classifyError(err('Signature for this request is not valid', 400, -1022), false);
  assert.equal(sig.code, 'SIGNATURE_INVALID');
  assert.match(sig.action, /secret/i);
});

test("-2015 on TESTNET names the real cause: mainnet keys do not work on testnet", () => {
  const f = classifyError(err('Invalid API-key, IP, or permissions for action.', 400, -2015), true);
  assert.equal(f.code, 'KEY_NETWORK_MISMATCH');
  assert.match(f.title, /not valid on Binance Futures Testnet/);
  assert.match(f.action, /testnet\.binancefuture\.com/);
  // and it must NOT be misreported as an IP problem just because the word "IP" appears in the message
  assert.doesNotMatch(f.title, /whitelist/);
});

test('-2015 that echoes the request IP is an allowlist miss, on either network', () => {
  const f = classifyError(
    err('Invalid API-key, IP, or permissions for action., request ip: 54.247.26.145', 400, -2015),
    false
  );
  assert.equal(f.code, 'IP_NOT_ALLOWED');
  assert.match(f.action, /egress IP/);
  assert.match(f.action, /\/api\/network\/ip/);
});

test('-2015 with no IP detail on mainnet lists all three possible causes', () => {
  const f = classifyError(err('Invalid API-key, IP, or permissions for action.', 400, -2015), false);
  assert.equal(f.code, 'INVALID_KEY');
  assert.match(f.action, /Enable Futures/);
  assert.match(f.action, /IP restriction/);
});

test('plain HTTP auth failures are classified', () => {
  assert.equal(classifyError(err('Unauthorized', 401), false).code, 'INVALID_KEY');
  assert.equal(classifyError(err('Forbidden', 403), false).code, 'IP_NOT_ALLOWED');
});

test('transport failures are split into timeout vs unreachable, and both are retryable', () => {
  const timeout = classifyError(err('Binance GET /fapi/v2/account timed out after 7000ms', 0), false);
  assert.equal(timeout.code, 'TIMEOUT');
  assert.equal(timeout.retryable, true);

  const unreachable = classifyError(err('fetch failed', 0), true);
  assert.equal(unreachable.code, 'NETWORK_UNREACHABLE');
  assert.equal(unreachable.retryable, true);
  assert.match(unreachable.action, /not a credential problem/);
});

test('an unrecognised failure is UNKNOWN rather than a wrong guess', () => {
  const f = classifyError(err('Something new', 500), false);
  assert.equal(f.code, 'UNKNOWN');
  assert.equal(f.retryable, false);
});

test('toRawFailure copes with plain Errors, non-errors and missing fields', () => {
  assert.deepEqual(toRawFailure(new Error('boom')), { message: 'boom', httpStatus: 0, binanceCode: null });
  assert.deepEqual(toRawFailure('a string'), { message: 'a string', httpStatus: 0, binanceCode: null });
  assert.deepEqual(toRawFailure(undefined), { message: '', httpStatus: 0, binanceCode: null });
  assert.deepEqual(toRawFailure({ message: 'm', httpStatus: NaN, code: 'x' }), {
    message: 'm',
    httpStatus: 0,
    binanceCode: null,
  });
});

test('classifyBinanceFailure is pure: no registry state, same input -> same output', () => {
  const raw = { message: 'Invalid API-key, IP, or permissions for action.', httpStatus: 400, binanceCode: -2015 };
  const a = classifyBinanceFailure(raw, true);
  const b = classifyBinanceFailure(raw, true);
  assert.deepEqual(a, b);
  // ...and the network flag genuinely changes the answer
  assert.notEqual(classifyBinanceFailure(raw, false).code, a.code);
});

test('each failure maps to an honest HTTP status instead of a blanket 401', () => {
  assert.equal(httpStatusForFailure('GEO_BLOCKED'), 451);
  assert.equal(httpStatusForFailure('RATE_LIMITED'), 429);
  assert.equal(httpStatusForFailure('NETWORK_UNREACHABLE'), 502);
  assert.equal(httpStatusForFailure('TIMEOUT'), 502);
  assert.equal(httpStatusForFailure('INVALID_KEY'), 401);
  assert.equal(httpStatusForFailure('KEY_NETWORK_MISMATCH'), 401);
  assert.equal(httpStatusForFailure('IP_NOT_ALLOWED'), 401);
  assert.equal(httpStatusForFailure('TIMESTAMP_DRIFT'), 500);
});

test('failureMessage always carries both the diagnosis and the action', () => {
  const f = classifyError(err('fetch failed', 0), false);
  const msg = failureMessage(f);
  assert.match(msg, /could not reach Binance/);
  assert.match(msg, / — /);
});
