/**
 * Exchange-filter resolution + order sizing for Binance USDT-M Futures.
 *
 * Binance rejects orders that violate LOT_SIZE / PRICE_FILTER / MIN_NOTIONAL, and silently
 * "fixing" those violations by bumping to the exchange minimum can multiply the real risk.
 * Every sizing decision therefore happens here, in one pure, unit-tested place, and any
 * deviation from the requested notional is *reported* rather than absorbed.
 *
 * No `@/` imports and no Node built-ins so this module is directly runnable under `node --test`.
 */

export interface SymbolFilters {
  /** LOT_SIZE.stepSize */
  stepSize: number;
  /** LOT_SIZE.minQty */
  minQty: number;
  /** LOT_SIZE.maxQty (0 = unset) */
  maxQty: number;
  /** PRICE_FILTER.tickSize */
  tickSize: number;
  /** MIN_NOTIONAL.notional (0 = unset) */
  minNotional: number;
  /** Symbol quantityPrecision (decimals) */
  quantityPrecision: number;
  /** Symbol pricePrecision (decimals) */
  pricePrecision: number;
}

export interface ResolvedSpec {
  symbol: string;
  filters: SymbolFilters;
  /** false when exchangeInfo never returned this symbol — live trading must fail closed. */
  known: boolean;
  source: 'exchangeInfo' | 'builtin' | 'none';
}

/**
 * Deliberately tiny. A wrong guess about tick size produces a stop-loss order Binance rejects
 * for precision (-1111), which previously left positions open with no stop at all. Unknown
 * symbols are therefore refused rather than guessed.
 */
const BUILTIN: Record<string, SymbolFilters> = {
  BTCUSDT: { stepSize: 0.001, minQty: 0.001, maxQty: 0, tickSize: 0.1, minNotional: 100, quantityPrecision: 3, pricePrecision: 2 },
  ETHUSDT: { stepSize: 0.001, minQty: 0.001, maxQty: 0, tickSize: 0.01, minNotional: 20, quantityPrecision: 3, pricePrecision: 2 },
  SOLUSDT: { stepSize: 1, minQty: 1, maxQty: 0, tickSize: 0.01, minNotional: 20, quantityPrecision: 0, pricePrecision: 2 },
  BNBUSDT: { stepSize: 0.01, minQty: 0.01, maxQty: 0, tickSize: 0.01, minNotional: 20, quantityPrecision: 2, pricePrecision: 2 },
  XRPUSDT: { stepSize: 0.1, minQty: 0.1, maxQty: 0, tickSize: 0.0001, minNotional: 5, quantityPrecision: 1, pricePrecision: 4 },
  LINKUSDT: { stepSize: 0.01, minQty: 0.01, maxQty: 0, tickSize: 0.001, minNotional: 5, quantityPrecision: 2, pricePrecision: 3 },
  AVAXUSDT: { stepSize: 1, minQty: 1, maxQty: 0, tickSize: 0.01, minNotional: 5, quantityPrecision: 0, pricePrecision: 2 },
  NEARUSDT: { stepSize: 1, minQty: 1, maxQty: 0, tickSize: 0.001, minNotional: 5, quantityPrecision: 0, pricePrecision: 3 },
  SUIUSDT: { stepSize: 0.1, minQty: 0.1, maxQty: 0, tickSize: 0.0001, minNotional: 5, quantityPrecision: 1, pricePrecision: 4 },
  ADAUSDT: { stepSize: 1, minQty: 1, maxQty: 0, tickSize: 0.0001, minNotional: 5, quantityPrecision: 0, pricePrecision: 4 },
  DOGEUSDT: { stepSize: 1, minQty: 1, maxQty: 0, tickSize: 0.00001, minNotional: 5, quantityPrecision: 0, pricePrecision: 5 },
  '1000PEPEUSDT': { stepSize: 1, minQty: 1, maxQty: 0, tickSize: 0.0000001, minNotional: 5, quantityPrecision: 0, pricePrecision: 7 },
};

