/**
 * Candle fetching + signal generation for the 5m universe.
 *
 * Shared by the public `/api/binance/scan` route and by the unattended engine loop so both score
 * identical data — the old split, where the browser scanned and the server traded, is what let the
 * two drift apart.
 *
 * The scan is a funnel, in this order, and the order is the point:
 *
 *   1. **Universe** (`lib/market-scanner.ts`): the whole USDT-M market ranked most-volatile-first
 *      from one ticker call. An operator allowlist overrides it, and a discovery failure falls back
 *      to the built-in majors.
 *   2. **Shortlist**: the top of that board, minus anything already open. Those are the only pairs
 *      whose klines are fetched — this is what makes the scan fast enough to react.
 *   3. **Regime gate** on settled candles: chop filter (ADX + efficiency ratio) and the volatility
 *      band. A pair that fails is *reported*, never entered.
 *   4. **Ranking**: best signal score first, volatility as the tie-break — so a 92% setup on a calm
 *      pair beats a 66% setup on a wild one instead of the reverse.
 */

import { publicGet } from './binance-client.ts';
import {
  evaluate3IndicatorSignal,
  type Candle,
  type SignalEvaluation,
} from './trading-engine.ts';
import {
  classifyVolatility,
  measureRegime,
  volatilityRanks,
  type RegimeMetrics,
  type VolatilityLevel,
} from './market-regime.ts';
import { DEFAULT_SCANNED_SYMBOLS, type RiskPolicy } from './risk-policy.ts';
import { fetchOpportunityBoard, type DiscoveryCandidate, type OpportunityBoard } from './market-scanner.ts';
import {
  applyOpportunityVerdicts,
  planOpportunityUniverse,
  type OpportunityEntry,
  type OpportunityListState,
  type OpportunityRemoval,
  type OpportunityVerdict,
} from './opportunity-list.ts';

export const MAX_SCAN_PAIRS = 24;
/** Candles requested per pair. ADX(14) needs 29 to seed a Wilder average, plus room to settle. */
export const SCAN_KLINE_LIMIT = 100;
/** Below this many usable candles a pair is not evaluated at all. */
export const MIN_USABLE_CANDLES = 40;

/**
 * How far the stage-1 volatility proxy may differ from the stage-2 band before a pair is kept off
 * the shortlist.
 *
 * Stage 1 ranks the market with the 24h high-low range; stage 2 measures 5m volatility. They are
 * different scales — the same pair that shows ~14% over 24h typically measures ~4.5% on the 5m
 * composite — so a proxy band is deliberately wide, and is only used to decide which pairs deserve
 * an (expensive) kline request. The actual trade/no-trade verdict is always the measured one.
 *
 * Without this, the shortlist is simply "the 12 most volatile pairs in the market", which on a wild
 * day is 12 pairs above the ceiling: every one is refused, and the scanner reports "no setup" while
 * hundreds of perfectly tradeable pairs sit further down the ranking. That was observed live.
 */
export const SHORTLIST_PROXY_MULTIPLIER = 3;

export interface PairScan {
  pair: string;
  candles: Candle[];
  weight: number;
  error?: string;
}

/**
 * Why a scanned pair may not be entered. Order of precedence matches the funnel: a pair in a chop
 * market is reported as choppy even if it is also too calm.
 */
export type ScanSkipReason = 'choppy' | 'vol-below-floor' | 'vol-above-ceiling' | 'vol-unknown';

export interface ScanAnnotation {
  /** 0–100 percentile within this scan: 100 = the most volatile pair scanned. */
  volatilityRank: number;
  volatilityLevel: VolatilityLevel;
  /** false = must not be entered (chop or out of band), regardless of how good the score looks. */
  tradeable: boolean;
  skipReason?: ScanSkipReason;
  /** Verbatim explanation for the UI row and the engine log. */
  skipDetail?: string;
}

export interface OpportunityBoardSummary {
  source: 'binance' | 'fallback';
  generatedAt: number;
  error?: string;
  universeSize: number;
  liquidCount: number;
  minQuoteVolumeUsdt: number;
  /** Ranked most → least volatile, capped for transport. */
  candidates: DiscoveryCandidate[];
}

