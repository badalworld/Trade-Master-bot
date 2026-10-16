import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignPriceToTick,
  buildSpecMap,
  computeOrderQuantity,
  formatToStep,
  resolveSpec,
  validateEntryBracket,
  type SymbolFilters,
} from './exchange-specs.ts';
import { loadRiskPolicy, validateOpenRequest } from './risk-policy.ts';

const BTC: SymbolFilters = {
  stepSize: 0.001,
  minQty: 0.001,
  maxQty: 0,
  tickSize: 0.1,
  minNotional: 100,
  quantityPrecision: 3,
  pricePrecision: 2,
};
const SOL: SymbolFilters = {
  stepSize: 1,
  minQty: 1,
  maxQty: 0,
  tickSize: 0.01,
  minNotional: 20,
  quantityPrecision: 0,
  pricePrecision: 2,
};
const ETH: SymbolFilters = {
  stepSize: 0.001,
  minQty: 0.001,
  maxQty: 0,
  tickSize: 0.01,
  minNotional: 20,
  quantityPrecision: 3,
  pricePrecision: 2,
};

const spec = (symbol: string, filters: SymbolFilters) => ({
  symbol,
  filters,
  known: true,
  source: 'exchangeInfo' as const,
});

test('B2 regression: refuses to silently inflate a BTC order to the exchange minimum', () => {
  const result = computeOrderQuantity({
    requestedNotional: 20,
    price: 111000,
    spec: spec('BTCUSDT', BTC),
    maxDeviationRatio: 1.5,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'DEVIATION_TOO_LARGE');
  // Smallest legal BTC position is 0.001 BTC = $111 — the old code traded that anyway.
  assert.equal(Math.round(result.minLegalNotional ?? 0), 111);
  assert.match(result.message, /Smallest legal BTCUSDT position is \$111.00/);
});

test('B2 regression: SOL minimum lot (1 SOL) is reported, not absorbed', () => {
  const result = computeOrderQuantity({
    requestedNotional: 20,
    price: 210,
    spec: spec('SOLUSDT', SOL),
    maxDeviationRatio: 1.5,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'DEVIATION_TOO_LARGE');
  assert.equal(Math.round(result.minLegalNotional ?? 0), 210);
});

test('B2: a request near the legal minimum is accepted with deviation reported', () => {
  const result = computeOrderQuantity({
    requestedNotional: 150,
    price: 111000,
    spec: spec('BTCUSDT', BTC),
    maxNotional: 500,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.quantity, '0.001');
  assert.equal(result.effectiveNotional, 111);
  assert.ok(result.deviationRatio < 1.5);
});

test('B2: MIN_NOTIONAL is satisfied by rounding the quantity UP, and that is recorded', () => {
  const result = computeOrderQuantity({
    requestedNotional: 20,
    price: 4200,
    spec: spec('ETHUSDT', ETH),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // 0.004 ETH = $16.80 is below the $20 filter, so it must be bumped to 0.005.
  assert.equal(result.quantity, '0.005');
  assert.equal(result.effectiveNotional, 21);
  assert.ok(result.notes.some((n) => n.includes('MIN_NOTIONAL bump')));
});

test('B2: notional above the policy ceiling is rejected before the exchange is called', () => {
  const result = computeOrderQuantity({
    requestedNotional: 50000,
    price: 111000,
    spec: spec('BTCUSDT', BTC),
    maxNotional: 500,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'EXCEEDS_MAX_NOTIONAL');
});

test('B1 root cause: a symbol with no exchange filters is never sized on guesses', () => {
  const unknown = resolveSpec('OBSCUREUSDT', {});
  assert.equal(unknown.known, false);
  const result = computeOrderQuantity({
    requestedNotional: 20,
    price: 1.234,
    spec: unknown,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'SPEC_UNKNOWN');
  assert.match(result.message, /exchangeInfo/);
});

test('buildSpecMap only accepts symbols with real LOT_SIZE + PRICE_FILTER data', () => {
  const map = buildSpecMap({
    symbols: [
      {
        symbol: 'btcusdt',
        quantityPrecision: 3,
        pricePrecision: 2,
        filters: [
          { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
          { filterType: 'PRICE_FILTER', tickSize: '0.1' },
          { filterType: 'MIN_NOTIONAL', notional: '100' },
        ],
      },
      { symbol: 'BROKENUSDT', filters: [] },
    ],
  });
  assert.ok(map.BTCUSDT);
  assert.equal(map.BTCUSDT.minNotional, 100);
  assert.equal(map.BTCUSDT.maxQty, 1000);
  assert.equal(map.BROKENUSDT, undefined);
});

test('B1: stop prices are quantized onto the tick grid so -1111 precision rejects cannot happen', () => {
  const s = spec('BTCUSDT', BTC);
  const aligned = alignPriceToTick(110123.456, s, 'stopLoss');
  assert.equal(aligned.ok, true);
  if (!aligned.ok) return;
  assert.equal(aligned.price, '110123.40');
  assert.equal(aligned.priceNum, 110123.4);
  const unknown = resolveSpec('MYSTERYUSDT', null);
  assert.equal(alignPriceToTick(1.234, unknown).ok, false);
  assert.equal(alignPriceToTick(0, s).ok, false);
});

test('formatToStep truncates to the grid and never leaks binary float noise', () => {
  assert.equal(formatToStep(0.00300000000000000065, 0.001, 3), '0.003');
  // genuine sub-step values must truncate down, never round up
  assert.equal(formatToStep(0.0994, 0.001, 3), '0.099');
  assert.equal(formatToStep(0.1 - 1e-17, 0.001, 3), '0.100'); // float artifact of exactly 0.1 snaps up
  assert.equal(formatToStep(12.7, 1, 0), '12');
  assert.equal(formatToStep(0.0005, 0.001, 3), '0');
  assert.equal(formatToStep(-5, 0.001, 3), '0');
});

test('B1: an inverted or degenerate bracket is rejected instead of firing instantly', () => {
  assert.equal(
    validateEntryBracket({ side: 'LONG', entryPrice: 100, slPrice: 101, tpPrice: 105 }).ok,
    false
  );
  assert.match(
    (validateEntryBracket({ side: 'LONG', entryPrice: 100, slPrice: 101, tpPrice: 105 }) as { message: string }).message,
    /wrong side/
  );
  // SHORT with stop ABOVE entry is correct; the wrong-side case is a stop below entry.
  assert.equal(
    validateEntryBracket({ side: 'SHORT', entryPrice: 100, slPrice: 101, tpPrice: 95 }).ok,
    true
  );
  assert.equal(
    validateEntryBracket({ side: 'SHORT', entryPrice: 100, slPrice: 99, tpPrice: 95 }).ok,
    false
  );
  assert.equal(
    validateEntryBracket({ side: 'LONG', entryPrice: 100, slPrice: 99, tpPrice: 98 }).ok,
    false
  );
  assert.equal(validateEntryBracket({ side: 'LONG', entryPrice: 100, slPrice: 0, tpPrice: 105 }).ok, false);
  // 1bp stop at 15x is noise; must be refused.
  assert.equal(
    validateEntryBracket({ side: 'LONG', entryPrice: 100, slPrice: 99.995, tpPrice: 101 }).ok,
    false
  );
  assert.equal(
    validateEntryBracket({ side: 'LONG', entryPrice: 100, slPrice: 99, tpPrice: 102 }).ok,
    true
  );
});

// ---------------------------------------------------------------------------
// B4: server-side risk policy
// ---------------------------------------------------------------------------

const base = {
  symbol: 'BTCUSDT',
  side: 'LONG' as const,
  margin: 2,
  leverage: 10,
  openPositionsCount: 0,
  isTestnet: true,
};

test('B4: mainnet orders are locked unless the operator explicitly enables them', () => {
  const policy = loadRiskPolicy({});
  assert.equal(policy.allowMainnet, false);
  const res = validateOpenRequest(policy, { ...base, isTestnet: false });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.ok(res.violations.some((v) => v.code === 'MAINNET_DISABLED'));
});

test('B4: leverage and margin are capped on the server, not just in the UI', () => {
  const policy = loadRiskPolicy({});
  const res = validateOpenRequest(policy, { ...base, leverage: 50, margin: 5000 });
  assert.equal(res.ok, false);
  if (res.ok) return;
  const codes = res.violations.map((v) => v.code);
  assert.ok(codes.includes('LEVERAGE_OUT_OF_RANGE'), codes.join(','));
  assert.ok(codes.includes('MARGIN_TOO_LARGE'), codes.join(','));
  assert.ok(codes.includes('NOTIONAL_TOO_LARGE'), codes.join(','));
});

test('B4: kill switch blocks entries but is silent about closes (closes reduce risk)', () => {
  const policy = loadRiskPolicy({ TRADE_HALT: 'true' });
  const res = validateOpenRequest(policy, base);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.ok(res.violations.some((v) => v.code === 'TRADE_HALTED'));
});

test('B4: daily loss breaker keys on exchange realized PnL', () => {
  const policy = loadRiskPolicy({ TRADE_MAX_DAILY_LOSS_USDT: '50' });
  const tripped = validateOpenRequest(policy, { ...base, realizedPnlTodayUsdt: -51 });
  assert.equal(tripped.ok, false);
  if (tripped.ok) return;
  assert.ok(tripped.violations.some((v) => v.code === 'DAILY_LOSS_BREAKER'));

  const fine = validateOpenRequest(policy, { ...base, realizedPnlTodayUsdt: -20 });
  assert.equal(fine.ok, true);
});

test('B4: position cap and symbol allowlist are enforced server-side', () => {
  const policy = loadRiskPolicy({});
  const capped = validateOpenRequest(policy, { ...base, openPositionsCount: 5 });
  assert.equal(capped.ok, false);
  if (capped.ok) return;
  assert.ok(capped.violations.some((v) => v.code === 'MAX_OPEN_POSITIONS'));

  const offlist = validateOpenRequest(policy, { ...base, symbol: 'MEMECOINUSDT' });
  assert.equal(offlist.ok, false);
  if (offlist.ok) return;
  assert.ok(offlist.violations.some((v) => v.code === 'SYMBOL_NOT_ALLOWED'));
});

test('B4: env overrides tighten policy and defaults are never looser than the strategy intends', () => {
  const policy = loadRiskPolicy({
    TRADE_MAX_LEVERAGE: '12',
    TRADE_MAX_MARGIN_USDT: '5',
    TRADE_SYMBOL_ALLOWLIST: 'BTCUSDT, ETHUSDT',
  });
  assert.equal(policy.maxLeverage, 12);
  assert.equal(policy.minLeverage, 10);
  assert.equal(policy.maxMarginUsdt, 5);
  assert.deepEqual(policy.symbolAllowlist, ['BTCUSDT', 'ETHUSDT']);

  // An out-of-range cap must not be able to make things *more* permissive than the sane default.
  assert.equal(loadRiskPolicy({ TRADE_MAX_LEVERAGE: '125' }).maxLeverage, 25);
  assert.equal(validateOpenRequest(policy, { ...base, leverage: 13, margin: 6 }).ok, false);
});
