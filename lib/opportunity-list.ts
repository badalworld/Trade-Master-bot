/**
 * The opportunity list — the pairs the market scanner has promoted, scanned as their own universe.
 *
 * The operator's model, in their words:
 *
 *   _"We scan full futures markets and find best opportunity not only 12 … when market scanner found
 *   any opportunity assets it moves to opportunity assets. opportunity assets scan separately and
 *   trade execution. if any opportunity assets not fulfill our requirements it remove from
 *   opportunity list."_
 *
 * Two stages at two rates, and the split is the point:
 *
 *   market scan      (whole market, one cached call)  → finds and promotes opportunity assets
 *   opportunity scan (this list, every cycle)         → the fast path that trades
 *
 * A pair joins the list when the market ranking says it is a plausible opportunity: liquid, still a
 * tradeable perpetual, and its 24h proxy volatility sits inside the (wide) screening band around the
 * band we actually trade. It leaves when it stops being one:
 *
 *   - it drops off the ranked board — delisted, or volume fell under the liquidity floor;
 *   - the market moved it outside the screening band (quiet again, or wild);
 *   - a clearly more volatile qualified pair took its slot on a full list;
 *   - the deep scan refused it for the *measured* reason (chop, volatility out of the band, or no
 *     usable candles) on `strikes` consecutive passes — one bad reading must not evict a pair that is
 *     simply pausing, so a single strike only counts as a warning;
 *   - its exchange filters disappeared, which is immediate: an unsizeable pair is not an opportunity.
 *
 * Removals are remembered with a cooldown, so a pair that just failed cannot bounce straight back in
 * on the next market scan. That bounce is exactly what turns a list into churn.
 *
 * Pure module: no clock, no I/O, no env — the caller passes `now` and persists the result. The
 * filesystem side lives in `lib/opportunity-store.ts`.
 */

import type { DiscoveryCandidate } from './market-scanner.ts';

/** Why a pair was taken off the opportunity list. */
export type OpportunityRemovalReason =
  | 'choppy'
  | 'vol-below-floor'
  | 'vol-above-ceiling'
  | 'vol-unknown'
  | 'no-data'
  | 'filters-unknown'
  | 'not-on-board'
  | 'displaced'
  | 'over-capacity';

/** Reasons that remove a pair immediately, without waiting for the strike limit. */
const HARD_REASONS: ReadonlySet<OpportunityRemovalReason> = new Set(['filters-unknown']);

export interface OpportunityEntry {
  symbol: string;
  /** When the market scanner promoted this pair. */
  addedAt: number;
  /** Last time it passed every requirement (either the board screen or a deep scan). */
  lastOkAt: number;
  /** Consecutive failing deep scans while listed; removal happens at the configured limit. */
  strikes: number;
  /** Position on the ranked board (1 = most volatile) the last time it was seen there. */
  boardRank: number;
  /** Board readings at the last refresh, kept so the UI can show why a pair is listed. */
  amplitudePercent: number;
  rangeVolScore: number;
  quoteVolume24h: number;
  /** Measured 5m volatility from the last deep scan; null until the first one. */
  volatilityPercent: number | null;
}

export interface OpportunityRemoval {
  symbol: string;
  reason: OpportunityRemovalReason;
  detail: string;
  at: number;
  /** Until this moment the pair is not re-promoted, however good the market ranking looks. */
  cooldownUntil: number;
}

export interface OpportunityListState {
  version: 1;
  updatedAt: number;
  /** `generatedAt` of the market ranking this list was last reconciled against. */
  boardGeneratedAt: number;
  /** The opportunity assets, most volatile first (the order they are scanned in). */
  entries: OpportunityEntry[];
  /** Recent removals, newest last — the memory that stops a failed pair bouncing back in. */
  removed: OpportunityRemoval[];
}

/** One pair's deep-scan verdict, as the funnel measured it this cycle. */
export interface OpportunityVerdict {
  symbol: string;
  ok: boolean;
  reason?: OpportunityRemovalReason;
  detail?: string;
  volatilityPercent?: number;
}

export interface OpportunityPlan {
  state: OpportunityListState;
  /** The fast-path scan universe: list members, minus anything already open, most volatile first. */
  symbols: string[];
  promoted: OpportunityEntry[];
  removed: OpportunityRemoval[];
  /** List members held back this cycle (an open position), so the report can say so. */
  held: string[];
}