export interface ScanResult {
  timestamp: number;
  ok: boolean;
  /** Pairs this scan actually attempted (after discovery + allowlist + skip filtering). */
  requestedPairs: string[];
  signals: SignalEvaluation[];
  candles: Record<string, Candle[]>;
  failures: { pair: string; error: string }[];
  usedWeight: number;
  /** Symbols whose exchange filters could not be resolved, i.e. not safely tradeable. */
  tradeable: Record<string, boolean>;
  /** Stage-1 output, so the UI can show what the whole market looked like. */
  board: OpportunityBoardSummary;
  /** How many pairs the funnel refused, by reason — the honest explanation of "no setup". */
  skipped: Record<string, number>;
  /** Ranked liquid pairs that were not deep-scanned this cycle because the shortlist was full. */
  shortlistSkipped: number;
  /**
   * The opportunity list after this cycle: what it holds, what joined and what left. Null when the
   * list is disabled (the scan then re-derives a shortlist from the board every cycle).
   */
  opportunity: OpportunityScanReport | null;
}

/**
 * What happened to the opportunity list this cycle — the state to persist, plus the changes worth
 * reporting to the operator.
 */
export interface OpportunityScanReport {
  mode: 'list';
  /** The list to persist. The caller owns durability (see `lib/opportunity-store.ts`). */
  state: OpportunityListState;
  /** Pairs deep-scanned this cycle: the list, minus members held by an open position. */
  scanned: string[];
  /** Members skipped this cycle because a position is already open on them (they keep their place). */
  held: string[];
  /** Pairs the market scan promoted this cycle (all of them were scanned in this same cycle). */
  promoted: OpportunityEntry[];
  /** Pairs that left the list, with the reason — board screen, verdict, displacement or capacity. */
  removed: OpportunityRemoval[];
  /** Members that carried at least one strike out of this cycle, but survived. */
  warned: { symbol: string; strikes: number; reason: string }[];
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
        `?symbol=${encodeURIComponent(sym)}&interval=5m&limit=${SCAN_KLINE_LIMIT}`,
        4000
      );
      if (typeof usedWeight === 'number' && usedWeight > highestWeight) highestWeight = usedWeight;
      if (!Array.isArray(data) || data.length < MIN_USABLE_CANDLES) {
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
      if (usable.length < MIN_USABLE_CANDLES) {
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
    // `publicGet` resolves to `{ data, usedWeight }`: passing that wrapper straight to `buildSpecMap`
    // left it without a `symbols` array, so every symbol came back as *not tradeable*. Both entry
    // paths require an explicit `true`, so automated entries could never be attempted at all
    // (found live: a stubbed exchange proved the whole funnel was arithmetically correct and
    // still picked nothing). The payload is what has to be inspected, not the envelope.
    const { data } = await publicGet<unknown>(isTestnet, '/fapi/v1/exchangeInfo', '', 6000);
    const map = buildSpecMap(data);
    for (const s of symbols) out[s] = Boolean(map?.[s]);
  } catch {
    // exchangeInfo unreachable: mark everything untradeable so no entry is attempted blind.
  }
  return out;
}

export interface ScanOptions {
  isTestnet: boolean;
  policy: RiskPolicy;
  /** Extra pairs beyond the discovered shortlist (still constrained by it). */
  pairs?: string[];
  /** Symbols to skip (already open). */
  skip?: string[];
  /** Test seam: inject a board instead of calling the exchange. */
  board?: OpportunityBoard;
  /**
   * The opportunity list carried over from the previous cycle (null/absent = none yet). Used when
   * `policy.opportunity.enabled`: the scan then targets exactly this list — refreshed against the
   * fresh market ranking first, and pruned by what the deep scan then measures.
   */
  opportunity?: OpportunityListState | null;
}

/**
 * Which symbols this scan should even look at, in the order they should be looked at: the most
 * volatile liquid pairs from the market-wide board. When an allowlist is set (or discovery is
 * disabled) the operator's list wins, because an explicit restriction must never be widened by a
 * market ranking.
 */
export function resolveScanUniverse(board: OpportunityBoard, policy: RiskPolicy): string[] {
  const allowlist = policy.symbolAllowlist.map((s) => s.trim().toUpperCase()).filter(Boolean);

  if (allowlist.length > 0) return allowlist;
  if (!policy.discovery.enabled) return [...DEFAULT_SCANNED_SYMBOLS];
  if (board.symbols.length > 0) return board.symbols;
  // Discovery on but the board came back empty for any reason: never scan nothing.
  return [...DEFAULT_SCANNED_SYMBOLS];
}

