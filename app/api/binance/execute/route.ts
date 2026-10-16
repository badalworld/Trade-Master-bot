import { NextRequest, NextResponse } from 'next/server';
import { closePosition, openPosition, type OpenIntent } from '@/lib/order-executor';
import { checkRequestIntegrity, resolveCredentials } from '@/lib/trade-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Thin HTTP shell over `lib/order-executor`.
 *
 * The route deliberately contains no trading logic: the browser loop and the unattended server
 * engine must run the exact same code path, so the money handling lives in exactly one module.
 */
export async function POST(req: NextRequest) {
  try {
    const integrity = checkRequestIntegrity(req);
    if (!integrity.ok) {
      return NextResponse.json({ success: false, error: integrity.error, code: 'ORIGIN_REJECTED' }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // Credentials never come from the client body — that was the path that leaked them into
    // localStorage and turned this endpoint into an open trading relay.
    for (const forbidden of ['apiKey', 'apiSecret', 'isTestnet']) {
      if (body[forbidden] !== undefined) {
        return NextResponse.json(
          {
            success: false,
            code: 'CREDENTIALS_IN_BODY',
            error: `Do not send "${forbidden}" — credentials are resolved server-side from your session or BINANCE_API_KEY/BINANCE_API_SECRET.`,
          },
          { status: 400 }
        );
      }
    }

    const resolution = resolveCredentials(req);
    if (!resolution.ok) {
      return NextResponse.json({ success: false, code: resolution.code, error: resolution.error }, { status: resolution.status });
    }

    const action = String(body.action ?? 'OPEN').toUpperCase();

    if (action === 'CLOSE') {
      const result = await closePosition(resolution.creds, { symbol: String(body.symbol ?? '') });
      return NextResponse.json(result.body, { status: result.status });
    }

    // Explicit direction parsing: a typo must never silently flip a short into a long.
    const rawSide = String(body.side ?? '').toUpperCase();
    if (!['LONG', 'BUY', 'SHORT', 'SELL'].includes(rawSide)) {
      return NextResponse.json(
        { success: false, orderPlaced: false, code: 'SIDE_INVALID', error: `side must be LONG or SHORT (got "${body.side ?? ''}").` },
        { status: 400 }
      );
    }

    const intent: OpenIntent = {
      symbol: String(body.symbol ?? ''),
      side: rawSide === 'SHORT' || rawSide === 'SELL' ? 'SHORT' : 'LONG',
      margin: Number(body.margin),
      leverage: Number(body.leverage ?? 10),
      price: Number(body.price),
      stopLoss: Number(body.stopLoss),
      takeProfit: Number(body.takeProfit),
      idempotencyKey: body.idempotencyKey !== undefined ? String(body.idempotencyKey) : undefined,
    };

    const result = await openPosition(resolution.creds, intent);
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    const e = err as Error;
    return NextResponse.json(
      { success: false, orderPlaced: false, code: 'ROUTE_ERROR', error: e.message || 'Execution error' },
      { status: 400 }
    );
  }
}