function num(raw: unknown, fallback = 0): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse a raw `exchangeInfo.symbols[]` entry into filters. Returns null if unusable. */
export function parseSymbolFilters(raw: unknown): SymbolFilters | null {
  const s = raw as
    | {
        quantityPrecision?: number | string;
        pricePrecision?: number | string;
        filters?: { filterType: string; [k: string]: unknown }[];
      }
    | null
    | undefined;
  if (!s || !Array.isArray(s.filters)) return null;

  const find = (type: string) => s.filters?.find((f) => f?.filterType === type);
  const lot = find('LOT_SIZE');
  const price = find('PRICE_FILTER');
  const minNotional = find('MIN_NOTIONAL');
  if (!lot || !price) return null;

  const stepSize = num(lot.stepSize);
  const tickSize = num(price.tickSize);
  if (stepSize <= 0 || tickSize <= 0) return null;

  return {
    stepSize,
    minQty: num(lot.minQty, stepSize),
    maxQty: num(lot.maxQty),
    tickSize,
    minNotional: num(minNotional?.notional),
    quantityPrecision: Math.max(0, Math.trunc(num(s.quantityPrecision, 8) || 8)),
    pricePrecision: Math.max(0, Math.trunc(num(s.pricePrecision, 8) || 8)),
  };
}

/** Build a symbol→spec map from an `exchangeInfo` payload. Empty map means "no trustworthy data". */
export function buildSpecMap(exchangeInfo: unknown): Record<string, SymbolFilters> {
  const symbols = (exchangeInfo as { symbols?: unknown[] })?.symbols;
  const map: Record<string, SymbolFilters> = {};
  if (!Array.isArray(symbols)) return map;
  for (const entry of symbols) {
    const sym = (entry as { symbol?: string })?.symbol;
    const filters = parseSymbolFilters(entry);
    if (typeof sym === 'string' && sym && filters) map[sym.toUpperCase()] = filters;
  }
  return map;
}

export function resolveSpec(
  symbol: string,
  specMap: Record<string, SymbolFilters> | null | undefined
): ResolvedSpec {
  const upper = String(symbol || '').toUpperCase();
  const fromExchange = specMap?.[upper];
  if (fromExchange) {
    return { symbol: upper, filters: fromExchange, known: true, source: 'exchangeInfo' };
  }
  const builtin = BUILTIN[upper];
  if (builtin) {
    return { symbol: upper, filters: builtin, known: true, source: 'builtin' };
  }
  return {
    symbol: upper,
    // Placeholder only — `known: false` makes every caller reject before touching the exchange.
    filters: {
      stepSize: 0,
      minQty: 0,
      maxQty: 0,
      tickSize: 0,
      minNotional: 0,
      quantityPrecision: 0,
      pricePrecision: 0,
    },
    known: false,
    source: 'none',
  };
}

/** Format a quantity/price to the exchange grid without float-noise leaking into the string. */
export function formatToStep(
  value: number,
  step: number,
  precision: number
): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const p = Math.max(0, Math.min(18, Math.trunc(precision)));
  const safeStep = Number.isFinite(step) && step > 0 ? step : 10 ** -p || 1;
  const units = Math.floor(value / safeStep + 1e-9);
  const snapped = units * safeStep;
  // Sub-step values collapse to zero; callers must treat '0' as "cannot size this order" and never
  // send it to the exchange.
  if (!Number.isFinite(snapped) || snapped <= 0) return '0';
  return Number(snapped.toFixed(12)).toFixed(p);
}

export type SizingResult =
  | {
      ok: true;
      quantity: string;
      quantityNum: number;
      /** Notional actually committed, derived from the *rounded* qty — what must be booked. */
      effectiveNotional: number;
      /** effectiveNotional / requestedNotional. */
      deviationRatio: number;
      notes: string[];
    }
  | { ok: false; code: SizingRejectCode; message: string; minLegalNotional?: number };