/**
 * How many pairs the opportunity list may hold: what the operator asked for, bounded by what one
 * cycle can afford to scan. Every member is deep-scanned every cycle, so this is also the weight
 * ceiling — 20 pairs at 5m/100 candles is ~40 weight per cycle against a 2400/min budget.
 */
export function resolveOpportunityCap(policy: RiskPolicy): number {
  const perCycleBudget = Math.min(MAX_SCAN_PAIRS, Math.max(1, policy.maxOpenPositions * 4));
  return Math.max(1, Math.min(Math.floor(policy.opportunity.max), perCycleBudget));
}

/**
 * Which pairs from the ranked board deserve a kline request.
 *
 * Walks the ranking most-volatile-first, as the strategy wants, but prefers pairs the (wide) stage-1
 * proxy says could actually fall inside the volatility band — so the scan spends its weight on pairs
 * that can be traded rather than on a dozen names that will all be refused on arrival. Names outside
 * the proxy band still fill any leftover budget, most volatile first, so the operator keeps seeing the
 * wild end of the market instead of it being hidden.
 */
export function selectShortlist(
  candidates: DiscoveryCandidate[],
  opts: { topN: number; minPercent: number; maxPercent: number }
): { symbols: string[]; proxySkipped: number } {
  const floor = opts.minPercent / SHORTLIST_PROXY_MULTIPLIER;
  const ceiling = opts.maxPercent * SHORTLIST_PROXY_MULTIPLIER;
  const size = Math.max(1, Math.floor(opts.topN));

  const inProxyBand = candidates.filter((c) => c.amplitudePercent >= floor && c.amplitudePercent <= ceiling);
  const outside = candidates.filter((c) => c.amplitudePercent < floor || c.amplitudePercent > ceiling);

  const chosen = [...inProxyBand, ...outside].slice(0, size);
  return { symbols: chosen.map((c) => c.symbol), proxySkipped: Math.max(0, candidates.length - chosen.length) };
}

/**
 * Annotate every evaluated pair with its regime verdict. Kept separate from the strategy evaluation
 * so the strategy stays pure and the gate stays testable on its own.
 *
 * `volatilityPercent` (settled candles) is the band metric: it is the number the scanner displays
 * and the number the ranking is built from, so the gate and the UI can never disagree about which
 * pair is volatile.
 */
export function annotateSignals(
  signals: SignalEvaluation[],
  policy: RiskPolicy
): SignalEvaluation[] {
  const ranks = volatilityRanks(signals.map((s) => s.volatilityPercent));

  return signals.map((signal, index) => {
    const band = { minPercent: policy.scan.minVolatilityPercent, maxPercent: policy.scan.maxVolatilityPercent };
    const verdict = classifyVolatility(signal.volatilityPercent, band);
    const regime: RegimeMetrics | undefined = signal.regime;

    let skipReason: ScanSkipReason | undefined;
    let skipDetail: string | undefined;

    if (regime?.choppy) {
      skipReason = 'choppy';
      skipDetail = `choppy market (${regime.detail})`;
    } else if (!verdict.allowed) {
      if (!Number.isFinite(signal.volatilityPercent) || signal.volatilityPercent <= 0) {
        skipReason = 'vol-unknown';
      } else if (verdict.level === 'LOW') {
        skipReason = 'vol-below-floor';
      } else {
        skipReason = 'vol-above-ceiling';
      }
      skipDetail = verdict.reason;
    }

    const annotation: ScanAnnotation = {
      volatilityRank: ranks[index],
      volatilityLevel: verdict.level,
      tradeable: skipReason === undefined,
      skipReason,
      skipDetail,
    };

    return { ...signal, scan: annotation };
  });
}

/** Banked by reason, e.g. `{ choppy: 3, 'vol-below-floor': 1 }`, for honest "no setup" reporting. */
export function summarizeSkips(signals: SignalEvaluation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const signal of signals) {
    const reason = signal.scan?.skipReason;
    if (!reason) continue;
    out[reason] = (out[reason] ?? 0) + 1;
  }
  return out;
}

/**
 * Pick the one candidate to trade: the best **signal score** among pairs that are tradeable, with
 * volatility breaking ties.
 *
 * This replaces "first actionable signal in a volatility-sorted list", which is what made the bot
 * reach for the most volatile pair that had any signal at all — the behaviour the operator
 * reported. Volatility still decides between two equally good setups, and still gates which pairs
 * are eligible at all (band + chop), but it no longer overrules a better setup.
 */
