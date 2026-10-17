/**
 * The single implementation of "place an order on Binance, correctly".
 *
 * Everything money-touching lives here — sizing, brackets, fill verification, the mandatory
 * stop-loss, and reconciliation of ambiguous failures — so that the HTTP route (user clicks,
 * browser loop) and the server-side engine (unattended) cannot drift apart. Two copies of this
 * logic is exactly the bug factory the audit was written about.
 *
 * No Next.js imports: it takes credentials as an argument and returns a plain {status, body},
 * which keeps it unit-testable and usable from a background loop.
 */

import {
  type BinanceCreds,
  BinanceApiError,
  cancelOpenOrdersForSymbol,
  getAccount,
  getExchangeInfoRaw,
  getLivePositions,
  getOrderStatus,
  getPositionMode,
  getRealizedPnlToday,
  placeBracketOrder,
  placeMarketOrder,
  setLeverage,
  setMarginTypeIsolated,
  type LivePosition,
} from './binance-client.ts';
import {
  alignPriceToTick,
  buildSpecMap,
  computeOrderQuantity,
  formatQtyFallback,
  resolveSpec,
  validateEntryBracket,
  type SymbolFilters,
} from './exchange-specs.ts';
import {
  dailyLossGate,
  loadRiskPolicy,
  positionModeViolation,
  type RiskPolicy,
  validateOpenRequest,
  type Violation,
} from './risk-policy.ts';
import { claimIdempotency, makeClientOrderId, releaseIdempotency } from './trade-guard.ts';

export interface Executed<T extends { success: boolean }> {
  status: number;
  body: T;
}

export interface OpenIntent {
  symbol: string;
  side: 'LONG' | 'SHORT';
  margin: number;
  leverage: number;
  price: number;
  stopLoss: number;
  takeProfit: number;
  idempotencyKey?: string;
}

export interface OpenSuccess {
  success: true;
  action: 'OPEN';
  network: 'testnet' | 'mainnet';
  orderId: number | string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  orderSide: 'BUY' | 'SELL';
  status: string;
  leverage: number;
  marginType: 'ISOLATED';
  executedQty: number;
  avgPrice: number;
  requestedNotional: number;
  effectiveNotional: number;
  effectiveMargin: number;
  sizingDeviationRatio: number;
  sizingNotes: string[];
  stopLoss: number;
  takeProfit: number;
  slOrderId: number | string;
  tpOrderId: number | string | null;
  bracketWarning: string | null;
  clientOrderId?: string;
  timestamp: number;
}

export interface FailureBody {
  success: false;
  code: string;
  error: string;
  /** True when an order may have reached the exchange despite the failure. */
  orderPlaced: boolean;
  stateVerified?: boolean;
  reconciliation?: string;
  binanceCode?: number | null;
  violations?: Violation[];
  minLegalNotional?: number | null;
  hint?: string;
  symbol?: string;
  livePositions?: Array<{
    side: 'LONG' | 'SHORT';
    quantity: number;
    entryPrice: number;
    markPrice: number;
    unrealizedProfit: number;
    leverage: number;
  }>;
  slOrderId?: number | string | null;
  positionMayBeOpen?: boolean;
  autoFlattened?: boolean;
  orderId?: number | string;
  executedQty?: number;
  avgPrice?: number;
  timestamp?: number;
}

/**
 * Emitted only when an order possibly reached the exchange but the call failed: the outcome is
 * genuinely unresolved, so `success` is not a literal here.
 */
export interface RecoveryBody {
  success: boolean;
  orderPlaced: true;
  stateVerified: boolean;
  code: string;
  reconciliation: string;
  symbol: string;
  /** Everything the caller needs to ADOPT the position into its ledger instead of forgetting it. */
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  /** Tick-aligned stop that was re-attached, or null when no stop could be established. */
  stopLoss: number | null;
  livePositions: NonNullable<FailureBody['livePositions']>;
  slOrderId: number | string | null;
  positionMayBeOpen: boolean;
  recoveryError?: string | null;
  error: string;
  timestamp: number;
}