export type SizingRejectCode =
  | 'INPUT_INVALID'
  | 'SPEC_UNKNOWN'
  | 'EXCEEDS_MAX_QTY'
  | 'MIN_NOTIONAL_UNREACHABLE'
  | 'EXCEEDS_MAX_NOTIONAL'
  | 'DEVIATION_TOO_LARGE';

export interface SizingInput {
  requestedNotional: number;
  price: number;
  spec: ResolvedSpec;
  /** Hard ceiling on committed notional (risk policy). 0 = no ceiling. */
  maxNotional?: number;
  /** Reject when rounding up to the legal minimum inflates risk beyond this ratio. */
  maxDeviationRatio?: number;
}

const DEFAULT_MAX_DEVIATION_RATIO = 1.5;

/**
 * Turn a desired notional into a legal Binance quantity, and *refuse* rather than silently
 * over-size when the exchange's minimum legal position is materially larger than requested.
 */
export function computeOrderQuantity(input: SizingInput): SizingResult {
  const { requestedNotional, price, spec } = input;
  const maxDeviation =
    input.maxDeviationRatio && input.maxDeviationRatio > 1
      ? input.maxDeviationRatio
      : DEFAULT_MAX_DEVIATION_RATIO;

  if (!spec.known) {
    return {
      ok: false,
      code: 'SPEC_UNKNOWN',
      message: `No exchange filter data for ${spec.symbol}. Refusing to size an order on guessed precision — retry once /fapi/v1/exchangeInfo is reachable.`,
    };
  }
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(requestedNotional) || requestedNotional <= 0) {
    return {
      ok: false,
      code: 'INPUT_INVALID',
      message: `Invalid sizing input (notional=${requestedNotional}, price=${price}).`,
    };
  }

  const f = spec.filters;
  const notes: string[] = [];
  let qtyNum = Math.floor(requestedNotional / price / f.stepSize + 1e-9) * f.stepSize;

  if (qtyNum < f.minQty) {
    notes.push(`LOT_SIZE minQty floor applied: ${qtyNum.toFixed(8)} -> ${f.minQty}`);
    qtyNum = f.minQty;
  }

  if (f.maxQty > 0 && qtyNum > f.maxQty) {
    return {
      ok: false,
      code: 'EXCEEDS_MAX_QTY',
      message: `Required quantity ${qtyNum} exceeds ${spec.symbol} LOT_SIZE maxQty ${f.maxQty}.`,
    };
  }

  let notional = qtyNum * price;

  if (f.minNotional > 0 && notional < f.minNotional * 0.999) {
    const neededUnits = Math.ceil(f.minNotional / price / f.stepSize - 1e-9);
    const bumped = neededUnits * f.stepSize;
    if (!(bumped > 0) || bumped * price < f.minNotional * 0.999) {
      return {
        ok: false,
        code: 'MIN_NOTIONAL_UNREACHABLE',
        message: `Cannot satisfy ${spec.symbol} MIN_NOTIONAL $${f.minNotional} from a $${notional.toFixed(2)} request.`,
      };
    }
    notes.push(`MIN_NOTIONAL bump applied: $${notional.toFixed(2)} -> $${(bumped * price).toFixed(2)}`);
    qtyNum = bumped;
    notional = qtyNum * price;
  }

  const maxNotional = num(input.maxNotional);
  if (maxNotional > 0 && notional > maxNotional) {
    return {
      ok: false,
      code: 'EXCEEDS_MAX_NOTIONAL',
      message: `Legal minimum position for ${spec.symbol} is $${notional.toFixed(2)}, above the configured max notional $${maxNotional.toFixed(2)}. Reduce leverage or leave the pair out of the scan list.`,
      minLegalNotional: notional,
    };
  }

  const deviation = notional / requestedNotional;
  if (deviation > maxDeviation) {
    const minRequested = notional / maxDeviation;
    return {
      ok: false,
      code: 'DEVIATION_TOO_LARGE',
      message:
        `Smallest legal ${spec.symbol} position is $${notional.toFixed(2)} but only $${requestedNotional.toFixed(2)} was requested ` +
        `(${deviation.toFixed(2)}x). Refusing to silently multiply risk. Raise the requested notional to at least ` +
        `$${minRequested.toFixed(2)} (margin x leverage) or exclude this pair from the scan list.`,
      minLegalNotional: notional,
    };
  }

  const quantity = formatToStep(qtyNum, f.stepSize, f.quantityPrecision);
  const quantityNum = parseFloat(quantity);
  if (!Number.isFinite(quantityNum) || quantityNum <= 0) {
    return {
      ok: false,
      code: 'INPUT_INVALID',
      message: `Sizing produced a non-positive quantity for ${spec.symbol} (raw=${qtyNum}, step=${f.stepSize}).`,
    };
  }

  return {
    ok: true,
    quantity,
    quantityNum,
    effectiveNotional: Number((quantityNum * price).toFixed(4)),
    deviationRatio: Number(deviation.toFixed(4)),
    notes,
  };
}

