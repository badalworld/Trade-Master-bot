/**
 * Candle fetching + signal generation for the 5m universe.
 *
 * Shared by the public `/api/binance/scan` route and by the unattended engine loop so both score
 * identical data — the old split, where the browser scanned and the server traded, is what let the
 * two drift apart.
 */

import { publicGet } from './binance-client.ts';
import {
  evaluate3IndicatorSignal,
  type Candle,
  type SignalEvaluation,
} from './trading-engine.ts';
import { DEFAULT_SCANNED_SYMBOLS, type RiskPolicy } from './risk-policy.ts';

export const MAX_SCAN_PAIRS = 12;

export interface PairScan {
  pair: string;
  candles: Candle[];
  weight: number;
  error?: string;
}

export interface ScanResult {
  timestamp: number;
  ok: boolean;
  signals: SignalEvaluation[];
  candles: Record<string, Candle[]>;
  failures: { pair: string; error: string }[];
  usedWeight: number;
  /** Symbols whose exchange filters could not be resolved, i.e. not safely tradeable. */
  tradeable: Record<string, boolean>;
}

async function fetchPairCandles(isTestnet: boolean, pair: string): Promise<PairScan> {
  // A renamed ticker (PEPE vs 1000PEPE) is a data problem, not a strategy signal.
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

      const usable = candles.filter((c) => [c.open, c.high, c.low, c.close, c.volume].every((v) => Number.isFinite(v)));
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

/** Resolve which symbols the exchange will actually accept orders for. */
async function resolveTradeable(isTestnet: boolean, symbols: string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const s of symbols) out[s] = false;
  try {
    const { buildSpecMap } = await import('./exchange-specs.ts');
    const map = buildSpecMap(await publicGet<unknown>(isTestnet, '/fapi/v1/exchangeInfo', '', 6000));
    for (const s of symbols) out[s] = Boolean(map?.[s]);
  } catch {
    // exchangeInfo unreachable: mark everything untradeable so no entry is attempted blind.
  }
  return out;
}

export interface ScanOptions {
  isTestnet: boolean;
  policy: RiskPolicy;
  /** Extra pairs beyond the policy allowlist (still constrained by it). */
  pairs?: string[];
  /** Symbols to skip (already open). */
  skip?: string[];
}

export async function scanUniverse(opts: ScanOptions): Promise<ScanResult> {
  const { isTestnet, policy } = opts;
  const allowlist = policy.symbolAllowlist.length > 0 ? policy.symbolAllowlist : [...DEFAULT_SCANNED_SYMBOLS];
  const requested = (opts.pairs ?? []).map((p) => p.trim().toUpperCase()).filter(Boolean);
  const skip = new Set((opts.skip ?? []).map((s) => s.toUpperCase()));

  const targetPairs = (requested.length ? requested : allowlist)
    .filter((p) => policy.symbolAllowlist.length === 0 || allowlist.includes(p))
    .filter((p) => !skip.has(p))
    .slice(0, Math.min(MAX_SCAN_PAIRS, Math.max(1, policy.maxOpenPositions * 4)));

  const results = await Promise.allSettled(targetPairs.map((pair) => fetchPairCandles(isTestnet, pair)));
  const outcomes: PairScan[] = results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { pair: targetPairs[i], candles: [], weight: 0, error: String(r.reason) }
  );

  let usedWeight = 0;
  const signals: SignalEvaluation[] = [];
  const candles: Record<string, Candle[]> = {};
  const failures: { pair: string; error: string }[] = [];

  for (const { pair, candles: rows, weight, error } of outcomes) {
    if (weight > usedWeight) usedWeight = weight;
    if (rows.length >= 25) {
      candles[pair] = rows;
      signals.push(evaluate3IndicatorSignal(pair, rows));
    } else {
      failures.push({ pair, error: error || 'insufficient candles' });
    }
  }

  signals.sort((a, b) => {
    if (Math.abs(b.volatilityPercent - a.volatilityPercent) > 0.05) return b.volatilityPercent - a.volatilityPercent;
    return b.score - a.score;
  });

  const tradeable = await resolveTradeable(isTestnet, signals.map((s) => s.symbol));

  return { timestamp: Date.now(), ok: signals.length > 0, signals, candles, failures, usedWeight, tradeable };
}

/** Entry threshold shared by the UI copy and the engine so "what counts as a signal" has one answer. */
export function isActionableSignal(signal: SignalEvaluation, minScore = 65): boolean {
  return (
    signal.signal === 'STRONG_BUY' ||
    signal.signal === 'STRONG_SELL' ||
    ((signal.signal === 'BUY' || signal.signal === 'SELL') && signal.score >= minScore)
  );
}
