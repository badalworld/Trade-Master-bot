/**
 * Stage 1 of the scan: which pairs are worth looking at right now, across the *whole* futures
 * market.
 *
 * Before this existed, the universe was a hard-coded list of 12 symbols (`DEFAULT_SCANNED_SYMBOLS`)
 * and `scanUniverse` sliced to `min(12, maxOpenPositions x 4)`. Two consequences, both bad:
 *
 *  - a pair three times more volatile than anything on the list was never even priced, and
 *  - the engine then picked the *first* actionable signal from a volatility-sorted array, so the
 *    most volatile pair that had any signal beat a much better setup on a calmer pair.
 *
 * `GET /fapi/v1/ticker/24hr` answers for every symbol in one request, so screening the entire
 * USDT-M market costs one call and no extra weight per pair. That one call produces the
 * **opportunity board**: liquid perpetuals ranked most-volatile → least-volatile, which is exactly
 * the ordering the strategy wants to look at first. Stage 2 (`lib/market-data.ts`) then spends its
 * expensive per-pair kline calls only on the top of that board.
 *
 * The board is cached for `TRADE_DISCOVERY_TTL_MS` so a 15s engine loop does not re-rank the market
 * four times a minute, and so the browser and the engine read the same board instead of drifting.
 *
 * No Node built-ins and no `@/` imports, so it runs directly under `node --test`.
 */

import { publicGet } from './binance-client.ts';

/** Majors quoted against USDT that are not a tradeable idea; they are the quote asset. */
const STABLE_BASES = new Set([
  'USDC',
  'FDUSD',
  'TUSD',
  'BUSD',
  'DAI',
  'USDP',
  'USDD',
  'USTC',
  'EUR',
  'AEUR',
  'EURI',
  'USD1',
  'XUSD',
]);

export interface MarketTickerRow {
  symbol: string;
  lastPrice: number;
  /** 24h high-low amplitude, percent of last price. */
  amplitudePercent: number;
  /** |last - open| as a percent of open: how far the pair actually travelled. */
  momentumPercent: number;
  quoteVolume24h: number;
  /** 0.6 x amplitude + 0.4 x momentum — the ranking key for "most volatile first". */
  rangeVolScore: number;
}

export interface DiscoveryCandidate extends MarketTickerRow {
  /** 1 = most volatile of the whole liquid universe. */
  ranking: number;
}

export interface OpportunityBoard {
  generatedAt: number;
  /** 'fallback' means discovery failed and the built-in major list was used instead. */
  source: 'binance' | 'fallback';
  error?: string;
  /** Symbols that survived the contract filters (perpetual, TRADING, USDT-quoted, non-stable). */
  universeSize: number;
  /** Symbols that also cleared the liquidity floor. */
  liquidCount: number;
  minQuoteVolumeUsdt: number;
  /** Ranked most → least volatile, after the liquidity floor. */
  candidates: DiscoveryCandidate[];
  /** `candidates` capped to the board size — what stage 2 will deep-scan. */
  board: DiscoveryCandidate[];
  symbols: string[];
}

export interface DiscoveryOptions {
  /** How many names the board keeps for stage 2. */
  topN: number;
  /** 24h quote volume floor, in USDT. */
  minQuoteVolumeUsdt: number;
  /** Operator override: non-empty restricts discovery (and trading) to these symbols. */
  allowlist?: string[];
  /** Used only when discovery fails, so a Binance blip cannot silently empty the universe. */
  fallbackSymbols: string[];
  now?: number;
}

function num(raw: unknown, fallback = 0): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Contract-level filters. Anything not covered here (leverage tokens, renamed tickers) is left to
 * the per-symbol exchange filters in stage 2, which are authoritative.
 */
export function isDiscoverableSymbol(symbol: string): boolean {
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
  // Quarterly/delivery contracts ("BTCUSDT_250926") are not what this bot trades.
  if (symbol.includes('_')) return false;
  const base = symbol.slice(0, -'USDT'.length);
  if (base.length === 0) return false;
  if (STABLE_BASES.has(base)) return false;
  // A stablecoin pair quoted in USDT (e.g. USDCUSDT) has no volatility to trade.
  return true;
}

/** Parse the raw `/fapi/v1/ticker/24hr` payload into ranked-ready rows. */
export function parseTicker24h(payload: unknown): MarketTickerRow[] {
  if (!Array.isArray(payload)) return [];
  const rows: MarketTickerRow[] = [];

  for (const item of payload) {
    const raw = item as Record<string, unknown>;
    const symbol = String(raw?.symbol ?? '').toUpperCase();
    if (!symbol) continue;

    const lastPrice = num(raw?.lastPrice);
    const high = num(raw?.highPrice);
    const low = num(raw?.lowPrice);
    const open = num(raw?.openPrice);
    const quoteVolume24h = num(raw?.quoteVolume);
    if (!(lastPrice > 0)) continue;

    const amplitudePercent = high > 0 && low > 0 ? ((high - low) / lastPrice) * 100 : 0;
    const momentumPercent = open > 0 ? (Math.abs(lastPrice - open) / open) * 100 : 0;

    rows.push({
      symbol,
      lastPrice,
      amplitudePercent: Number(amplitudePercent.toFixed(3)),
      momentumPercent: Number(momentumPercent.toFixed(3)),
      quoteVolume24h,
      rangeVolScore: Number((amplitudePercent * 0.6 + momentumPercent * 0.4).toFixed(4)),
    });
  }

  return rows;
}

