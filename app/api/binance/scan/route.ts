import { NextRequest, NextResponse } from 'next/server';
import {
  evaluate3IndicatorSignal,
  checkRateLimit,
  type Candle,
  type SignalEvaluation,
} from '@/lib/trading-engine';
import { publicGet } from '@/lib/binance-client';
import { buildSpecMap } from '@/lib/exchange-specs';
import { DEFAULT_SCANNED_SYMBOLS, loadRiskPolicy } from '@/lib/risk-policy';
import { sessionStatus } from '@/lib/trade-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PAIRS = 12;

interface PairOutcome {
  pair: string;
  candles: Candle[];
  weight: number;
  error?: string;
}

async function fetchPairCandles(isTestnet: boolean, pair: string): Promise<PairOutcome> {
  // A delisted/renamed ticker (PEPE vs 1000PEPE) is a data problem, not a strategy signal.
  const symbolsToTry = pair === 'PEPEUSDT' ? ['1000PEPEUSDT', 'PEPEUSDT'] : [pair];
  let highestWeight = 0;
  let lastError = 'no data';

  for (const sym of symbolsToTry) {
    try {
      const { data, usedWeight } = await publicGet<unknown[]>(
        isTestnet,
        '/fapi/v1/klines',
        `?symbol=${encodeURIComponent(sym)}&interval=5m&limit=40`,
        4000
      );
      if (typeof usedWeight === 'number' && usedWeight > highestWeight) highestWeight = usedWeight;

      if (!Array.isArray(data) || data.length < 25) {
        lastError = `only ${Array.isArray(data) ? data.length : 0} candles returned`;
        continue;
      }
      const now = Date.now();
      const candles: Candle[] = data.map((item) => {
        const row = item as (number | string)[];
        return {
          time: Number(row[0]),
          open: parseFloat(String(row[1])),
          high: parseFloat(String(row[2])),
          low: parseFloat(String(row[3])),
          close: parseFloat(String(row[4])),
          volume: parseFloat(String(row[5])),
          takerBuyVolume: row[9] !== undefined ? parseFloat(String(row[9])) : undefined,
          isClosed: row[6] !== undefined ? now >= Number(row[6]) : true,
        };
      });

      const usable = candles.filter((c) =>
        [c.open, c.high, c.low, c.close, c.volume].every((v) => Number.isFinite(v))
      );
      if (usable.length < 25) {
        lastError = `${usable.length}/${candles.length} candles passed numeric validation`;
        continue;
      }

      return { pair, candles: usable, weight: highestWeight };
    } catch (err) {
      lastError = (err as Error).message || 'fetch failed';
    }
  }

  return { pair, candles: [], weight: highestWeight, error: lastError };
}

export async function GET(req: NextRequest) {
  const policy = loadRiskPolicy();
  const status = sessionStatus(req);

  // Market data needs no key, but the scanner must evaluate the *same* market the executor trades.
  const isTestnet = status.active ? status.isTestnet : req.nextUrl.searchParams.get('testnet') !== 'false';
  const safetyCapParam = parseFloat(req.nextUrl.searchParams.get('safetyCap') || '95');
  const safetyCapRatio = !isNaN(safetyCapParam) && safetyCapParam > 0 ? safetyCapParam / 100 : 0.95;

  const requested = req.nextUrl.searchParams.get('pairs')?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const allowlist = policy.symbolAllowlist.length > 0 ? policy.symbolAllowlist : [...DEFAULT_SCANNED_SYMBOLS];
  // Never propose a symbol the executor would refuse, and never scan beyond the policy allowlist.
  const targetPairs = (requested && requested.length ? requested : allowlist)
    .filter((p) => policy.symbolAllowlist.length === 0 || allowlist.includes(p))
    .slice(0, Math.min(MAX_PAIRS, policy.maxOpenPositions * 8));

  const results = await Promise.allSettled(targetPairs.map((pair) => fetchPairCandles(isTestnet, pair)));

  const outcomes: PairOutcome[] = results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { pair: targetPairs[i], candles: [], weight: 0, error: String(r.reason) }
  );

  let usedWeight = 0;
  const evaluatedSignals: SignalEvaluation[] = [];
  const rawCandlesMap: Record<string, Candle[]> = {};
  const failures: { pair: string; error: string }[] = [];

  for (const { pair, candles, weight, error } of outcomes) {
    if (weight > usedWeight) usedWeight = weight;
    if (candles.length >= 25) {
      rawCandlesMap[pair] = candles;
      evaluatedSignals.push(evaluate3IndicatorSignal(pair, candles));
    } else {
      failures.push({ pair, error: error || 'insufficient candles' });
    }
  }

  // Binance reports IP weight per key/IP bucket; if the header is missing we must not pretend the
  // budget is healthy, so fall back to a conservative accumulated estimate.
  const weightSource = usedWeight > 0 ? 'header' : 'estimated';
  if (usedWeight === 0) usedWeight = 5 * targetPairs.length + 1;

  evaluatedSignals.sort((a, b) => {
    if (Math.abs(b.volatilityPercent - a.volatilityPercent) > 0.05) return b.volatilityPercent - a.volatilityPercent;
    return b.score - a.score;
  });

  // Exchange filters decide whether a signal is even *tradeable* at the configured size.
  let tradeable: Record<string, boolean> = {};
  try {
    const info = await publicGet<unknown>(isTestnet, '/fapi/v1/exchangeInfo', '', 6000);
    const map = buildSpecMap(info);
    for (const sig of evaluatedSignals) {
      tradeable[sig.symbol] = Boolean(map?.[sig.symbol]);
    }
  } catch {
    for (const sig of evaluatedSignals) tradeable[sig.symbol] = true;
  }

  const rateLimitStatus = checkRateLimit(usedWeight, 1200, safetyCapRatio);

  return NextResponse.json(
    {
      timestamp: Date.now(),
      ok: evaluatedSignals.length > 0,
      network: isTestnet ? 'testnet' : 'mainnet',
      scanIntervalSeconds: 15,
      timeframe: '5m',
      requestedPairs: targetPairs,
      signalsCount: evaluatedSignals.length,
      failures,
      weightSource,
      tradeable,
      rateLimitStatus,
      signals: evaluatedSignals,
      candles: rawCandlesMap,
    },
    {
      status: evaluatedSignals.length > 0 ? 200 : 503,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    }
  );
}
