import { NextRequest, NextResponse } from 'next/server';
import {
  BinanceApiError,
  cancelOpenOrdersForSymbol,
  getAccount,
  getExchangeInfoRaw,
  getLivePositions,
  getOrderStatus,
  getRealizedPnlToday,
  placeBracketOrder,
  placeMarketOrder,
  setLeverage,
  setMarginTypeIsolated,
} from '@/lib/binance-client';
import { alignPriceToTick, buildSpecMap, computeOrderQuantity, resolveSpec, validateEntryBracket } from '@/lib/exchange-specs';
import { loadRiskPolicy, validateOpenRequest } from '@/lib/risk-policy';
import {
  checkRequestIntegrity,
  claimIdempotency,
  makeClientOrderId,
  releaseIdempotency,
  resolveCredentials,
} from '@/lib/trade-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * exchangeInfo is the only trustworthy source for LOT_SIZE / PRICE_FILTER / MIN_NOTIONAL.
 * If it cannot be fetched we fail closed: guessing a tick size is how a stop-loss gets rejected
 * for precision (-1111) and a leveraged position ends up naked.
 */
let specCache: { map: Record<string, ReturnType<typeof buildSpecMap>[string]>; at: number } | null = null;
const SPEC_TTL_MS = 10 * 60 * 1000;

async function getSpecMap(isTestnet: boolean) {
  const now = Date.now();
  if (specCache && now - specCache.at < SPEC_TTL_MS) return specCache.map;
  try {
    const info = await getExchangeInfoRaw(isTestnet);
    const map = buildSpecMap(info);
    if (Object.keys(map).length > 0) {
      specCache = { map, at: now };
      return map;
    }
  } catch {
    /* fall through to stale cache / unknown */
  }
  return specCache?.map ?? null;
}

const json = (payload: unknown, status = 200) => NextResponse.json(payload, { status });

const describeError = (err: unknown) => {
  if (err instanceof BinanceApiError) {
    return {
      error: err.message,
      binanceCode: err.code ?? null,
      httpStatus: err.httpStatus || null,
    };
  }
  const e = err as Error;
  return { error: e?.message || 'Execution error' };
};

/**
 * Mutable context shared with the outer catch. A timeout *after* the entry request left this server
 * is the one case where "the call failed" and "a position is open" are both true, so the handler
 * must be able to reconcile against the exchange instead of just reporting the error.
 */
interface AttemptContext {
  symbol?: string;
  entrySubmitted: boolean;
  slPrice?: string;
  exitSide?: 'BUY' | 'SELL';
  slOrderId?: number | string;
}