export interface OpportunityPlanInput {
  /** The list carried over from the previous cycle (null = none yet). */
  state: OpportunityListState | null;
  /** The market ranking, most volatile first. */
  candidates: DiscoveryCandidate[];
  boardGeneratedAt: number;
  /**
   * Whether `candidates` is a real ranking from the exchange. A fallback board (the ticker call
   * failed, so the built-in majors are used as a placeholder) carries no volatility readings and
   * therefore says nothing about whether any member still qualifies — treating it as a ranking would
   * wipe the list over one network blip. When false, the list is carried over untouched and only the
   * deep-scan verdicts can change it.
   */
  boardFresh?: boolean;
  /** Operator allowlist; when set, only those symbols may be promoted. */
  allowlist: string[];
  /** Maximum members (already bounded by the per-cycle weight budget by the caller). */
  cap: number;
  /** Tradeable volatility band; the screening band is derived from it. */
  minPercent: number;
  maxPercent: number;
  /** How far the 24h proxy may differ from the band before a pair is screened out. */
  proxyMultiplier: number;
  /** How long a removed pair is barred from re-promotion. */
  cooldownMs: number;
  /** Pairs not to scan this cycle (already open). They stay listed but are not judged. */
  hold?: string[];
  now: number;
}

/**
 * A newcomer must beat the weakest member by this margin before it takes a slot. Without it, two
 * pairs whose 24h ranges differ by a rounding error would trade places every market scan.
 */
export const DISPLACEMENT_MARGIN = 1.05;

/** How many removal records are kept for the UI and for the cooldown memory. */
const MAX_REMEMBERED_REMOVALS = 200;

export function emptyOpportunityList(now: number): OpportunityListState {
  return { version: 1, updatedAt: now, boardGeneratedAt: 0, entries: [], removed: [] };
}

/**
 * The stage-1 screening band. Stage 1 ranks with the 24h high-low range while stage 2 measures 5m
 * volatility, so the two live on different scales — wide on purpose, because this band only decides
 * which pairs are worth an (expensive) kline request. The trade verdict is always the measured one.
 */
export function proxyVolatilityBand(
  minPercent: number,
  maxPercent: number,
  multiplier: number
): { floor: number; ceiling: number } {
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  const floor = minPercent / m;
  const ceiling = maxPercent * m;
  return { floor: Number.isFinite(floor) ? floor : 0, ceiling: Number.isFinite(ceiling) ? ceiling : Infinity };
}

/**
 * Which pairs the opportunity list should hold this cycle, and therefore which pairs are scanned and
 * eligible for a trade.
 *
 * The board is the market scanner's answer to "where is the opportunity right now", so it is applied
 * before the kline fan-out: a pair promoted here is deep-scanned in the same cycle, and a pair that
 * dropped out of the liquid set stops costing kline weight immediately.
 */
