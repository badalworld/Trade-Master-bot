import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/trading-engine';
import { scanUniverse } from '@/lib/market-data';
import { loadRiskPolicy } from '@/lib/risk-policy';
import { sessionStatus } from '@/lib/trade-guard';
import { requireOperator } from '@/lib/operator-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only market scan (public data, no key needed). All indicator work lives in
 * `lib/market-data.ts`, shared with the engine loop so the browser and the server never score
 * different data. The network is taken from the session when one exists, so the scanner can only
 * ever propose setups the executor is able to trade.
 */
export async function GET(req: NextRequest) {
  // Only the app's own scanner calls this, and it is a fan-out of outbound requests on this
  // deployment's IP: leaving it open let anyone use the server as a Binance proxy. No-op when this
  // deployment needs no operator session.
  const operator = requireOperator(req);
  if (!operator.ok) {
    return NextResponse.json({ success: false, code: operator.code, error: operator.error }, { status: operator.httpStatus });
  }

  const policy = loadRiskPolicy();
  const status = sessionStatus(req);
  const isTestnet = status.active ? status.isTestnet : req.nextUrl.searchParams.get('testnet') !== 'false';

  const safetyCapParam = parseFloat(req.nextUrl.searchParams.get('safetyCap') || '95');
  const safetyCapRatio = !isNaN(safetyCapParam) && safetyCapParam > 0 ? safetyCapParam / 100 : 0.95;

  const scan = await scanUniverse({
    isTestnet,
    policy,
    pairs: req.nextUrl.searchParams.get('pairs')?.split(',') ?? [],
  });

  // If Binance sent no weight header we must not imply the budget is healthy; fall back to a
  // conservative estimate of the calls just made.
  const weightSource = scan.usedWeight > 0 ? 'header' : 'estimated';
  const usedWeight = scan.usedWeight > 0 ? scan.usedWeight : 5 * (scan.signals.length + scan.failures.length) + 1;

  return NextResponse.json(
    {
      timestamp: scan.timestamp,
      ok: scan.ok,
      network: isTestnet ? 'testnet' : 'mainnet',
      scanIntervalSeconds: 15,
      timeframe: '5m',
      signalsCount: scan.signals.length,
      /** Number of pairs attempted, so "N pairs returned no candles" can name the real total. */
      requestedPairs: scan.requestedPairs,
      failures: scan.failures,
      weightSource,
      tradeable: scan.tradeable,
      rateLimitStatus: checkRateLimit(usedWeight, 1200, safetyCapRatio),
      /** Stage-1 market ranking, so the UI can show what the whole market looked like. */
      board: scan.board,
      /** Universe + regime settings this scan actually applied (env, not client input). */
      universe: {
        discovered: scan.board.source === 'binance',
        deepScanned: scan.requestedPairs.length,
        /** Ranked liquid pairs that did not fit the shortlist this cycle (reported, not hidden). */
        shortlistSkipped: scan.shortlistSkipped,
        minQuoteVolumeUsdt: scan.board.minQuoteVolumeUsdt,
        volatilityBand: { minPercent: policy.scan.minVolatilityPercent, maxPercent: policy.scan.maxVolatilityPercent },
        chopFilter: { adxFloor: policy.scan.chopAdxFloor, efficiencyFloor: policy.scan.chopEfficiencyFloor },
        allowlist: policy.symbolAllowlist,
      },
      /** Pairs the funnel refused this cycle, by reason — makes "no setup" self-explaining. */
      skipped: scan.skipped,
      signals: scan.signals,
      candles: scan.candles,
    },
    {
      status: scan.ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    }
  );
}