export async function POST(req: NextRequest) {
  let idempotencyKey: string | undefined;
  const ctx: AttemptContext = { entrySubmitted: false };

  try {
    const integrity = checkRequestIntegrity(req);
    if (!integrity.ok) return json({ success: false, error: integrity.error, code: 'ORIGIN_REJECTED' }, 403);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // Credentials are never accepted from the client body — that path is what leaked keys to
    // localStorage and made the endpoint an open trading relay.
    for (const forbidden of ['apiKey', 'apiSecret', 'isTestnet']) {
      if (body[forbidden] !== undefined) {
        return json(
          {
            success: false,
            code: 'CREDENTIALS_IN_BODY',
            error: `Do not send "${forbidden}" — credentials are resolved server-side from your session or BINANCE_API_KEY/BINANCE_API_SECRET.`,
          },
          400
        );
      }
    }

    const resolution = resolveCredentials(req);
    if (!resolution.ok) return json({ success: false, code: resolution.code, error: resolution.error }, resolution.status);
    const creds = resolution.creds;

    const action = String(body.action ?? 'OPEN').toUpperCase();
    const isClose = action === 'CLOSE';
    const symbol = String(body.symbol ?? '').toUpperCase();
    ctx.symbol = symbol;
    if (!symbol) return json({ success: false, error: 'Trading symbol is required.' }, 400);

    const policy = loadRiskPolicy();
    const specMap = await getSpecMap(creds.isTestnet);
    const spec = resolveSpec(symbol, specMap);

    // ---------------------------------------------------------------------
    // CLOSE — always permitted (closing reduces risk), even while halted.
    // ---------------------------------------------------------------------
    if (isClose) {
      const positions = await getLivePositions(creds);
      const live = positions.filter((p) => p.symbol === symbol);

      if (live.length === 0) {
        // Already flat (exchange bracket likely fired). Clear any stray conditional orders.
        await cancelOpenOrdersForSymbol(creds, symbol).catch(() => undefined);
        return json({
          success: true,
          action: 'CLOSE',
          symbol,
          noPosition: true,
          message: 'No open Binance position on this symbol — nothing to close. Stray TP/SL orders were cleared.',
          timestamp: Date.now(),
        });
      }

      let closedQty = 0;
      let weightedPrice = 0;
      const orderIds: (number | string)[] = [];

      // Close using the *exchange's* size, never the locally remembered one: closing a stale
      // quantity used to leave an unprotected residual position behind.
      for (const p of live) {
        const qty = computeOrderQuantity({
          requestedNotional: Math.abs(p.positionAmt) * p.markPrice,
          price: p.markPrice,
          spec,
          maxDeviationRatio: 100, // a close must not be refused for sizing reasons
        });
        const qtyStr = qty.ok ? qty.quantity : String(Math.abs(p.positionAmt));
        const finalQty = spec.known ? qtyStr : Math.abs(p.positionAmt).toFixed(8).replace(/0+$/, '');

        const side = p.side === 'LONG' ? 'SELL' : 'BUY';
        const ack = await placeMarketOrder(creds, {
          symbol,
          side,
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

      const avgClosePrice = closedQty > 0 ? weightedPrice / closedQty : 0;
      const residual = await getLivePositions(creds)
        .then((left) => left.filter((p) => p.symbol === symbol).reduce((a, p) => a + Math.abs(p.positionAmt), 0))
        .catch(() => 0);

      if (residual > 0) {
        return json(
          {
            success: false,
            action: 'CLOSE',
            symbol,
            error: `Position not fully flattened — ${residual} ${symbol} still open on Binance. Exchange TP/SL orders were cancelled; flatten manually or re-run close.`,
            closedQty,
            residualQty: residual,
            timestamp: Date.now(),
          },
          409
        );
      }

      return json({
        success: true,
        action: 'CLOSE',
        symbol,
        orderIds,
        executedQty: closedQty,
        avgPrice: avgClosePrice,
        closedFromExchange: true,
        timestamp: Date.now(),
      });
    }

    // ---------------------------------------------------------------------
    // OPEN — fully validated, fail-closed at every step.
    // ---------------------------------------------------------------------
    const normalizedSide = String(body.side ?? '').toUpperCase();
    const side: 'LONG' | 'SHORT' | null =
      normalizedSide === 'LONG' || normalizedSide === 'BUY'
        ? 'LONG'
        : normalizedSide === 'SHORT' || normalizedSide === 'SELL'
          ? 'SHORT'
          : null;
    if (!side) return json({ success: false, error: 'side must be LONG or SHORT.' }, 400);

    const margin = Number(body.margin);
    const leverage = Number(body.leverage ?? 10);
    const entryPrice = Number(body.price);
    const requestedSl = Number(body.stopLoss);
    const requestedTp = Number(body.takeProfit);

    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return json({ success: false, error: 'A valid positive market price is required.' }, 400);
    }
    if (!Number.isFinite(margin) || margin <= 0) {
      return json({ success: false, error: 'margin must be a positive number of USDT.' }, 400);
    }

    // --- Static policy first: reject without spending any API weight ----------------
    const staticCheck = validateOpenRequest(policy, {
      symbol,
      side,
      margin,
      leverage,
      // Exchange-derived facts are checked in the second pass below.
      openPositionsCount: 0,
      realizedPnlTodayUsdt: 0,
      isTestnet: creds.isTestnet,
    });
    if (!staticCheck.ok) {
      return json(
        {
          success: false,
          code: 'POLICY_BLOCKED',
          violations: staticCheck.violations,
          error: staticCheck.violations.map((v) => v.message).join(' '),
        },
        409
      );
    }

    // --- Live facts from the exchange (not from browser state) ------------
    const [account, livePositions, realizedToday] = await Promise.all([
      getAccount(creds),
      getLivePositions(creds),
      getRealizedPnlToday(creds),
    ]);

    if (!account.canTrade) {
      return json(
        { success: false, code: 'ACCOUNT_CANNOT_TRADE', error: 'Binance reports canTrade=false for this API key (permissions reduced, or account restricted).' },
        403
      );
    }

    const alreadyOpenOnSymbol = livePositions.some((p) => p.symbol === symbol);
    const violations = validateOpenRequest(policy, {
      symbol,
      side,
      margin,
      leverage,
      openPositionsCount: livePositions.length,
      realizedPnlTodayUsdt: Number.isFinite(realizedToday) ? realizedToday : 0,
      isTestnet: creds.isTestnet,
    });
    if (!violations.ok) {
      return json({ success: false, code: 'POLICY_BLOCKED', violations: violations.violations, error: violations.violations.map((v) => v.message).join(' ') }, 409);
    }
    if (Number.isFinite(realizedToday) && realizedToday <= -policy.maxDailyLossUsdt && policy.maxDailyLossUsdt > 0) {
      return json(
        { success: false, code: 'DAILY_LOSS_BREAKER', error: `Realized PnL today is $${realizedToday.toFixed(2)}; entries locked by the $${policy.maxDailyLossUsdt} daily loss breaker.` },
        409
      );
    }
    if (alreadyOpenOnSymbol) {
      // Replaces the browser-side dedupe that could race and stack a second live position.
      return json(
        { success: false, code: 'SYMBOL_ALREADY_OPEN', error: `${symbol} already has a live position on Binance. Adding-to-position is not part of this strategy.` },
        409
      );
    }

    const requiredMargin = (margin * leverage) / Math.max(1, leverage);
    if (account.availableBalance < requiredMargin * 1.1) {
      return json(
        { success: false, code: 'INSUFFICIENT_AVAILABLE_BALANCE', error: `Available balance $${account.availableBalance.toFixed(2)} cannot cover $${requiredMargin.toFixed(2)} margin plus a 10% buffer.` },
        409
      );
    }

    // --- Symbol filters + sizing -----------------------------------------
    if (!spec.known) {
      return json(
        {
          success: false,
          code: 'SPEC_UNKNOWN',
          error: `Could not load Binance exchange filters for ${symbol}; refusing to size an order or guess tick sizes. Retry when /fapi/v1/exchangeInfo is reachable.`,
        },
        422
      );
    }

    const sizing = computeOrderQuantity({
      requestedNotional: margin * leverage,
      price: entryPrice,
      spec,
      maxNotional: policy.maxNotionalUsdt,
      maxDeviationRatio: policy.maxNotionalDeviationRatio,
    });
    if (!sizing.ok) {
      return json(
        {
          success: false,
          code: sizing.code,
          error: sizing.message,
          minLegalNotional: sizing.minLegalNotional ?? null,
          hint: 'This pair cannot be traded at the requested size. Increase base margin or remove the pair from the scan list.',
        },
        422
      );
    }

    const alignedSl = alignPriceToTick(requestedSl, spec, 'stopLoss');
    if (!alignedSl.ok) return json({ success: false, code: 'SL_PRICE_INVALID', error: alignedSl.message }, 422);
    ctx.slPrice = alignedSl.price;
    const alignedTp = alignPriceToTick(requestedTp, spec, 'takeProfit');
    if (!alignedTp.ok) return json({ success: false, code: 'TP_PRICE_INVALID', error: alignedTp.message }, 422);

    const bracket = validateEntryBracket({
      side,
      entryPrice,
      slPrice: alignedSl.priceNum,
      tpPrice: alignedTp.priceNum,
      minRiskFraction: policy.minStopDistanceFraction,
    });
    if (!bracket.ok) return json({ success: false, code: 'BRACKET_INVALID', error: bracket.message }, 422);

    // --- Idempotency: one logical signal = one live order ----------------
    const nonce = String(body.idempotencyKey ?? body.clientNonce ?? '');
    const claim = claimIdempotency(nonce || undefined);
    if (!claim.claimed) {
      return json(
        { success: false, code: 'DUPLICATE_ORDER', error: `An order for idempotency key "${nonce}" was already submitted in this window and was not repeated.` },
        409
      );
    }
    idempotencyKey = claim.key;

    // --- Exchange pre-flight: margin type + leverage ---------------------
    await setMarginTypeIsolated(creds, symbol);

    const appliedLeverage = await setLeverage(creds, symbol, Math.trunc(leverage));
    if (appliedLeverage !== Math.trunc(leverage)) {
      releaseIdempotency(idempotencyKey);
      return json(
        { success: false, code: 'LEVERAGE_MISMATCH', error: `Binance applied ${appliedLeverage}x instead of ${leverage}x; liquidation distance differs from the plan, so the order was cancelled before submission.` },
        409
      );
    }

    // --- Entry -------------------------------------------------------------
    const entrySide = side === 'LONG' ? 'BUY' : 'SELL';
    const exitSide = side === 'LONG' ? 'SELL' : 'BUY';
    ctx.exitSide = exitSide;

    // From this line on, a thrown error may mean "the exchange already has our order".
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
      releaseIdempotency(idempotencyKey);
      await cancelOpenOrdersForSymbol(creds, symbol).catch(() => undefined);
      return json(
        {
          success: false,
          code: 'ORDER_NOT_FILLED',
          error: `Entry order was not filled (status=${status}, executedQty=${executedQty}). No position was opened and no bracket was placed.`,
          orderId: entryAck.orderId,
        },
        502
      );
    }

    const fillPrice = avgPrice > 0 ? avgPrice : entryPrice;
    const effectiveNotional = executedQty * fillPrice;
    const effectiveMargin = appliedLeverage > 0 ? effectiveNotional / appliedLeverage : margin;

    // --- Stop-loss: mandatory. No stop => flatten immediately. -----------
    let slOrderId: number | string | undefined;
    let slError: string | null = null;
    try {
      const slAck = await placeBracketOrder(creds, {
        symbol,
        side: exitSide,
        type: 'STOP_MARKET',
        stopPrice: alignedSl.price,
        closePosition: true,
      });
      slOrderId = slAck.orderId;
      ctx.slOrderId = slOrderId;
    } catch (err) {
      slError = err instanceof Error ? err.message : 'unknown error';
    }

    if (!slOrderId) {
      // The defect that used to leave a leveraged position unprotected with only a browser tab
      // watching it. Treat "no stop on the exchange" as a failed trade and unwind it now.
      let flattened = false;
      let flattenError: string | null = null;
      try {
        const qtyToClose = formatCloseQty(executedQty, spec.filters.stepSize, spec.filters.quantityPrecision);
        await placeMarketOrder(creds, {
          symbol,
          side: exitSide,
          quantity: qtyToClose,
          reduceOnly: true,
          newClientOrderId: makeClientOrderId('tmfl', symbol, `${Date.now()}`),
        });
        flattened = true;
      } catch (err) {
        flattenError = err instanceof Error ? err.message : 'unknown error';
      }
      await cancelOpenOrdersForSymbol(creds, symbol).catch(() => undefined);
      releaseIdempotency(idempotencyKey);

      return json(
        {
          success: false,
          code: 'STOP_LOSS_UNAVAILABLE',
          error: `Stop-loss order was rejected (${slError}). ${flattened ? 'The position was immediately flattened; no exposure remains.' : `WARNING: auto-flatten also failed (${flattenError}). A LIVE UNPROTECTED ${side} POSITION OF ${executedQty} ${symbol} EXISTS — close it manually on Binance now.`}`,
          symbol,
          side,
          executedQty,
          avgPrice: fillPrice,
          positionMayBeOpen: !flattened,
          autoFlattened: flattened,
        },
        502
      );
    }

    // --- Take-profit: desirable, its failure leaves SL protection intact --
    let tpOrderId: number | string | undefined;
    let tpError: string | null = null;
    try {
      const tpAck = await placeBracketOrder(creds, {
        symbol,
        side: exitSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: alignedTp.price,
        closePosition: true,
      });
      tpOrderId = tpAck.orderId;
    } catch (err) {
      tpError = err instanceof Error ? err.message : 'unknown error';
    }

    return json({
      success: true,
      action: 'OPEN',
      network: creds.isTestnet ? 'testnet' : 'mainnet',
      orderId: entryAck.orderId,
      symbol,
      side,
      orderSide: entrySide,
      status,
      leverage: appliedLeverage,
      marginType: 'ISOLATED',
      executedQty,
      avgPrice: fillPrice,
      // The ledger must book what the exchange actually did, not what the UI asked for.
      requestedNotional: Number((margin * leverage).toFixed(4)),
      effectiveNotional: Number(effectiveNotional.toFixed(4)),
      effectiveMargin: Number(effectiveMargin.toFixed(4)),
      sizingDeviationRatio: sizing.deviationRatio,
      sizingNotes: sizing.notes,
      stopLoss: alignedSl.priceNum,
      takeProfit: alignedTp.priceNum,
      slOrderId,
      tpOrderId: tpOrderId ?? null,
      bracketWarning: tpError ? `Take-profit order failed (${tpError}); position is protected by stop-loss only.` : null,
      clientOrderId: entryAck.clientOrderId,
      timestamp: Date.now(),
    });
  } catch (err) {
    const described = describeError(err);

    // Nothing was ever sent to the exchange: safe to release the idempotency claim and report.
    if (!ctx.entrySubmitted || !ctx.symbol) {
      if (idempotencyKey) releaseIdempotency(idempotencyKey);
      return json(
        {
          success: false,
          orderPlaced: false,
          error: described.error,
          ...('binanceCode' in described ? { binanceCode: described.binanceCode } : {}),
        },
        err instanceof BinanceApiError && err.httpStatus >= 500 ? 502 : 400
      );
    }

    // Ambiguous failure: ask the exchange what it actually did before telling the user anything.
    const credsNow = resolveCredentials(req);
    let found: Awaited<ReturnType<typeof getLivePositions>> = [];
    let exchangeVerified = false;

    for (let attempt = 0; credsNow.ok && attempt < 3; attempt++) {
      const polled = await getLivePositions(credsNow.creds)
        .then((all) => ({ ok: true as const, rows: all.filter((p) => p.symbol === ctx.symbol) }))
        .catch(() => ({ ok: false as const, rows: [] as Awaited<ReturnType<typeof getLivePositions>> }));
      if (!polled.ok) break;
      exchangeVerified = true;
      found = polled.rows;
      if (found.length > 0 || ctx.slOrderId !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }

    if (!exchangeVerified && ctx.slOrderId === undefined) {
      // We could not look, so we must not claim the account is flat.
      return json(
        {
          success: false,
          orderPlaced: true,
          stateVerified: false,
          code: 'UNVERIFIED_STATE',
          symbol: ctx.symbol,
          error: `${described.error} — the order may have reached Binance, and this server could not verify position state. Check the Binance app for an open ${ctx.symbol} position before retrying anything.`,
        },
        502
      );
    }

    if (exchangeVerified && found.length === 0) {
      if (idempotencyKey) releaseIdempotency(idempotencyKey);
      return json(
        {
          success: false,
          orderPlaced: false,
          stateVerified: true,
          reconciliation: 'CONFIRMED_FLAT',
          error: `${described.error} — re-checked the exchange; no ${ctx.symbol} position exists, so nothing is open.`,
        },
        502
      );
    }

    // A position exists. If it has no stop yet, attach one now, then report the truth.
    let recoveredSl = ctx.slOrderId ?? null;
    let recoveredError: string | null = null;
    if ((recoveredSl === undefined || recoveredSl === null) && credsNow.ok) {
      try {
        const resolution = credsNow;
        const spec = resolveSpec(ctx.symbol, await getSpecMap(resolution.creds.isTestnet));
        if (!spec.known || !ctx.slPrice || !ctx.exitSide) {
          throw new Error('Cannot build a protective stop without exchange filters or a valid stop price.');
        }
        const ack = await placeBracketOrder(resolution.creds, {
          symbol: ctx.symbol,
          side: ctx.exitSide,
          type: 'STOP_MARKET',
          stopPrice: ctx.slPrice,
          closePosition: true,
        });
        recoveredSl = ack.orderId;
      } catch (recoveryErr) {
        recoveredError = (recoveryErr as Error).message;
      }
    }

    return json(
      {
        success: recoveredSl !== null,
        orderPlaced: true,
        code: recoveredSl !== null ? 'RECOVERED_STOP_ATTACHED' : 'UNPROTECTED_POSITION',
        reconciliation: recoveredSl !== null ? 'STOP_ATTACHED' : 'STOP_FAILED',
        symbol: ctx.symbol,
        livePositions: found.map((p) => ({
          side: p.side,
          quantity: Math.abs(p.positionAmt),
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          unrealizedProfit: p.unrealizedProfit,
          leverage: p.leverage,
        })),
        slOrderId: recoveredSl,
        recoveryError: recoveredError,
        error:
          recoveredSl !== null
            ? `${described.error} — the position WAS found on Binance and a stop-loss (order ${recoveredSl}) was attached. Track it from Positions.`
            : `CRITICAL: ${described.error} — a LIVE ${ctx.symbol} POSITION IS OPEN WITH NO CONFIRMED STOP (${recoveredError}). Attach or honour a stop on Binance immediately.`,
        timestamp: Date.now(),
      },
      502
    );
  }
}



function formatCloseQty(value: number, step: number, precision: number): string {
  const units = Math.floor(value / step + 1e-9);
  const qty = Math.max(units, 1) * step;
  return Number(qty.toFixed(12)).toFixed(Math.max(0, precision));
}