export function planOpportunityUniverse(input: OpportunityPlanInput): OpportunityPlan {
  const now = input.now;
  const boardFresh = input.boardFresh !== false;
  const size = Math.max(1, Math.floor(input.cap));
  const { floor, ceiling } = proxyVolatilityBand(input.minPercent, input.maxPercent, input.proxyMultiplier);
  const previous = input.state ?? emptyOpportunityList(now);
  const allowed = new Set(input.allowlist.map((s) => s.trim().toUpperCase()).filter(Boolean));
  const holdSet = new Set((input.hold ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean));

  const ranked: { candidate: DiscoveryCandidate; rank: number }[] = input.candidates.map((candidate) => ({
    candidate,
    rank: Number.isFinite(candidate.ranking) ? candidate.ranking : 0,
  }));
  const bySymbol = new Map(ranked.map((r) => [r.candidate.symbol, r]));

  const removed: OpportunityRemoval[] = [];
  const remove = (symbol: string, reason: OpportunityRemovalReason, detail: string) => {
    removed.push({ symbol, reason, detail, at: now, cooldownUntil: now + Math.max(0, input.cooldownMs) });
  };

  // No fresh ranking: carry the list over as it stands. A market scan that could not reach the
  // exchange is not evidence that any opportunity asset stopped qualifying.
  if (!boardFresh) {
    const carried = [...previous.entries].sort(
      (a, b) => a.boardRank - b.boardRank || b.rangeVolScore - a.rangeVolScore || a.symbol.localeCompare(b.symbol)
    );
    return {
      state: { ...previous, updatedAt: now },
      symbols: carried.filter((e) => !holdSet.has(e.symbol)).map((e) => e.symbol),
      promoted: [],
      removed: [],
      held: carried.filter((e) => holdSet.has(e.symbol)).map((e) => e.symbol),
    };
  }

  // Cooldowns from earlier removals: a pair that just failed is not promotable again yet.
  const cooling = new Map<string, OpportunityRemoval>();
  for (const record of previous.removed) if (record.cooldownUntil > now) cooling.set(record.symbol, record);

  // -------------------------------------------------------------------------------------------
  // 1. Existing members are re-checked against the fresh ranking.
  // -------------------------------------------------------------------------------------------
  const entries: OpportunityEntry[] = [];
  for (const entry of previous.entries) {
    if (allowed.size > 0 && !allowed.has(entry.symbol)) {
      remove(entry.symbol, 'not-on-board', 'no longer on TRADE_SYMBOL_ALLOWLIST');
      continue;
    }
    const hit = bySymbol.get(entry.symbol);
    if (!hit) {
      remove(
        entry.symbol,
        'not-on-board',
        'no longer on the ranked board — delisted, or 24h volume fell below the liquidity floor'
      );
      continue;
    }
    const amplitude = hit.candidate.amplitudePercent;
    if (!Number.isFinite(amplitude) || amplitude < floor || amplitude > ceiling) {
      remove(
        entry.symbol,
        amplitude < floor ? 'vol-below-floor' : 'vol-above-ceiling',
        `24h range ${Number.isFinite(amplitude) ? `${amplitude.toFixed(2)}%` : 'unknown'} left the ` +
          `${floor.toFixed(2)}%–${ceiling.toFixed(2)}% screening band`
      );
      continue;
    }
    entries.push({
      ...entry,
      boardRank: hit.rank,
      amplitudePercent: amplitude,
      rangeVolScore: hit.candidate.rangeVolScore,
      quoteVolume24h: hit.candidate.quoteVolume24h,
      lastOkAt: now,
    });
  }

  // -------------------------------------------------------------------------------------------
  // 2. Promotion. Most volatile first; on a full list a clearly better pair takes the weakest slot,
  //    which is what "find the *next* opportunity asset" has to mean on a bounded list.
  // -------------------------------------------------------------------------------------------
  const listed = new Set(entries.map((e) => e.symbol));
  const promoted: OpportunityEntry[] = [];

  const sorted = [...ranked].sort((a, b) => a.rank - b.rank || b.candidate.rangeVolScore - a.candidate.rangeVolScore);

  for (const { candidate, rank } of sorted) {
    if (listed.has(candidate.symbol)) continue;
    if (allowed.size > 0 && !allowed.has(candidate.symbol)) continue;
    if (cooling.has(candidate.symbol)) continue;

    const amplitude = candidate.amplitudePercent;
    if (!Number.isFinite(amplitude) || amplitude < floor || amplitude > ceiling) continue;

    const entry: OpportunityEntry = {
      symbol: candidate.symbol,
      addedAt: now,
      lastOkAt: now,
      strikes: 0,
      boardRank: rank,
      amplitudePercent: amplitude,
      rangeVolScore: candidate.rangeVolScore,
      quoteVolume24h: candidate.quoteVolume24h,
      volatilityPercent: null,
    };

    if (entries.length < size) {
      entries.push(entry);
      listed.add(candidate.symbol);
      promoted.push(entry);
      continue;
    }

    // Full: displace the weakest member, but never one we are holding a position on.
    let weakest = -1;
    for (let i = 0; i < entries.length; i++) {
      if (holdSet.has(entries[i].symbol)) continue;
      if (weakest === -1 || entries[i].rangeVolScore < entries[weakest].rangeVolScore) weakest = i;
    }
    if (weakest === -1) break;
    if (!(candidate.rangeVolScore > entries[weakest].rangeVolScore * DISPLACEMENT_MARGIN)) {
      // The ranking is descending, so nothing further down can beat the weakest member either.
      break;
    }
    remove(
      entries[weakest].symbol,
      'displaced',
      `a more volatile qualified pair (${candidate.symbol}) took the slot`
    );
    listed.delete(entries[weakest].symbol);
    entries[weakest] = entry;
    listed.add(candidate.symbol);
    promoted.push(entry);
  }

  // -------------------------------------------------------------------------------------------
  // 3. Order most-volatile-first and honour the cap. A shrinking cap (fewer allowed positions, a
  //    changed option) trims from the bottom rather than silently overspending the weight budget.
  // -------------------------------------------------------------------------------------------
  entries.sort(
    (a, b) => a.boardRank - b.boardRank || b.rangeVolScore - a.rangeVolScore || a.symbol.localeCompare(b.symbol)
  );
  if (entries.length > size) {
    for (const dropped of entries.slice(size)) {
      remove(
        dropped.symbol,
        'over-capacity',
        `the opportunity list holds ${size} pairs; this one ranked ${dropped.boardRank} on the board`
      );
      listed.delete(dropped.symbol);
    }
    entries.length = size;
  }

  const symbols = entries.filter((e) => !holdSet.has(e.symbol)).map((e) => e.symbol);
  const held = entries.filter((e) => holdSet.has(e.symbol)).map((e) => e.symbol);

  // Housekeeping: cooldowns that expired a full cooldown ago have no further use.
  const memory = previous.removed.filter((r) => r.cooldownUntil > now - Math.max(0, input.cooldownMs));

  return {
    state: {
      version: 1,
      updatedAt: now,
      boardGeneratedAt: input.boardGeneratedAt,
      entries,
      removed: [...memory, ...removed].slice(-MAX_REMEMBERED_REMOVALS),
    },
    symbols,
    promoted,
    removed,
    held,
  };
}

