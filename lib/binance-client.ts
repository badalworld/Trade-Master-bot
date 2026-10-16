/**
 * Minimal, explicit Binance USDT-M Futures REST client used by the API routes.
 *
 * Consolidates what used to be copy-pasted across three route files so that signing, timeouts,
 * error propagation and used-weight accounting behave identically everywhere — in particular so
 * that a rejected order can never be mistaken for a successful one.
 */

export type BinanceCreds = { apiKey: string; apiSecret: string; isTestnet: boolean };

export const MAINNET_BASE = 'https://fapi.binance.com';
export const TESTNET_BASE = 'https://testnet.binancefuture.com';

export const baseUrlFor = (isTestnet: boolean) => (isTestnet ? TESTNET_BASE : MAINNET_BASE);

export class BinanceApiError extends Error {
  code: number | undefined;
  httpStatus: number;
  usedWeight: number | undefined;
  constructor(message: string, httpStatus: number, code?: number, usedWeight?: number) {
    super(message);
    this.name = 'BinanceApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.usedWeight = usedWeight;
  }
}

type Json = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 7000;

interface CallResult<T> {
  data: T;
  usedWeight: number | undefined;
  status: number;
}

async function readWeight(res: Response): Promise<number | undefined> {
  const raw = res.headers.get('x-mbx-used-weight-1m') ?? res.headers.get('X-MBX-USED-WEIGHT-1M');
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

async function signedRequest<T = Json>(
  creds: BinanceCreds,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  opts: { timeoutMs?: number; recvWindow?: number } = {}
): Promise<CallResult<T>> {
  const crypto = await import('crypto');
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.append(k, String(v));
  }
  usp.append('recvWindow', String(opts.recvWindow ?? 5000));
  usp.append('timestamp', String(Date.now()));

  const query = usp.toString();
  const signature = crypto.createHmac('sha256', creds.apiSecret).update(query).digest('hex');
  const signedPayload = `${query}&signature=${signature}`;

  // Where the signed payload goes depends on the verb, and getting it wrong fails silently: `fetch`
  // ignores `body` on a GET/HEAD request, so a GET whose parameters were only placed in `body`
  // reaches Binance with *nothing* — no timestamp, no signature, no symbol — and comes back as
  // `-1102 Mandatory parameter 'timestamp' was not sent`. Every signed read (account, positionRisk,
  // income, openOrders, order status) goes through here, so the read path has to use the query
  // string. Binance accepts the payload in either place, so writes keep using the body as before.
  const payloadInQuery = method === 'GET';
  const url = `${baseUrlFor(creds.isTestnet)}${path}${payloadInQuery ? `?${signedPayload}` : ''}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': creds.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      ...(payloadInQuery ? {} : { body: signedPayload }),
      signal: controller.signal,
      cache: 'no-store',
    });
    const usedWeight = await readWeight(res);

    if (!res.ok) {
      let message = `Binance ${method} ${path} failed (HTTP ${res.status})`;
      let code: number | undefined;
      try {
        const err = (await res.json()) as { msg?: string; code?: number };
        if (err?.msg) message = err.msg;
        code = err?.code;
      } catch {
        /* non-JSON error body */
      }
      throw new BinanceApiError(message, res.status, code, usedWeight);
    }

    const text = await res.text();
    const data = (text ? JSON.parse(text) : {}) as T;
    return { data, usedWeight, status: res.status };
  } catch (err) {
    if (err instanceof BinanceApiError) throw err;
    const e = err as Error;
    const message =
      e?.name === 'AbortError'
        ? `Binance ${method} ${path} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : `Network error reaching Binance ${method} ${path}: ${e?.message || 'unreachable'} (no order was sent)`;
    throw new BinanceApiError(message, 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Public, unsigned market-data call (no key required, does not consume account weight). */
export async function publicGet<T = unknown>(
  isTestnet: boolean,
  path: string,
  query = '',
  timeoutMs = 5000
): Promise<{ data: T; usedWeight?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrlFor(isTestnet)}${path}${query}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'TradeMaster/2.0' },
      cache: 'no-store',
    });
    const usedWeight = await readWeight(res);
    if (!res.ok) throw new BinanceApiError(`HTTP ${res.status}`, res.status, undefined, usedWeight);
    return { data: (await res.json()) as T, usedWeight };
  } catch (err) {
    if (err instanceof BinanceApiError) throw err;
    const e = err as Error;
    throw new BinanceApiError(
      e?.name === 'AbortError' ? `Binance GET ${path} timed out` : e?.message || 'Network error',
      0
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface BinanceAccountSnapshot {
  totalWalletBalance: number;
  availableBalance: number;
  totalUnrealizedProfit: number;
  totalMarginBalance: number;
  canTrade: boolean;
  usedWeight?: number;
}

export async function getAccount(creds: BinanceCreds): Promise<BinanceAccountSnapshot & { raw: Json }> {
  const { data, usedWeight } = await signedRequest<Json>(creds, 'GET', '/fapi/v2/account', {});
  const f = (k: string, d = 0) => {
    const n = parseFloat(String(data?.[k] ?? d));
    return Number.isFinite(n) ? n : d;
  };
  return {
    totalWalletBalance: f('totalWalletBalance'),
    availableBalance: f('availableBalance'),
    totalUnrealizedProfit: f('totalUnrealizedProfit'),
    totalMarginBalance: f('totalMarginBalance'),
    canTrade: data?.canTrade !== false,
    usedWeight,
    raw: data,
  };
}

export interface LivePosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  leverage: number;
  isolatedMargin: number;
}

/** Authoritative open-position list straight from the exchange (never from browser state). */
export async function getLivePositions(creds: BinanceCreds): Promise<LivePosition[]> {
  const { data, usedWeight } = await signedRequest<{ positions?: unknown[] } | Json>(
    creds,
    'GET',
    '/fapi/v2/positionRisk',
    {}
  );
  const rows = Array.isArray((data as { positions?: unknown[] })?.positions)
    ? ((data as { positions: unknown[] }).positions as Json[])
    : Array.isArray(data)
      ? (data as Json[])
      : [];
  void usedWeight;

  return rows
    .map((p) => {
      const amt = parseFloat(String(p.positionAmt ?? '0')) || 0;
      const entryPrice = parseFloat(String(p.entryPrice ?? '0')) || 0;
      const leverage = parseInt(String(p.leverage ?? '0'), 10) || 0;
      const isolatedMargin =
        parseFloat(String(p.isolatedWallet ?? p.initialMargin ?? '0')) ||
        (leverage > 0 ? (Math.abs(amt) * entryPrice) / leverage : 0);
      return {
        symbol: String(p.symbol ?? ''),
        side: amt >= 0 ? ('LONG' as const) : ('SHORT' as const),
        positionAmt: amt,
        entryPrice,
        markPrice: parseFloat(String(p.markPrice ?? '0')) || entryPrice,
        unrealizedProfit: parseFloat(String(p.unRealizedProfit ?? '0')) || 0,
        leverage,
        isolatedMargin,
      };
    })
    .filter((p) => Math.abs(p.positionAmt) > 0 && p.symbol !== '');
}

/**
 * Net realized PnL for the current UTC day straight from /fapi/v1/income: realized PnL **plus
 * commission plus funding**, because those are real money that the day's P&L has to include — a
 * breaker that ignores fees under-reports losses on exactly the leveraged scalps this bot takes.
 * Keys on the exchange, so it cannot be reset by clearing browser storage or restarting a process.
 *
 * Returns `NaN` when the exchange cannot be asked; `dailyLossGate` treats that as a hard stop
 * (fail closed) rather than as "no losses today".
 */
export async function getRealizedPnlToday(creds: BinanceCreds): Promise<number> {
  const startUtcDay = Math.floor(Date.now() / 86400000) * 86400000;
  try {
    const { data } = await signedRequest<Json[]>(creds, 'GET', '/fapi/v1/income', {
      startTime: startUtcDay,
      limit: 1000,
    });
    if (!Array.isArray(data)) return NaN;
    let total = 0;
    for (const row of data) {
      const type = String(row.incomeType ?? '');
      if (type === 'REALIZED_PNL' || type === 'COMMISSION' || type === 'FUNDING_FEE') {
        total += parseFloat(String(row.income ?? '0')) || 0;
      }
    }
    return total;
  } catch {
    // Never invent a number here: the caller decides what "unknown" means (and must fail closed).
    return NaN;
  }
}

export interface PositionMode {
  /** True = Hedge Mode (LONG/SHORT held separately) — unsupported by this bot. */
  dualSidePosition: boolean;
}

let positionModeCache: { at: number; value: boolean | null } = { at: 0, value: null };
const POSITION_MODE_TTL_MS = 5 * 60 * 1000;

/**
 * One-Way vs Hedge mode for the account. Cached briefly because it changes only when an operator
 * changes it in the Binance UI, and the endpoint costs weight on every call.
 *
 * Returns `null` when the mode cannot be determined: callers must decide (entries treat an
 * unknown mode as "let the exchange reject the order" — a rejected order is loud and safe, while
 * refusing to trade during an API blip is not always better). `__resetPositionModeCache` is a test
 * seam.
 */
export async function getPositionMode(creds: BinanceCreds): Promise<boolean | null> {
  const now = Date.now();
  if (positionModeCache.value !== null && now - positionModeCache.at < POSITION_MODE_TTL_MS) {
    return positionModeCache.value;
  }
  try {
    const { data } = await signedRequest<Json>(creds, 'GET', '/fapi/v1/positionSide/dual', {});
    const dual = data?.dualSidePosition;
    if (typeof dual === 'boolean') {
      positionModeCache = { at: now, value: dual };
      return dual;
    }
    if (typeof dual === 'string') {
      const parsed = dual.trim().toLowerCase() === 'true';
      positionModeCache = { at: now, value: parsed };
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Test seam: forget the cached position mode. */
export function __resetPositionModeCache(): void {
  positionModeCache = { at: 0, value: null };
}

export interface OrderAck {
  orderId: number | string;
  status: string;
  executedQty: number;
  avgPrice: number;
  clientOrderId?: string;
  raw: Json;
}

function toAck(raw: Json): OrderAck {
  return {
    orderId: (raw.orderId as number | string) ?? '',
    status: String(raw.status ?? 'UNKNOWN'),
    executedQty: parseFloat(String(raw.executedQty ?? '0')) || 0,
    avgPrice: parseFloat(String(raw.avgPrice ?? '0')) || 0,
    clientOrderId: raw.clientOrderId ? String(raw.clientOrderId) : undefined,
    raw,
  };
}

export async function setMarginTypeIsolated(creds: BinanceCreds, symbol: string): Promise<void> {
  try {
    await signedRequest(creds, 'POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' });
  } catch (err) {
    // -4046 "No need to change margin type" is the expected happy path for an already-isolated symbol.
    if (err instanceof BinanceApiError && err.code === -4046) return;
    throw err;
  }
}

export async function setLeverage(
  creds: BinanceCreds,
  symbol: string,
  leverage: number
): Promise<number> {
  const { data } = await signedRequest<Json>(creds, 'POST', '/fapi/v1/leverage', {
    symbol,
    leverage: String(leverage),
  });
  const applied = parseInt(String(data?.leverage ?? leverage), 10);
  return Number.isFinite(applied) ? applied : leverage;
}

export interface MarketOrderArgs {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  reduceOnly?: boolean;
  newClientOrderId?: string;
}

/**
 * Place a MARKET order and return the ack. `reduceOnly` is only legal on one-way-mode
 * positions; callers pass it explicitly for closes.
 */
export async function placeMarketOrder(creds: BinanceCreds, args: MarketOrderArgs): Promise<OrderAck> {
  const params: Record<string, string | boolean | undefined> = {
    symbol: args.symbol,
    side: args.side,
    type: 'MARKET',
    quantity: args.quantity,
    newClientOrderId: args.newClientOrderId,
  };
  if (args.reduceOnly) params.reduceOnly = 'true';
  const { data } = await signedRequest<Json>(creds, 'POST', '/fapi/v1/order', params);
  return toAck(data);
}

export interface BracketOrderArgs {
  symbol: string;
  side: 'BUY' | 'SELL';
  stopPrice: string;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  closePosition: boolean;
  quantity?: string;
  activationPrice?: string;
}

export async function placeBracketOrder(
  creds: BinanceCreds,
  args: BracketOrderArgs
): Promise<OrderAck> {
  const params: Record<string, string | number | boolean | undefined> = {
    symbol: args.symbol,
    side: args.side,
    type: args.type,
    stopPrice: args.stopPrice,
    workingType: 'MARK_PRICE',
    priceProtect: 'TRUE',
    closePosition: args.closePosition ? 'true' : 'false',
    timeInForce: 'GTC',
  };
  if (!args.closePosition && args.quantity) params.quantity = args.quantity;
  if (args.activationPrice) params.price = args.activationPrice;

  const { data } = await signedRequest<Json>(creds, 'POST', '/fapi/v1/order', params);
  return toAck(data);
}

export async function cancelOpenOrdersForSymbol(creds: BinanceCreds, symbol: string): Promise<void> {
  try {
    await signedRequest(creds, 'DELETE', '/fapi/v1/allOpenOrders', { symbol });
  } catch (err) {
    if (err instanceof BinanceApiError && (err.code === -2011 || err.code === -4046)) return;
    throw err;
  }
}

/** Poll the order once after a market fill to catch a status that was not terminal in the ack. */
export async function getOrderStatus(
  creds: BinanceCreds,
  symbol: string,
  orderId: number | string
): Promise<OrderAck | null> {
  try {
    const { data } = await signedRequest<Json>(creds, 'GET', '/fapi/v1/order', {
      symbol,
      orderId: String(orderId),
    });
    return toAck(data);
  } catch {
    return null;
  }
}

export interface ConditionalOrder {
  orderId: number | string;
  symbol: string;
  type: string;
  side: string;
  stopPrice: number;
  status: string;
}

/**
 * Live conditional orders for a symbol. The guardian loop uses this to answer a question the UI
 * never could: is the protective stop still on the book right now?
 */
export async function getConditionalOrders(creds: BinanceCreds, symbol?: string): Promise<ConditionalOrder[]> {
  const { data } = await signedRequest<Json[] | Json>(
    creds,
    'GET',
    '/fapi/v1/openOrders',
    symbol ? { symbol } : {}
  );
  const rows = Array.isArray(data) ? data : [];
  return rows.map((o) => ({
    orderId: (o.orderId as number | string) ?? '',
    symbol: String(o.symbol ?? ''),
    type: String(o.type ?? ''),
    side: String(o.side ?? ''),
    stopPrice: parseFloat(String(o.stopPrice ?? '0')) || 0,
    status: String(o.status ?? 'NEW'),
  }));
}

/**
 * Settled money for a trade window, straight from the income ledger: realized PnL plus commission
 * plus funding. This replaces the flat "0.1% of notional" fee estimate used for reported PnL.
 */
export async function getSettledPnlSince(
  creds: BinanceCreds,
  sinceMs: number,
  symbol?: string
): Promise<{ realized: number; commission: number; funding: number; net: number; rows: number } | null> {
  try {
    const params: Record<string, string | number> = { startTime: Math.floor(sinceMs), limit: 1000 };
    if (symbol) params.symbol = symbol;
    const { data } = await signedRequest<Json[]>(creds, 'GET', '/fapi/v1/income', params);
    if (!Array.isArray(data)) return null;
    let realized = 0;
    let commission = 0;
    let funding = 0;
    for (const row of data) {
      const amount = parseFloat(String(row.income ?? '0')) || 0;
      const type = String(row.incomeType ?? '');
      if (type === 'REALIZED_PNL') realized += amount;
      else if (type === 'COMMISSION') commission += amount;
      else if (type === 'FUNDING_FEE') funding += amount;
    }
    return {
      realized: Number(realized.toFixed(4)),
      commission: Number(commission.toFixed(4)),
      funding: Number(funding.toFixed(4)),
      net: Number((realized + commission + funding).toFixed(4)),
      rows: data.length,
    };
  } catch {
    // null = "could not settle from the exchange"; callers must fall back and label it as such.
    return null;
  }
}

/** Signed GET used by the account sync route; kept here so signing lives in exactly one file. */
export async function getIncome(
  creds: BinanceCreds,
  limit = 100
): Promise<{ income: number; incomeType: string }[]> {
  const { data } = await signedRequest<Json[]>(creds, 'GET', '/fapi/v1/income', {
    limit: String(limit),
  });
  if (!Array.isArray(data)) return [];
  return data.map((row) => ({
    income: parseFloat(String(row.income ?? '0')) || 0,
    incomeType: String(row.incomeType ?? ''),
  }));
}

export async function getExchangeInfoRaw(isTestnet: boolean): Promise<unknown> {
  const { data } = await publicGet<unknown>(isTestnet, '/fapi/v1/exchangeInfo', '', 6000);
  return data;
}