export function selectBestCandidate(
  signals: SignalEvaluation[],
  tradeable: Record<string, boolean> = {},
  minScore = 65
): SignalEvaluation | null {
  const eligible = signals.filter(
    (signal) => tradeable[signal.symbol] !== false && signal.scan?.tradeable !== false && isActionableSignal(signal, minScore)
  );
  if (eligible.length === 0) return null;

  return [...eligible].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.volatilityPercent !== a.volatilityPercent) return b.volatilityPercent - a.volatilityPercent;
    return a.symbol.localeCompare(b.symbol);
  })[0];
}

export async function scanUniverse(opts: ScanOptions): Promise<ScanResult> {
  const { isTestnet, policy } = opts;

  const board: OpportunityBoard =
    opts.board ??
    (await fetchOpportunityBoard(isTestnet, {
      topN: policy.discovery.topN,
      minQuoteVolumeUsdt: policy.discovery.minQuoteVolumeUsdt,
      ttlMs: policy.discovery.ttlMs,
      allowlist: policy.discovery.enabled ? policy.symbolAllowlist : [],
      fallbackSymbols: [...DEFAULT_SCANNED_SYMBOLS],
    }));

  const universe = resolveScanUniverse(board, policy);
  const requested = (opts.pairs ?? []).map((p) => p.trim().toUpperCase()).filter(Boolean);
  const allowedSet = new Set(universe);
  const skip = new Set((opts.skip ?? []).map((s) => s.toUpperCase()));

  const perCycleCap = Math.min(MAX_SCAN_PAIRS, Math.max(1, policy.maxOpenPositions * 4));
  const shortlistSize = Math.max(1, Math.min(policy.scan.topN, perCycleCap));

  // The operator's own list (allowlist, discovery off, or an explicit `pairs=` request) is honoured
  // as given — screening it with a proxy band would silently drop names the operator asked for.
  const explicitList = requested.length > 0 ? requested : policy.symbolAllowlist.length > 0 || !policy.discovery.enabled ? universe : null;
  let targetPairs: string[];
  let proxySkipped = 0;

  // -------------------------------------------------------------------------------------------
  // The opportunity list, when enabled: the market scan above promotes opportunity assets, and this
  // cycle scans exactly those — refreshed against the ranking first, so a pair that just qualified is
  // traded in the same cycle and one that just dropped out stops costing kline weight immediately.
  // An explicit `pairs=` request bypasses the list (a manual "scan these" must not rewrite it).
  // -------------------------------------------------------------------------------------------
  const listMode = policy.opportunity.enabled && requested.length === 0;
  let plan: ReturnType<typeof planOpportunityUniverse> | null = null;

  if (listMode) {
    plan = planOpportunityUniverse({
      state: opts.opportunity ?? null,
      candidates: board.candidates,
      boardGeneratedAt: board.generatedAt,
      // A fallback board is a placeholder, not a ranking: it must not be read as "nothing qualifies".
      boardFresh: board.source === 'binance',
      allowlist: policy.discovery.enabled ? policy.symbolAllowlist : [...universe],
      cap: resolveOpportunityCap(policy),
      minPercent: policy.scan.minVolatilityPercent,
      maxPercent: policy.scan.maxVolatilityPercent,
      proxyMultiplier: SHORTLIST_PROXY_MULTIPLIER,
      cooldownMs: policy.opportunity.cooldownMs,
      hold: opts.skip ?? [],
      now: Date.now(),
    });
    targetPairs = plan.symbols;
    // Everything the list dropped is a refusal this cycle, so "no setup" can name the real reason.
    proxySkipped = plan.removed.length;
  } else if (explicitList) {
    targetPairs = explicitList
      .filter((pair) => allowedSet.has(pair))
      .filter((pair) => !skip.has(pair))
      .filter((pair, index, all) => all.indexOf(pair) === index)
      .slice(0, shortlistSize);
  } else {
    const shortlist = selectShortlist(
      board.candidates.filter((c) => !skip.has(c.symbol)),
      {
        topN: shortlistSize,
        minPercent: policy.scan.minVolatilityPercent,
        maxPercent: policy.scan.maxVolatilityPercent,
      }
    );
    targetPairs = shortlist.symbols;
    proxySkipped = shortlist.proxySkipped;
  }

  const results = await Promise.allSettled(targetPairs.map((pair) => fetchPairCandles(isTestnet, pair)));
  const outcomes: PairScan[] = results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { pair: targetPairs[i], candles: [], weight: 0, error: String(r.reason) }
  );

  let usedWeight = 0;
  const rawSignals: SignalEvaluation[] = [];
  const candles: Record<string, Candle[]> = {};
  const failures: { pair: string; error: string }[] = [];

  for (const { pair, candles: rows, weight, error } of outcomes) {
    if (weight > usedWeight) usedWeight = weight;
    if (rows.length >= MIN_USABLE_CANDLES) {
      candles[pair] = rows;
      rawSignals.push(evaluate3IndicatorSignal(pair, rows));
    } else {
      failures.push({ pair, error: error || 'insufficient candles' });
    }
  }

  const signals = annotateSignals(rawSignals, policy);

  // Best score first, volatility as the tie-break. The engine takes the head of this list; the UI
  // still offers its own sort (including strictly by volatility) as a view preference.
  signals.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (Math.abs(b.volatilityPercent - a.volatilityPercent) > 0.01) return b.volatilityPercent - a.volatilityPercent;
    return a.symbol.localeCompare(b.symbol);
  });

  const tradeable = await resolveTradeable(isTestnet, signals.map((s) => s.symbol));

  // Report what the deep scan measured back to the list: a member that failed is warned, and at the
  // configured strike limit it leaves the opportunity list (making room for the next opportunity).
  let opportunity: OpportunityScanReport | null = null;
  if (plan) {
    const verdicts: OpportunityVerdict[] = signals.map((signal) => ({
      symbol: signal.symbol,
      ok: signal.scan?.tradeable !== false,
      reason: signal.scan?.skipReason,
      detail: signal.scan?.skipDetail,
      volatilityPercent: signal.volatilityPercent,
    }));
    // A pair we asked for candles and did not get is a failure with a reason, not a silent absence.
    for (const failure of failures) {
      verdicts.push({ symbol: failure.pair, ok: false, reason: 'no-data', detail: failure.error });
    }

    const applied = applyOpportunityVerdicts({
      state: plan.state,
      verdicts,
      strikes: policy.opportunity.strikes,
      cooldownMs: policy.opportunity.cooldownMs,
      now: Date.now(),
    });

    const verdictBySymbol = new Map(verdicts.map((v) => [v.symbol, v]));
    const warned = applied.state.entries
      .filter((entry) => entry.strikes > 0)
      .map((entry) => ({
        symbol: entry.symbol,
        strikes: entry.strikes,
        reason: verdictBySymbol.get(entry.symbol)?.reason ?? 'unmeasured',
      }));

    opportunity = {
      mode: 'list',
      state: applied.state,
      scanned: [...targetPairs],
      held: plan.held,
      promoted: plan.promoted,
      removed: [...plan.removed, ...applied.removed],
      warned,
    };
  }

  return {
    timestamp: Date.now(),
    ok: signals.length > 0,
    requestedPairs: targetPairs,
    signals,
    candles,
    failures,
    usedWeight,
    tradeable,
    board: {
      source: board.source,
      generatedAt: board.generatedAt,
      error: board.error,
      universeSize: board.universeSize,
      liquidCount: board.liquidCount,
      minQuoteVolumeUsdt: board.minQuoteVolumeUsdt,
      candidates: board.candidates.slice(0, 40),
    },
    skipped: summarizeSkips(signals),
    shortlistSkipped: proxySkipped,
    opportunity,
  };
}

/**
 * Entry threshold shared by the UI copy and the engine so "what counts as a signal" has one answer.
 *
 * It now includes the regime verdict: a pair the scanner marked tradeable=false (chop market, or
 * volatility outside the band) is not an entry candidate no matter how strong the three-indicator
 * score looks — refusing that combination is the entire point of measuring the regime.
 */
export function isActionableSignal(signal: SignalEvaluation, minScore = 65): boolean {
  if (signal.scan && signal.scan.tradeable === false) return false;
  return (
    signal.signal === 'STRONG_BUY' ||
    signal.signal === 'STRONG_SELL' ||
    ((signal.signal === 'BUY' || signal.signal === 'SELL') && signal.score >= minScore)
  );
}
