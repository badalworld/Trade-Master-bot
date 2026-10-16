import { NextRequest, NextResponse } from 'next/server';
import {
  evaluate3IndicatorSignal,
  checkRateLimit,
  type Candle,
  type SignalEvaluation,
} from '@/lib/trading-engine';

const DEFAULT_PAIRS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'DOGEUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'SUIUSDT',
  'LINKUSDT',
  'NEARUSDT',
  'PEPEUSDT',
];

async function fetchPairCandles(
  baseUrl: string,
  pair: string
): Promise<{ pair: string; candles: Candle[]; weight: number }> {
  const symbolsToTry = pair === 'PEPEUSDT' ? ['PEPEUSDT', '1000PEPEUSDT'] : [pair];
  let highestWeight = 0;

  for (const sym of symbolsToTry) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(
        `${baseUrl}/fapi/v1/klines?symbol=${sym}&interval=5m&limit=40`,
        {
          signal: controller.signal,
          headers: { 'User-Agent': 'TradeMaster-LiveScanner/1.0' },
          cache: 'no-store',
        }
      );
      clearTimeout(timeout);

      const weightHeader = res.headers.get('x-mbx-used-weight-1m');
      if (weightHeader) {
        const parsedWeight = parseInt(weightHeader, 10);
        if (!isNaN(parsedWeight) && parsedWeight > highestWeight) {
          highestWeight = parsedWeight;
        }
      }

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length >= 25) {
          const now = Date.now();
          const candles: Candle[] = data.map((item: (number | string)[]) => ({
            time: Number(item[0]),
            open: parseFloat(String(item[1])),
            high: parseFloat(String(item[2])),
            low: parseFloat(String(item[3])),
            close: parseFloat(String(item[4])),
            volume: parseFloat(String(item[5])),
            takerBuyVolume: item[9] !== undefined ? parseFloat(String(item[9])) : undefined,
            isClosed: item[6] !== undefined ? now >= Number(item[6]) : true,
          }));
          return { pair, candles, weight: highestWeight };
        }
      }
    } catch {
      // Try fallback symbol or return empty
    }
  }

  return { pair, candles: [], weight: highestWeight };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const requestedPairs = url.searchParams.get('pairs')?.split(',') || DEFAULT_PAIRS;
  const isTestnet = url.searchParams.get('testnet') === 'true';
  const safetyCapParam = parseFloat(url.searchParams.get('safetyCap') || '95');
  const safetyCapRatio = !isNaN(safetyCapParam) && safetyCapParam > 0 ? safetyCapParam / 100 : 0.95;

  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const maxScanCount = Math.min(requestedPairs.length, 12);
  const targetPairs = requestedPairs.slice(0, maxScanCount);

  let usedWeight = 24;
  const evaluatedSignals: SignalEvaluation[] = [];
  const rawCandlesMap: Record<string, Candle[]> = {};

  // Parallelized kline fetching across all target pairs for low latency
  const results = await Promise.allSettled(
    targetPairs.map((pair) => fetchPairCandles(baseUrl, pair.trim().toUpperCase()))
  );

  for (const res of results) {
    if (res.status === 'fulfilled') {
      const { pair, candles, weight } = res.value;
      if (weight > usedWeight) {
        usedWeight = weight;
      }
      if (candles.length >= 25) {
        rawCandlesMap[pair] = candles;
        const signal = evaluate3IndicatorSignal(pair, candles);
        evaluatedSignals.push(signal);
      }
    }
  }

  // Sort by high volatility (with tie-breaking on signal score)
  evaluatedSignals.sort((a, b) => {
    if (Math.abs(b.volatilityPercent - a.volatilityPercent) > 0.05) {
      return b.volatilityPercent - a.volatilityPercent;
    }
    return b.score - a.score;
  });

  const rateLimitStatus = checkRateLimit(usedWeight, 1200, safetyCapRatio);

  return NextResponse.json({
    timestamp: Date.now(),
    scanIntervalSeconds: 15,
    timeframe: '5m',
    signalsCount: evaluatedSignals.length,
    rateLimitStatus,
    signals: evaluatedSignals,
    candles: rawCandlesMap,
  });
}