export type PriceAlignResult =
  | { ok: true; price: string; priceNum: number }
  | { ok: false; message: string };

/** Quantize a price onto the symbol's tick grid so stopPrice can never be rejected for precision. */
export function alignPriceToTick(price: number, spec: ResolvedSpec, label = 'price'): PriceAlignResult {
  if (!spec.known) {
    return { ok: false, message: `No tick data for ${spec.symbol}; refusing to send ${label}.` };
  }
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, message: `${label} is not a positive number (${price}).` };
  }
  const f = spec.filters;
  const str = formatToStep(price, f.tickSize, f.pricePrecision);
  const n = parseFloat(str);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, message: `${label} ${price} is below ${spec.symbol} tickSize ${f.tickSize}.` };
  }
  return { ok: true, price: str, priceNum: n };
}

export type BracketResult =
  | { ok: true; sl: number; tp: number; riskPerUnit: number }
  | { ok: false; message: string };

/**
 * Guard the bracket before it reaches the exchange: an inverted or degenerate stop on a
 * market order fires instantly (guaranteed loss), so it must be rejected up front.
 */
export function validateEntryBracket(args: {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  /** Minimum acceptable |entry - sl| as a fraction of price (0.0002 = 2bp). */
  minRiskFraction?: number;
}): BracketResult {
  const { side, entryPrice, slPrice, tpPrice } = args;
  const minRiskFraction = args.minRiskFraction ?? 0.0005;

  if (![entryPrice, slPrice, tpPrice].every((v) => Number.isFinite(v) && v > 0)) {
    return { ok: false, message: 'Entry, stop-loss and take-profit must all be positive numbers.' };
  }

  const riskPerUnit = side === 'LONG' ? entryPrice - slPrice : slPrice - entryPrice;
  const rewardPerUnit = side === 'LONG' ? tpPrice - entryPrice : entryPrice - tpPrice;

  if (riskPerUnit <= 0) {
    return {
      ok: false,
      message: `${side} stop is on the wrong side of entry (entry=${entryPrice}, sl=${slPrice}). Refusing to place an order whose stop triggers instantly.`,
    };
  }
  if (rewardPerUnit <= 0) {
    return {
      ok: false,
      message: `${side} take-profit is on the wrong side of entry (entry=${entryPrice}, tp=${tpPrice}).`,
    };
  }
  if (riskPerUnit / entryPrice < minRiskFraction) {
    return {
      ok: false,
      message: `${side} stop is too tight to be executable (${((riskPerUnit / entryPrice) * 100).toFixed(4)}% of price; minimum ${minRiskFraction * 100}%). Price likely moved since the signal — skip this setup.`,
    };
  }
  return { ok: true, sl: slPrice, tp: tpPrice, riskPerUnit };
}