/**
 * Apply what the deep scan measured. A member that failed is given a strike; at the configured limit
 * it leaves the list and is barred from re-promotion for the cooldown. A member that was not scanned
 * this cycle (an open position, a weight shield) is left exactly as it was — an unscanned pair must
 * never be struck off for something nobody measured.
 */
export function applyOpportunityVerdicts(input: {
  state: OpportunityListState;
  verdicts: OpportunityVerdict[];
  /** Consecutive failures before removal (1 = remove on the first failure). */
  strikes: number;
  cooldownMs: number;
  now: number;
}): { state: OpportunityListState; removed: OpportunityRemoval[] } {
  const limit = Math.max(1, Math.floor(input.strikes));
  const bySymbol = new Map(input.verdicts.map((v) => [v.symbol.toUpperCase(), v]));
  const removed: OpportunityRemoval[] = [];
  const entries: OpportunityEntry[] = [];

  for (const entry of input.state.entries) {
    const verdict = bySymbol.get(entry.symbol);
    if (!verdict) {
      entries.push(entry);
      continue;
    }

    if (verdict.ok) {
      entries.push({
        ...entry,
        strikes: 0,
        lastOkAt: input.now,
        volatilityPercent: verdict.volatilityPercent ?? entry.volatilityPercent,
      });
      continue;
    }

    const reason = verdict.reason ?? 'no-data';
    const strikes = entry.strikes + 1;
    if (HARD_REASONS.has(reason) || strikes >= limit) {
      removed.push({
        symbol: entry.symbol,
        reason,
        detail: verdict.detail ?? reason,
        at: input.now,
        cooldownUntil: input.now + Math.max(0, input.cooldownMs),
      });
      continue;
    }
    entries.push({
      ...entry,
      strikes,
      volatilityPercent: verdict.volatilityPercent ?? entry.volatilityPercent,
    });
  }

  return {
    state: {
      ...input.state,
      updatedAt: input.now,
      entries,
      removed: [...input.state.removed, ...removed].slice(-MAX_REMEMBERED_REMOVALS),
    },
    removed,
  };
}

/** One line per change, for the engine log and the scanner strip. */
export function describeOpportunityChange(
  change: Pick<OpportunityRemoval, 'symbol' | 'reason' | 'detail'> | Pick<OpportunityEntry, 'symbol'>
): string {
  if ('reason' in change) return `${change.symbol} (${change.reason}: ${change.detail})`;
  return change.symbol;
}
