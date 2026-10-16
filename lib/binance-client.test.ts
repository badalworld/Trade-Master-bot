import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  BinanceApiError,
  MAINNET_BASE,
  TESTNET_BASE,
  getAccount,
  getLivePositions,
  getRealizedPnlToday,
  placeMarketOrder,
} from './binance-client.ts';
import { classifyError } from './binance-errors.ts';

/**
 * These tests exist because of one production failure: every *signed read* (account, positionRisk,
 * income, openOrders) went out as a GET with its parameters in `body`. `fetch` ignores a body on
 * GET, so the requests reached Binance completely empty and came back
 * `-1102 Mandatory parameter 'timestamp' was not sent` — 60 times in twelve minutes, with an
 * operator hunting for a broken API key that was never the problem. Nothing in the suite looked at
 * what actually went over the wire, so nothing caught it.
 *
 * So: the wire format is asserted directly, including that the signature verifies against the exact
 * payload that was sent.
 */

const creds = { apiKey: 'test-key', apiSecret: 'test-secret', isTestnet: false };

interface Captured {
  method: string;
  url: URL;
  body: string | undefined;
  headers: Record<string, string>;
}

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { status: 200, ...init });

/** Swap in a fake exchange for one call, capturing exactly what the client sends. */
async function withFetch(
  handler: (req: Captured) => Response | Promise<Response>,
  fn: () => Promise<unknown>
): Promise<{ captured: Captured[]; error: unknown }> {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const req: Captured = {
      method: init.method ?? 'GET',
      url,
      body: typeof init.body === 'string' ? init.body : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    captured.push(req);
    return handler(req);
  }) as typeof fetch;
  try {
    await fn();
    return { captured, error: null };
  } catch (error) {
    return { captured, error };
  } finally {
    globalThis.fetch = original;
  }
}

/** The signature must cover the payload exactly as sent — no more, no less. */
function expectValidSignature(payloadWithSignature: string, secret = creds.apiSecret): void {
  const match = /&signature=([0-9a-f]{64})$/.exec(payloadWithSignature);
  assert.ok(match, `payload did not end in a signature: ${payloadWithSignature}`);
  const payload = payloadWithSignature.slice(0, match.index);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  assert.equal(match[1], expected, 'signature does not match the payload that was sent');
}

test('a signed GET sends timestamp/recvWindow/signature in the query string, never in a body', async () => {
  const { captured, error } = await withFetch(
    () =>
      json({
        totalWalletBalance: '120.5',
        availableBalance: '95.25',
        totalUnrealizedProfit: '1.5',
        totalMarginBalance: '122',
        canTrade: true,
      }),
    () => getAccount(creds)
  );
  assert.equal(error, null);

  const req = captured[0];
  assert.equal(req.method, 'GET');
  assert.equal(req.body, undefined, 'fetch drops a body on GET — the payload cannot live there');
  assert.equal(req.url.origin, MAINNET_BASE);
  assert.equal(req.headers['X-MBX-APIKEY'], creds.apiKey);

  const timestamp = req.url.searchParams.get('timestamp');
  assert.ok(timestamp && Number(timestamp) > 0, 'GET must carry a timestamp or Binance answers -1102');
  assert.ok(Number(req.url.searchParams.get('recvWindow')) > 0);
  expectValidSignature(req.url.search.slice(1));
});

test('every signed read puts its own parameters on the query string', async () => {
  // The whole read path shares one signer, so each endpoint is checked rather than assumed.
  const positions = await withFetch(() => json([{ symbol: 'BTCUSDT', positionAmt: '0.01' }]), () =>
    getLivePositions(creds)
  );
  assert.equal(positions.error, null);
  assert.equal(positions.captured[0].url.pathname, '/fapi/v2/positionRisk');
  expectValidSignature(positions.captured[0].url.search.slice(1));

  const income = await withFetch(() => json([]), () => getRealizedPnlToday(creds));
  assert.equal(income.error, null);
  const incomeReq = income.captured[0];
  assert.equal(incomeReq.url.pathname, '/fapi/v1/income');
  assert.ok(incomeReq.url.searchParams.get('startTime'), 'request parameters must survive onto the URL');
  expectValidSignature(incomeReq.url.search.slice(1));
});

