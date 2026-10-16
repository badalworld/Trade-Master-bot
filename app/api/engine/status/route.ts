import { NextResponse } from 'next/server';
import { engine } from '@/lib/engine';
import { ledger } from '@/lib/position-ledger';
import { loadRiskPolicy, policySummary } from '@/lib/risk-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Engine + ledger state for the dashboard.
 *
 * Requires the app's `X-TM-Request` header: position sizes are not secret material worth publishing
 * to the whole internet, and a custom header forces a CORS preflight that a cross-site reader
 * cannot satisfy.
 */
export async function GET(req: Request) {
  if (req.headers.get('x-tm-request') !== '1') {
    return NextResponse.json({ success: false, code: 'ORIGIN_REJECTED', error: 'Direct browsing of this endpoint is not allowed.' }, { status: 403 });
  }

  const snapshot = ledger.snapshot();
  const status = engine.getStatus();
  const positions = Object.values(snapshot.positions);

  return NextResponse.json(
    {
      success: true,
      engine: status,
      policy: policySummary(loadRiskPolicy()),
      ledger: {
        network: snapshot.network,
        updatedAt: snapshot.updatedAt,
        openPositions: positions.map((p) => ({
          id: p.id,
          symbol: p.symbol,
          side: p.side,
          quantity: p.quantity,
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          margin: p.margin,
          leverage: p.leverage,
          stopLoss: p.stopLoss,
          takeProfit: p.takeProfit,
          unrealizedPnl: p.unrealizedPnl,
          unrealizedPnlPercent: p.unrealizedPnlPercent,
          entryTime: p.entryTime,
          foreign: Boolean(p.foreign),
          unprotectedCycles: p.unprotectedCycles ?? 0,
        })),
        closedTrades: snapshot.closedTrades.slice(0, 200),
        totals: {
          closed: snapshot.closedTrades.length,
          realizedPnl: Number(snapshot.closedTrades.reduce((a, t) => a + t.pnl, 0).toFixed(4)),
          wins: snapshot.closedTrades.filter((t) => t.isWin).length,
        },
        compounding: snapshot.compounding,
        realizedPnlTodayUsdt: snapshot.realizedPnlTodayUsdt,
      },
      timestamp: Date.now(),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