/**
 * Build the board from raw ticker rows: contract filters → liquidity floor → most-volatile-first
 * ranking → top N.
 *
 * Ordering is stable on ties (by symbol) so two processes reading the same market agree on the
 * board instead of each trusting their own sort.
 */
export function buildOpportunityBoard(
  rows: MarketTickerRow[],
  opts: DiscoveryOptions & { error?: string; source?: 'binance' | 'fallback' }
): OpportunityBoard {
  const now = opts.now ?? Date.now();
  const allowlist = (opts.allowlist ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const allowSet = new Set(allowlist);

  let universe = rows.filter((row) => isDiscoverableSymbol(row.symbol));
  const universeSize = universe.length;
  if (allowSet.size > 0) universe = universe.filter((row) => allowSet.has(row.symbol));

  const liquid = universe.filter((row) => row.quoteVolume24h >= opts.minQuoteVolumeUsdt);
  // If the liquidity floor would empty the board (a quiet market, or a mis-set floor), fall back to
  // the discovered universe rather than refusing to look at anything at all — but only when there
  // is nothing to rank, never as a way to slip an illiquid pair past a working floor.
  const rankedPool = liquid.length > 0 ? liquid : universe;

  const sorted = [...rankedPool].sort((a, b) => {
    if (Math.abs(b.rangeVolScore - a.rangeVolScore) > 1e-9) return b.rangeVolScore - a.rangeVolScore;
    return a.symbol.localeCompare(b.symbol);
  });

  const candidates: DiscoveryCandidate[] = sorted.map((row, index) => ({ ...row, ranking: index + 1 }));
  const board = candidates.slice(0, Math.max(0, opts.topN));

  return {
    generatedAt: now,
    source: opts.source ?? 'binance',
    error: opts.error,
    universeSize,
    liquidCount: liquid.length,
    minQuoteVolumeUsdt: opts.minQuoteVolumeUsdt,
    candidates,
    board,
    symbols: board.map((c) => c.symbol),
  };
}

/** Board used when discovery cannot reach the exchange: the built-in majors, nothing invented. */
function fallbackBoard(opts: DiscoveryOptions, error: string): OpportunityBoard {
  const rows: MarketTickerRow[] = opts.fallbackSymbols.map((symbol) => ({
    symbol,
    lastPrice: 0,
    amplitudePercent: 0,
    momentumPercent: 0,
    quoteVolume24h: 0,
    rangeVolScore: 0,
  }));
  return {
    ...buildOpportunityBoard(rows, { ...opts, error, source: 'fallback' }),
    // A fallback board carries no volatility information, so it is not "ranked" — callers must not
    // treat ranking 1 as "most volatile".
    candidates: rows.map((row, index) => ({ ...row, ranking: index + 1 })),
    board: rows.map((row, index) => ({ ...row, ranking: index + 1 })).slice(0, Math.max(0, opts.topN)),
    symbols: opts.fallbackSymbols.slice(0, Math.max(0, opts.topN)),
  };
}

type BoardCache = { at: number; board: OpportunityBoard };
const boardGlobal = globalThis as unknown as { __tmBoardCache?: Record<string, BoardCache> };
const boardCache: Record<string, BoardCache> = boardGlobal.__tmBoardCache ?? (boardGlobal.__tmBoardCache = {});

/** Test seam: forget the cached board. */
export function __resetOpportunityBoardCache(): void {
  for (const key of Object.keys(boardCache)) delete boardCache[key];
}

/**
 * The last board built for a network, whatever its age. Used for reporting (and by tests); callers
 * that need a fresh ranking go through `fetchOpportunityBoard`.
 */
export function peekOpportunityBoard(isTestnet: boolean): OpportunityBoard | null {
  return boardCache[isTestnet ? 'testnet' : 'mainnet']?.board ?? null;
}

/**
 * Fetch (or reuse) the market-wide opportunity board.
 *
 * One public call, cached for `ttlMs`. A failed call returns the stale board when one exists,
 * otherwise the built-in fallback list — never an empty universe, because "no pairs to scan" reads
 * in the UI as "nothing to trade" when the truth is "the exchange did not answer".
 */
export async function fetchOpportunityBoard(
  isTestnet: boolean,
  opts: DiscoveryOptions & { ttlMs: number; force?: boolean }
): Promise<OpportunityBoard> {
  const key = isTestnet ? 'testnet' : 'mainnet';
  const now = opts.now ?? Date.now();
  const cached = boardCache[key];
  const ttl = Math.max(0, opts.ttlMs);

  if (!opts.force && cached && now - cached.at < ttl) return cached.board;

  try {
    const { data } = await publicGet<unknown>(isTestnet, '/fapi/v1/ticker/24hr', '', 6000);
    const rows = parseTicker24h(data);
    if (rows.length === 0) {
      return cached?.board ?? fallbackBoard(opts, 'ticker/24hr returned no rows');
    }
    const board = buildOpportunityBoard(rows, { ...opts, now, source: 'binance' });
    boardCache[key] = { at: now, board };
    return board;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cached) return cached.board;
    const board = fallbackBoard(opts, message);
    // Cache the fallback only for a short window: the next cycle should try the exchange again.
    boardCache[key] = { at: now - Math.max(0, ttl - 5000), board };
    return board;
  }
}