export interface CloseSuccess {
  success: true;
  action: 'CLOSE';
  symbol: string;
  orderIds: (number | string)[];
  executedQty: number;
  avgPrice: number;
  noPosition?: boolean;
  message?: string;
  closedFromExchange?: boolean;
  timestamp: number;
}

export interface CloseFailure extends FailureBody {
  action: 'CLOSE';
  closedQty?: number;
  residualQty?: number;
}

export type OpenResult = Executed<OpenSuccess | FailureBody | RecoveryBody>;
export type CloseResult = Executed<CloseSuccess | CloseFailure>;

// ---------------------------------------------------------------------------
// exchangeInfo cache — shared, fail-closed when unavailable
// ---------------------------------------------------------------------------

/**
 * Cached exchange filters, keyed by network. A single unkeyed cache would let testnet `tickSize` /
 * `minNotional` values be used to size a mainnet order the other way round, which is exactly the
 * class of mistake this file exists to prevent.
 */
type SpecCacheStore = Record<string, { map: Record<string, SymbolFilters>; at: number }>;
const specGlobal = globalThis as unknown as { __tmSpecCache?: SpecCacheStore };
const specCacheByNetwork: SpecCacheStore = specGlobal.__tmSpecCache ?? (specGlobal.__tmSpecCache = {});
const SPEC_TTL_MS = 10 * 60 * 1000;

export async function getSpecMap(isTestnet: boolean): Promise<Record<string, SymbolFilters> | null> {
  const key = isTestnet ? 'testnet' : 'mainnet';
  const now = Date.now();
  const cached = specCacheByNetwork[key];
  if (cached && now - cached.at < SPEC_TTL_MS) return cached.map;
  try {
    const map = buildSpecMap(await getExchangeInfoRaw(isTestnet));
    if (Object.keys(map).length > 0) {
      specCacheByNetwork[key] = { map, at: now };
      return map;
    }
  } catch {
    /* fall through to stale cache, then to "unknown" */
  }
  return specCacheByNetwork[key]?.map ?? null;
}

/** Test seam: inject filters without needing network access. */
export function __setSpecCache(map: Record<string, SymbolFilters> | null, isTestnet = true): void {
  if (map) specCacheByNetwork[isTestnet ? 'testnet' : 'mainnet'] = { map, at: Date.now() };
  else delete specCacheByNetwork[isTestnet ? 'testnet' : 'mainnet'];
}

const describeError = (err: unknown): { error: string; binanceCode?: number | null } => {
  if (err instanceof BinanceApiError) {
    return { error: err.message, binanceCode: err.code ?? null };
  }
  const e = err as Error;
  return { error: e?.message || 'Execution error' };
};

function formatCloseQty(value: number, step: number, precision: number): string {
  const units = Math.floor(value / step + 1e-9);
  const qty = Math.max(units, 1) * step;
  return Number(qty.toFixed(12)).toFixed(Math.max(0, precision));
}

// ---------------------------------------------------------------------------
// OPEN
// ---------------------------------------------------------------------------