test('a signed write keeps the payload in the body, signed exactly as sent', async () => {
  const { captured, error } = await withFetch(
    () => json({ orderId: 42, status: 'FILLED', executedQty: '0.01', avgPrice: '60000' }),
    () => placeMarketOrder(creds, { symbol: 'BTCUSDT', side: 'BUY', quantity: '0.01' })
  );
  assert.equal(error, null);

  const req = captured[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url.search, '', 'the POST payload belongs in the body');
  assert.ok(req.body, 'a POST without its signed payload would place nothing');
  expectValidSignature(req.body);

  const body = new URLSearchParams(req.body);
  assert.equal(body.get('symbol'), 'BTCUSDT');
  assert.equal(body.get('quantity'), '0.01');
  assert.equal(body.get('type'), 'MARKET');
  assert.equal(body.get('reduceOnly'), null, 'a plain entry must not be reduce-only');
});

test('reduceOnly is sent only when a close asks for it', async () => {
  const { captured } = await withFetch(() => json({ orderId: 1, status: 'FILLED' }), () =>
    placeMarketOrder(creds, { symbol: 'BTCUSDT', side: 'SELL', quantity: '0.01', reduceOnly: true })
  );
  assert.equal(new URLSearchParams(captured[0].body).get('reduceOnly'), 'true');
});

test('the testnet flag selects the testnet host, not a mainnet one', async () => {
  const { captured } = await withFetch(() => json({ dualSidePosition: false }), async () => {
    const { getPositionMode, __resetPositionModeCache } = await import('./binance-client.ts');
    __resetPositionModeCache();
    await getPositionMode({ ...creds, isTestnet: true });
  });
  assert.equal(captured[0].url.origin, TESTNET_BASE);
});

test("a Binance rejection keeps Binance's code and message instead of being flattened", async () => {
  const { error } = await withFetch(
    () =>
      json(
        { code: -1102, msg: "Mandatory parameter 'timestamp' was not sent, was empty/null, or malformed." },
        { status: 400 }
      ),
    () => getLivePositions(creds)
  );

  assert.ok(error instanceof BinanceApiError);
  assert.equal(error.httpStatus, 400);
  assert.equal(error.code, -1102);
  assert.match(error.message, /Mandatory parameter 'timestamp'/);

  // ...and the message an operator actually saw is now diagnosed instead of dumped raw.
  const failure = classifyError(error, false);
  assert.equal(failure.code, 'REQUEST_INVALID');
  assert.equal(failure.retryable, false);
  assert.match(failure.action, /not a credential problem/);
});

test('a rejected order can never be mistaken for a filled one', async () => {
  const { error } = await withFetch(
    () => json({ code: -2019, msg: 'Margin is insufficient.' }, { status: 400 }),
    () => placeMarketOrder(creds, { symbol: 'BTCUSDT', side: 'BUY', quantity: '5' })
  );
  assert.ok(error instanceof BinanceApiError, 'a rejected order must throw, never return an ack');
  assert.equal(error.code, -2019);
  assert.match(error.message, /Margin is insufficient/);
});

test('an unreachable exchange is a transport failure, not a credential failure', async () => {
  const { error } = await withFetch(
    () => {
      throw new TypeError('fetch failed');
    },
    () => getAccount(creds)
  );

  assert.ok(error instanceof BinanceApiError);
  assert.equal(error.httpStatus, 0, 'no response ever arrived');
  const failure = classifyError(error, false);
  assert.equal(failure.code, 'NETWORK_UNREACHABLE');
  assert.equal(failure.retryable, true);
});

test('the daily-PnL read fails closed with NaN rather than inventing a number', async () => {
  let value: number | null = null;
  const { error } = await withFetch(
    () => json({ code: -1102, msg: 'nope' }, { status: 400 }),
    async () => {
      value = await getRealizedPnlToday(creds);
    }
  );
  assert.equal(error, null, 'this helper reports "unknown" by value, it does not throw');
  assert.ok(Number.isNaN(value), 'an unreachable income ledger must never read as "no losses today"');
});

test('the daily-PnL read sums realised PnL, commission and funding', async () => {
  const rows = [
    { incomeType: 'REALIZED_PNL', income: '12.5' },
    { incomeType: 'COMMISSION', income: '-0.75' },
    { incomeType: 'FUNDING_FEE', income: '-0.25' },
    { incomeType: 'TRANSFER', income: '1000' }, // must not count: a deposit is not trading PnL
  ];
  let value = NaN;
  const { captured } = await withFetch(
    () => json(rows),
    async () => {
      value = await getRealizedPnlToday(creds);
    }
  );
  assert.equal(captured.length, 1);
  assert.equal(value, 11.5);
});
