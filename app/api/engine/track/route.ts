import { NextRequest, NextResponse } from 'next/server';
import { getLivePositions } from '@/lib/binance-client';
import { ledger } from '@/lib/position-ledger';
import { roundCryptoPrice } from '@/lib/trading-engine';
import { checkRequestIntegrity, envCredentials } from '@/lib/trade-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Bridge between a UI-initiated trade and the unattended guardian.
 *
 * The engine only manages positions it can see in the ledger; without this, a trade opened from the
 * browser would be classified as "foreign" and left unguarded the moment the tab closed. Registering
 * it here means the same stop-loss re-arming and breach backstop applies to every position this app
 * opened, whoever opened it.
 */
/** Exchange order ids arrive as string or number; anything else is discarded rather than coerced. */
function asId(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 48);
  return undefined;
}

function clampNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function POST(req: NextRequest) {
  try {
    const integrity = checkRequestIntegrity(req);
    if (!integrity.ok) return NextResponse.json({ success: false, error: integrity.error }, { status: 403 });

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const symbol = String(body.symbol ?? '').toUpperCase();
    const side = String(body.side ?? '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    if (!symbol) return NextResponse.json({ success: false, error: 'symbol is required' }, { status: 400 });

    const entryPrice = clampNumber(body.entryPrice);
    const quantity = clampNumber(body.quantity);
    const stopLoss = clampNumber(body.stopLoss);
    const takeProfit = clampNumber(body.takeProfit);
    if (entryPrice <= 0 || quantity <= 0) {
      return NextResponse.json({ success: false, error: 'entryPrice and quantity must be positive' }, { status: 400 });
    }

    // If the exchange says this position does not exist, do not create a phantom row that the
    // guardian will then try to "protect".
    const env = envCredentials();
    if (env) {
      const live = await getLivePositions({ apiKey: env.apiKey, apiSecret: env.apiSecret, isTestnet: env.isTestnet })
        .then((all) => all.filter((p) => p.symbol === symbol))
        .catch(() => null);
      if (live && live.length === 0) {
        ledger.remove(symbol);
        return NextResponse.json(
          { success: false, code: 'NO_LIVE_POSITION', error: `${symbol} is not open on Binance, so nothing was tracked.` },
          { status: 409 }
        );
      }
    }

    const id = String(body.id ?? `ui-${symbol}-${Date.now()}`).slice(0, 48);
    ledger.upsert({
      id,
      symbol,
      side,
      entryPrice: roundCryptoPrice(entryPrice),
      markPrice: roundCryptoPrice(clampNumber(body.markPrice, entryPrice)),
      margin: clampNumber(body.margin, 2),
      leverage: Math.min(25, Math.max(1, clampNumber(body.leverage, 10))),
      quantity,
      stopLoss: stopLoss > 0 ? roundCryptoPrice(stopLoss) : 0,
      takeProfit: takeProfit > 0 ? roundCryptoPrice(takeProfit) : 0,
      unrealizedPnl: Number(body.unrealizedPnl) || 0,
      unrealizedPnlPercent: Number(body.unrealizedPnlPercent) || 0,
      entryTime: clampNumber(body.entryTime, Date.now()),
      orderId: asId(body.orderId),
      slOrderId: asId(body.slOrderId),
      tpOrderId: asId(body.tpOrderId),
      foreign: false,
      unprotectedCycles: 0,
    });
    ledger.flush();

    return NextResponse.json({
      success: true,
      tracked: symbol,
      guarded: stopLoss > 0,
      message:
        stopLoss > 0
          ? `${symbol} registered with the guardian: its stop-loss is re-armed and monitored on the server.`
          : `${symbol} registered, but with no stop level the guardian will only report it (it will not invent a stop).`,
      timestamp: Date.now(),
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 400 });
  }
}

/** Stop guarding a symbol locally (used after the UI closes a position it opened). */
export async function DELETE(req: NextRequest) {
  const integrity = checkRequestIntegrity(req);
  if (!integrity.ok) return NextResponse.json({ success: false, error: integrity.error }, { status: 403 });

  const symbol = (req.nextUrl.searchParams.get('symbol') ?? '').toUpperCase();
  if (!symbol) return NextResponse.json({ success: false, error: 'symbol query param is required' }, { status: 400 });

  const removed = ledger.remove(symbol);
  ledger.flush();
  return NextResponse.json({ success: true, untracked: symbol, wasTracked: Boolean(removed), timestamp: Date.now() });
}