export async function openPosition(
  creds: BinanceCreds,
  intent: OpenIntent,
  policy: RiskPolicy = loadRiskPolicy()
): Promise<OpenResult> {
  const symbol = String(intent.symbol ?? '').toUpperCase();
  let idempotencyKey: string | undefined;
  const ctx = { entrySubmitted: false, slPrice: undefined as string | undefined, exitSide: undefined as 'BUY' | 'SELL' | undefined, slOrderId: undefined as number | string | undefined };

  const fail = (status: number, body: Omit<FailureBody, 'success' | 'orderPlaced'> & { orderPlaced?: boolean }): OpenResult => {
    if (body.orderPlaced !== true && idempotencyKey) {
      releaseIdempotency(idempotencyKey);
      idempotencyKey = undefined;
    }
    return { status, body: { success: false, orderPlaced: false, ...body } as FailureBody };
  };

  try {
    if (!symbol) return fail(400, { code: 'SYMBOL_REQUIRED', error: 'Trading symbol is required.' });

    const spec = resolveSpec(symbol, await getSpecMap(creds.isTestnet));

    const staticCheck = validateOpenRequest(policy, {
      symbol,
      side: intent.side,
      margin: intent.margin,
      leverage: intent.leverage,
      // Exchange-derived facts are checked in the second pass below.
      openPositionsCount: 0,
      realizedPnlTodayUsdt: 0,
      isTestnet: creds.isTestnet,
    });
    if (!staticCheck.ok) {
      return fail(409, {
        code: 'POLICY_BLOCKED',
        violations: staticCheck.violations,
        error: staticCheck.violations.map((v) => v.message).join(' '),
      });
    }

    if (!Number.isFinite(intent.price) || intent.price <= 0) {
      return fail(400, { code: 'PRICE_INVALID', error: 'A valid positive market price is required.' });
    }
    if (!Number.isFinite(intent.margin) || intent.margin <= 0) {
      return fail(400, { code: 'MARGIN_INVALID', error: 'margin must be a positive number of USDT.' });
    }

    // --- Live facts from the exchange (never from browser state) ---------
    const [account, livePositions, realizedToday, dualSide] = await Promise.all([
      getAccount(creds),
      getLivePositions(creds),
      getRealizedPnlToday(creds),
      getPositionMode(creds),
    ]);

    if (!account.canTrade) {
      return fail(403, {
        code: 'ACCOUNT_CANNOT_TRADE',
        error: 'Binance reports canTrade=false for this API key (permissions reduced, or account restricted).',
      });
    }

    // Hedge Mode would reject this bot's orders (no positionSide, reduceOnly closes). `null` means
    // the mode could not be read: the order is then left to fail loudly at the exchange rather than
    // blocking entries on a metadata hiccup.
    const modeViolation = positionModeViolation(dualSide === true);
    if (modeViolation) {
      return fail(409, { code: 'POLICY_BLOCKED', violations: [modeViolation], error: modeViolation.message });
    }

    // Fail-closed daily loss breaker: an unreadable income endpoint locks entries instead of being
    // silently treated as "no loss today" (the previous behaviour).
    const lossGate = dailyLossGate(policy, Number.isFinite(realizedToday) ? realizedToday : null);
    if (!lossGate.ok) {
      return fail(409, { code: lossGate.code, error: lossGate.message });
    }

    const violations = validateOpenRequest(policy, {
      symbol,
      side: intent.side,
      margin: intent.margin,
      leverage: intent.leverage,
      openPositionsCount: livePositions.length,
      realizedPnlTodayUsdt: Number.isFinite(realizedToday) ? realizedToday : 0,
      isTestnet: creds.isTestnet,
    });
    if (!violations.ok) {
      return fail(409, { code: 'POLICY_BLOCKED', violations: violations.violations, error: violations.violations.map((v) => v.message).join(' ') });
    }
    if (livePositions.some((p) => p.symbol === symbol)) {
      return fail(409, {
        code: 'SYMBOL_ALREADY_OPEN',
        error: `${symbol} already has a live position on Binance. Adding-to-position is not part of this strategy.`,
      });
    }

    const requiredMargin = intent.margin;
    if (account.availableBalance < requiredMargin * 1.1) {
      return fail(409, {
        code: 'INSUFFICIENT_AVAILABLE_BALANCE',
        error: `Available balance $${account.availableBalance.toFixed(2)} cannot cover $${requiredMargin.toFixed(2)} margin plus a 10% buffer.`,
      });
    }

    // --- Filters + sizing (fail closed rather than guess) ----------------
    if (!spec.known) {
      return fail(422, {
        code: 'SPEC_UNKNOWN',
        symbol,
        error: `Could not load Binance exchange filters for ${symbol}; refusing to size an order or guess tick sizes. Retry when /fapi/v1/exchangeInfo is reachable.`,
      });
    }

    const sizing = computeOrderQuantity({
      requestedNotional: intent.margin * intent.leverage,
      price: intent.price,
      spec,
      maxNotional: policy.maxNotionalUsdt,
      maxDeviationRatio: policy.maxNotionalDeviationRatio,
    });
    if (!sizing.ok) {
      return fail(422, {
        code: sizing.code,
        error: sizing.message,
        minLegalNotional: sizing.minLegalNotional ?? null,
        hint: 'This pair cannot be traded at the requested size. Increase base margin or remove the pair from the scan list.',
      });
    }

    const alignedSl = alignPriceToTick(intent.stopLoss, spec, 'stopLoss');
    if (!alignedSl.ok) return fail(422, { code: 'SL_PRICE_INVALID', error: alignedSl.message });
    const alignedTp = alignPriceToTick(intent.takeProfit, spec, 'takeProfit');
    if (!alignedTp.ok) return fail(422, { code: 'TP_PRICE_INVALID', error: alignedTp.message });

    const bracket = validateEntryBracket({
      side: intent.side,
      entryPrice: intent.price,
      slPrice: alignedSl.priceNum,
      tpPrice: alignedTp.priceNum,
      minRiskFraction: policy.minStopDistanceFraction,
    });
    if (!bracket.ok) return fail(422, { code: 'BRACKET_INVALID', error: bracket.message });

    ctx.slPrice = alignedSl.price;
    ctx.exitSide = intent.side === 'LONG' ? 'SELL' : 'BUY';

    // --- Idempotency: one logical signal = one live order ----------------
    const nonce = String(intent.idempotencyKey ?? '');
    const claim = claimIdempotency(nonce || undefined);
    if (!claim.claimed) {
      return {
        status: 409,
        body: {
          success: false,
          orderPlaced: false,
          code: 'DUPLICATE_ORDER',
          error: `An order for idempotency key "${nonce}" was already submitted in this window and was not repeated.`,
        },
      };
    }
    idempotencyKey = claim.key;

    // --- Exchange pre-flight --------------------------------------------
    await setMarginTypeIsolated(creds, symbol);
    const appliedLeverage = await setLeverage(creds, symbol, Math.trunc(intent.leverage));
    if (appliedLeverage !== Math.trunc(intent.leverage)) {
      return fail(409, {
        code: 'LEVERAGE_MISMATCH',
        error: `Binance applied ${appliedLeverage}x instead of ${intent.leverage}x; liquidation distance differs from the plan, so the order was not submitted.`,
      });
    }

    const entrySide: 'BUY' | 'SELL' = intent.side === 'LONG' ? 'BUY' : 'SELL';
    const exitSide = ctx.exitSide;

    // From here on, a thrown error can mean "the exchange already has our order".
    ctx.entrySubmitted = true;

    const entryAck = await placeMarketOrder(creds, {
      symbol,
      side: entrySide,
      quantity: sizing.quantity,
      newClientOrderId: makeClientOrderId('tm', symbol, nonce || `${Date.now()}${Math.random()}`),
    });

    let status = entryAck.status;
    let executedQty = entryAck.executedQty;
    let avgPrice = entryAck.avgPrice;

    if (status !== 'FILLED' || executedQty <= 0) {
      const recheck = await getOrderStatus(creds, symbol, entryAck.orderId);
      if (recheck) {
        status = recheck.status;
        executedQty = recheck.executedQty || executedQty;
        avgPrice = recheck.avgPrice || avgPrice;
      }
    }

    if (status !== 'FILLED' || executedQty <= 0) {
      await cancelOpenOrdersForSymbol(creds, symbol).catch(() => undefined);
      return fail(502, {
        code: 'ORDER_NOT_FILLED',
        orderId: entryAck.orderId,
        error: `Entry order was not filled (status=${status}, executedQty=${executedQty}). No position was opened and no bracket was placed.`,
      });
    }

    const fillPrice = avgPrice > 0 ? avgPrice : intent.price;
    const effectiveNotional = executedQty * fillPrice;
    const effectiveMargin = appliedLeverage > 0 ? effectiveNotional / appliedLeverage : intent.margin;

    // --- Stop-loss is mandatory: no stop => flatten immediately ----------
    let slError: string | null = null;
    try {
      const slAck = await placeBracketOrder(creds, {
        symbol,
        side: exitSide,
        type: 'STOP_MARKET',
        stopPrice: alignedSl.price,
        closePosition: true,
      });
      ctx.slOrderId = slAck.orderId;
    } catch (err) {
      slError = err instanceof Error ? err.message : 'unknown error';
    }

    if (ctx.slOrderId === undefined) {
      // Don't auto-flatten when SL placement fails — the guardian will retry next cycle.
      // Trades must only close via TP or SL, not because of order placement errors.
      await cancelOpenOrdersForSymbol(creds, symbol).catch(() => undefined);

      return fail(502, {
        code: 'STOP_LOSS_UNAVAILABLE',
        symbol,
        orderPlaced: true,
        positionMayBeOpen: true,
        autoFlattened: false,
        executedQty,
        avgPrice: fillPrice,
        slOrderId: null,
        error: `Stop-loss order was rejected (${slError}). Position left open — guardian will retry stop placement next cycle.`,
      });
    }

    // --- Take-profit: desirable; its failure leaves the stop intact ------
    let tpOrderId: number | string | null = null;
    let tpError: string | null = null;
    try {
      tpOrderId = (
        await placeBracketOrder(creds, {
          symbol,
          side: exitSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: alignedTp.price,
          closePosition: true,
        })
      ).orderId;
    } catch (err) {
      tpError = err instanceof Error ? err.message : 'unknown error';
    }

    if (idempotencyKey) releaseIdempotency(idempotencyKey);

    return {
      status: 200,
      body: {
        success: true,
        action: 'OPEN',
        network: creds.isTestnet ? 'testnet' : 'mainnet',
        orderId: entryAck.orderId,
        symbol,
        side: intent.side,
        orderSide: entrySide,
        status,
        leverage: appliedLeverage,
        marginType: 'ISOLATED',
        executedQty,
        avgPrice: fillPrice,
        // Book what the exchange actually did, not what was requested.
        requestedNotional: Number((intent.margin * intent.leverage).toFixed(4)),
        effectiveNotional: Number(effectiveNotional.toFixed(4)),
        effectiveMargin: Number(effectiveMargin.toFixed(4)),
        sizingDeviationRatio: sizing.deviationRatio,
        sizingNotes: sizing.notes,
        stopLoss: alignedSl.priceNum,
        takeProfit: alignedTp.priceNum,
        slOrderId: ctx.slOrderId,
        tpOrderId,
        bracketWarning: tpError ? `Take-profit order failed (${tpError}); position is protected by stop-loss only.` : null,
        clientOrderId: entryAck.clientOrderId,
        timestamp: Date.now(),
      } as OpenSuccess,
    };
  } catch (err) {
    const described = describeError(err);

    // Nothing was ever sent: safe to release the claim and report a clean failure.
    if (!ctx.entrySubmitted) {
      if (idempotencyKey) releaseIdempotency(idempotencyKey);
      return {
        status: err instanceof BinanceApiError && err.httpStatus >= 500 ? 502 : 400,
        body: {
          success: false,
          orderPlaced: false,
          code: 'EXECUTION_ERROR',
          error: described.error,
          binanceCode: described.binanceCode ?? null,
        },
      };
    }

    // Ambiguous: ask the exchange what it actually did before claiming anything.
    let found: LivePosition[] = [];
    let exchangeVerified = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const polled = await getLivePositions(creds)
        .then((all) => ({ ok: true as const, rows: all.filter((p) => p.symbol === symbol) }))
        .catch(() => ({ ok: false as const, rows: [] as LivePosition[] }));
      if (!polled.ok) break;
      exchangeVerified = true;
      found = polled.rows;
      if (found.length > 0 || ctx.slOrderId !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }

    if (!exchangeVerified && ctx.slOrderId === undefined) {
      return {
        status: 502,
        body: {
          success: false,
          orderPlaced: true,
          stateVerified: false,
          code: 'UNVERIFIED_STATE',
          symbol,
          error: `${described.error} — the order may have reached Binance, and position state could not be verified. Check the Binance app for an open ${symbol} position before retrying anything.`,
        },
      };
    }

    if (exchangeVerified && found.length === 0) {
      if (idempotencyKey) releaseIdempotency(idempotencyKey);
      return {
        status: 502,
        body: {
          success: false,
          orderPlaced: false,
          stateVerified: true,
          code: 'CONFIRMED_FLAT',
          reconciliation: 'CONFIRMED_FLAT',
          symbol,
          error: `${described.error} — re-checked the exchange; no ${symbol} position exists, so nothing is open.`,
        },
      };
    }

    // A position exists. Attach a stop if it lacks one, then report the truth.
    let recoveredSl = ctx.slOrderId ?? null;
    let recoveredError: string | null = null;
    if (recoveredSl === null) {
      try {
        const spec = resolveSpec(symbol, await getSpecMap(creds.isTestnet));
        if (!spec.known || !ctx.slPrice || !ctx.exitSide) {
          throw new Error('cannot build a protective stop without exchange filters or a valid stop price');
        }
        recoveredSl = (
          await placeBracketOrder(creds, {
            symbol,
            side: ctx.exitSide,
            type: 'STOP_MARKET',
            stopPrice: ctx.slPrice,
            closePosition: true,
          })
        ).orderId;
      } catch (recoveryErr) {
        recoveredError = (recoveryErr as Error).message;
      }
    }

    const recoveredAction = found[0];
    return {
      status: 502,
      body: {
        success: recoveredSl !== null,
        orderPlaced: true,
        stateVerified: true,
        code: recoveredSl !== null ? 'RECOVERED_STOP_ATTACHED' : 'UNPROTECTED_POSITION',
        reconciliation: recoveredSl !== null ? 'STOP_ATTACHED' : 'STOP_FAILED',
        symbol,
        // Enough for the caller to adopt the position into its own ledger: without this, an
        // ambiguous entry that turned out to be filled was "protected but forgotten" — the engine
        // had no ledger row, so it never re-armed the stop or settled the trade.
        side: recoveredAction ? recoveredAction.side : intent.side,
        entryPrice: recoveredAction && recoveredAction.entryPrice > 0 ? recoveredAction.entryPrice : intent.price,
        quantity: recoveredAction ? Math.abs(recoveredAction.positionAmt) : 0,
        stopLoss: ctx.slPrice ? Number(ctx.slPrice) : null,
        livePositions: found.map((p) => ({
          side: p.side,
          quantity: Math.abs(p.positionAmt),
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          unrealizedProfit: p.unrealizedProfit,
          leverage: p.leverage,
        })),
        slOrderId: recoveredSl,
        positionMayBeOpen: recoveredSl === null,
        error:
          recoveredSl !== null
            ? `${described.error} — the position WAS found on Binance and a stop-loss (order ${recoveredSl}) was attached.`
            : `CRITICAL: ${described.error} — a LIVE ${symbol} POSITION IS OPEN WITH NO CONFIRMED STOP (${recoveredError}). Attach or honour a stop on Binance immediately.`,
        timestamp: Date.now(),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// CLOSE — always permitted, including while entries are halted
// ---------------------------------------------------------------------------

export async function closePosition(
  creds: BinanceCreds,
  intent: { symbol: string }
): Promise<CloseResult> {
  const symbol = String(intent.symbol ?? '').toUpperCase();
  try {
    if (!symbol) {
      return { status: 400, body: { success: false, orderPlaced: false, action: 'CLOSE', code: 'SYMBOL_REQUIRED', error: 'Trading symbol is required.' } };
    }

    const spec = resolveSpec(symbol, await getSpecMap(creds.isTestnet));
    const live = (await getLivePositions(creds)).filter((p) => p.symbol === symbol);

    if (live.length === 0) {
      await cancelOpenOrdersForSymbol(creds, symbol).catch(() => undefined);
      return {
        status: 200,
        body: {
          success: true,
          action: 'CLOSE',
          symbol,
          orderIds: [],
          executedQty: 0,
          avgPrice: 0,
          noPosition: true,
          message: 'No open Binance position on this symbol — nothing to close. Stray TP/SL orders were cleared.',
          timestamp: Date.now(),
        },
      };
    }

    let closedQty = 0;
    let weightedPrice = 0;
    const orderIds: (number | string)[] = [];

    // Size from the exchange, never from a remembered number: a stale quantity used to leave an
    // unprotected residual behind after the brackets were cancelled.
    for (const p of live) {
      const qty = computeOrderQuantity({
        requestedNotional: Math.abs(p.positionAmt) * p.markPrice,
        price: p.markPrice,
        spec,
        maxDeviationRatio: 100,
      });
      const finalQty =
        qty.ok && spec.known
          ? qty.quantity
          : formatQtyFallback(Math.abs(p.positionAmt));

      const ack = await placeMarketOrder(creds, {
        symbol,
        side: p.side === 'LONG' ? 'SELL' : 'BUY',
        quantity: finalQty,
        reduceOnly: true,
        newClientOrderId: makeClientOrderId('tmcl', symbol, `${Date.now()}${Math.random()}`),
      });
      orderIds.push(ack.orderId);
      const execQty = ack.executedQty > 0 ? ack.executedQty : Math.abs(p.positionAmt);
      const px = ack.avgPrice > 0 ? ack.avgPrice : p.markPrice;
      closedQty += execQty;
      weightedPrice += execQty * px;
    }

    await cancelOpenOrdersForSymbol(creds, symbol).catch(() => undefined);

    const residual = await getLivePositions(creds)
      .then((left) => left.filter((p) => p.symbol === symbol).reduce((a, p) => a + Math.abs(p.positionAmt), 0))
      .catch(() => -1);

    if (residual > 0) {
      return {
        status: 409,
        body: {
          success: false,
          orderPlaced: true,
          action: 'CLOSE',
          code: 'RESIDUAL_POSITION',
          symbol,
          closedQty,
          residualQty: residual,
          error: `Position not fully flattened — ${residual} ${symbol} still open on Binance. Exchange TP/SL orders were cancelled; flatten manually or re-run close.`,
          timestamp: Date.now(),
        },
      };
    }

    return {
      status: 200,
      body: {
        success: true,
        action: 'CLOSE',
        symbol,
        orderIds,
        executedQty: closedQty,
        avgPrice: closedQty > 0 ? Number((weightedPrice / closedQty).toFixed(8)) : 0,
        closedFromExchange: true,
        timestamp: Date.now(),
      },
    };
  } catch (err) {
    const described = describeError(err);
    return {
      status: err instanceof BinanceApiError && err.httpStatus >= 500 ? 502 : 400,
      body: {
        success: false,
        orderPlaced: false,
        action: 'CLOSE',
        code: 'CLOSE_ERROR',
        symbol,
        error: described.error,
        binanceCode: described.binanceCode ?? null,
        timestamp: Date.now(),
      },
    };
  }
}
