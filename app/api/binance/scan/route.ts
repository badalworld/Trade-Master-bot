import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/trading-engine';
import { scanUniverse } from '@/lib/market-data';
import { loadRiskPolicy } from '@/lib/risk-policy';
import { sessionStatus } from '@/lib/trade-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only market scan (public data, no key needed). All indicator work lives in
 * `lib/market-data.ts`, shared with the engine loop so the browser and the server never score
 * different data. The network is taken from the session when one exists, so the scanner can only
 * ever propose setups the executor is able to trade.
 */
export async function GET(req: NextRequest) {
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
      failures: scan.failures,
      weightSource,
      tradeable: scan.tradeable,
      rateLimitStatus: checkRateLimit(usedWeight, 1200, safetyCapRatio),
      signals: scan.signals,
      candles: scan.candles,
    },
    {
      status: scan.ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    }
  );
}
