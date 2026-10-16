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

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const requestedPairs = url.searchParams.get('pairs')?.split(',') || DEFAULT_PAIRS;
  const maxScanCount = Math.min(requestedPairs.length, 12);
  const targetPairs = requestedPairs.slice(0, maxScanCount);

  let usedWeight = 42;
  const evaluatedSignals: SignalEvaluation[] = [];
  const rawCandlesMap: Record<string, Candle[]> = {};

  for (const pair of targetPairs) {
    let candles: Candle[] = [];

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);

      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=5m&limit=35`,
        {
          signal: controller.signal,
          headers: { 'User-Agent': 'TradeMaster-LiveScanner/1.0' },
        }
      );
      clearTimeout(timeout);

      const weightHeader = res.headers.get('x-mbx-used-weight-1m');
      if (weightHeader) {
        const parsedWeight = parseInt(weightHeader, 10);
        if (!isNaN(parsedWeight) && parsedWeight > usedWeight) {
          usedWeight = parsedWeight;
        }
      }

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          candles = data.map((item: (number | string)[]) => ({
            time: Number(item[0]),
            open: parseFloat(String(item[1])),
            high: parseFloat(String(item[2])),
            low: parseFloat(String(item[3])),
            close: parseFloat(String(item[4])),
            volume: parseFloat(String(item[5])),
          }));
        }
      }
    } catch {
      // If public Binance API fails to respond, return empty or skip offline mock candles
    }

    if (candles.length >= 25) {
      rawCandlesMap[pair] = candles;
      const signal = evaluate3IndicatorSignal(pair, candles);
      evaluatedSignals.push(signal);
    }
  }

  evaluatedSignals.sort((a, b) => b.volatilityPercent - a.volatilityPercent);
  const rateLimitStatus = checkRateLimit(usedWeight, 1200);

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
