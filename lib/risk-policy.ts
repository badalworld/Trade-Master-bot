/**
 * Server-side risk policy for Trade Master.
 *
 * The client UI is *not* a security boundary: it clamps leverage to 10-15x, but a route that
 * trusts the client can be driven to any size by a bug in the loop, a replayed request, or a
 * stolen key. Every number that limits loss is therefore re-checked here, on the server, from env.
 *
 * Pure + env-injected so it is unit-testable without Next.
 */

/**
 * The pre-discovery universe.
 *
 * No longer the trading universe (see `discovery` below): the market is ranked from the exchange
 * itself and the most volatile liquid pairs are scanned, so a hot pair that is not on this list is
 * still found. This list is still used for two things: the pairs scanned when
 * `TRADE_DISCOVERY_ENABLED=false`, and the fallback used for one cycle when `ticker/24hr` cannot be
 * reached (so an exchange blip cannot empty the scanner).
 */
export const DEFAULT_SCANNED_SYMBOLS = [
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
  '1000PEPEUSDT',
] as const;

/** Stage 1: how the tradeable universe is discovered from the exchange itself. */
export interface DiscoveryConfig {
  /** false = use the built-in/fixed symbol list only (the pre-discovery behaviour). */
  enabled: boolean;
  /** How many of the most volatile liquid pairs the opportunity board keeps. */
  topN: number;
  /** 24h quote-volume floor in USDT: below this a pair is too illiquid to enter or exit cleanly. */
  minQuoteVolumeUsdt: number;
  /** How long a board is reused before the market is ranked again. */
  ttlMs: number;
}

/** Stage 2: which of the discovered pairs may actually be entered, and when. */
export interface ScanConfig {
  /** Pairs deep-scanned per cycle, after the board is ranked most-volatile-first. */
  topN: number;
  /** Chop floor: below this volatility a pair is noise, not opportunity. */
  minVolatilityPercent: number;
  /** Blow-off ceiling: above this, an ATR-sized stop is a coin flip. */
  maxVolatilityPercent: number;
  /** ADX below this counts as "no trend" for the chop filter. */
  chopAdxFloor: number;
  /** Efficiency ratio below this counts as "going nowhere" for the chop filter. */
  chopEfficiencyFloor: number;
}

/**
 * The opportunity list: the pool the fast scan works from.
 *
 * Stage 1 (the market scan) covers the whole market and is cached; stage 2 scans this list every
 * cycle, which is what makes the execution path fast — it never re-ranks the market to trade. A pair
 * is dropped when it stops qualifying (see `lib/opportunity-list.ts`), and the drop is remembered for
 * a cooldown so a failed pair cannot bounce straight back in.
 */
export interface OpportunityConfig {
  /** false = scan a fresh shortlist every cycle instead of keeping a list (the previous behaviour). */
  enabled: boolean;
  /** Maximum pairs held on the list. Bounded in practice by the per-cycle weight budget. */
  max: number;
  /** Consecutive failing deep scans before a pair is taken off the list. */
  strikes: number;
  /** How long a removed pair is barred from re-promotion. */
  cooldownMs: number;
}

export interface RiskPolicy {
  maxLeverage: number;
  minLeverage: number;
  maxMarginUsdt: number;
  maxNotionalUsdt: number;
  maxOpenPositions: number;
  /** Realized loss (positive number) that halts new entries for the UTC day. 0 = disabled. */
  maxDailyLossUsdt: number;
  /**
   * Non-empty = restrict scanning *and* order placement to these symbols (an operator override on
   * top of discovery). Empty = the universe is discovered from the exchange and any symbol with
   * valid exchange filters may be traded.
   */
  symbolAllowlist: string[];
  discovery: DiscoveryConfig;
  scan: ScanConfig;
  opportunity: OpportunityConfig;
  /** Ceiling on effectiveNotional / requestedNotional before the order is refused. */
  maxNotionalDeviationRatio: number;
  /** Reject stops closer than this fraction of price (0.0005 = 5bp). */
  minStopDistanceFraction: number;
  /** Master kill switch: blocks OPEN, never blocks CLOSE. */
  halted: boolean;
  /** Mainnet orders require this to be explicitly enabled. */
  allowMainnet: boolean;
  /** Only ever true when the operator opted in; drives fail-closed endpoint policy. */
  allowClientProvidedKeys: boolean;
  source: 'env' | 'defaults';
}

function intFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined || value === '' ? NaN : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function floatFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined || value === '' ? NaN : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function boolFrom(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

export function loadRiskPolicy(env: Record<string, string | undefined> = process.env): RiskPolicy {
  const rawList = (env.TRADE_SYMBOL_ALLOWLIST ?? '').trim();
  const explicitAllowlist = rawList
    ? rawList
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : [];

  const discoveryEnabled = boolFrom(env.TRADE_DISCOVERY_ENABLED, true);

  /**
   * The symbol gate has three deliberate shapes, and the operator can pick any of them:
   *
   *  - an explicit `TRADE_SYMBOL_ALLOWLIST` is always honoured, discovery or not;
   *  - discovery on with no list = the whole market (the universe is the ranked board, and the
   *    scanner + `selectBestCandidate` are what bound which pairs may be entered);
   *  - discovery off with no list = exactly the old behaviour, the built-in majors, enforced at the
   *    order layer as well as in the scanner. This is the switch that restores the narrower universe.
   */
  const symbolAllowlist =
    explicitAllowlist.length > 0 ? explicitAllowlist : discoveryEnabled ? [] : [...DEFAULT_SCANNED_SYMBOLS];

  const maxLeverage = intFrom(env.TRADE_MAX_LEVERAGE, 15, 1, 25);

  const minVolatilityPercent = floatFrom(env.TRADE_MIN_VOLATILITY_PCT, 0.6, 0, 100);
  // A ceiling below the floor would refuse every pair; treat that as an operator error and fall
  // back to the documented default rather than locking the bot out of the market.
  const rawMaxVolatility = floatFrom(env.TRADE_MAX_VOLATILITY_PCT, 4, 0, 100);
  const maxVolatilityPercent =
    rawMaxVolatility > minVolatilityPercent ? rawMaxVolatility : 4 > minVolatilityPercent ? 4 : minVolatilityPercent * 2;

  return {
    maxLeverage,
    // Strategy is designed for 10x-15x isolated; below 10x the brackets stop making sense.
    minLeverage: intFrom(env.TRADE_MIN_LEVERAGE, 10, 1, maxLeverage),
    maxMarginUsdt: floatFrom(env.TRADE_MAX_MARGIN_USDT, 25, 1, 100000),
    maxNotionalUsdt: floatFrom(env.TRADE_MAX_NOTIONAL_USDT, 500, 5, 1000000),
    maxOpenPositions: intFrom(env.TRADE_MAX_OPEN_POSITIONS, 5, 1, 20),
    maxDailyLossUsdt: floatFrom(env.TRADE_MAX_DAILY_LOSS_USDT, 50, 0, 1000000),
    symbolAllowlist,
    discovery: {
      // On by default: the operator's complaint was that only a hand-written list was ever scanned.
      enabled: discoveryEnabled,
      topN: intFrom(env.TRADE_DISCOVERY_TOP_N, 40, 1, 200),
      minQuoteVolumeUsdt: floatFrom(env.TRADE_DISCOVERY_MIN_QUOTE_VOLUME, 50_000_000, 0, 1e12),
      // One ranking per minute is plenty for a 5m strategy and keeps the browser and the engine on
      // the same board instead of each paying for its own copy.
      ttlMs: intFrom(env.TRADE_DISCOVERY_TTL_MS, 60_000, 5_000, 3_600_000),
    },
    scan: {
      // Deep-scanning more than a dozen pairs per cycle is where the weight budget starts to hurt.
      topN: intFrom(env.TRADE_SCAN_TOP_N, 12, 1, 50),
      minVolatilityPercent,
      maxVolatilityPercent,
      chopAdxFloor: floatFrom(env.TRADE_CHOP_ADX_FLOOR, 20, 0, 100),
      chopEfficiencyFloor: floatFrom(env.TRADE_CHOP_EFFICIENCY_FLOOR, 0.3, 0, 1),
    },
    opportunity: {
      // Building a list needs a market ranking, so the list cannot be on while discovery is off —
      // that combination silently means "the pinned 12 majors", which is the old behaviour.
      enabled: boolFrom(env.TRADE_OPPORTUNITY_ENABLED, true) && discoveryEnabled,
      // 20 opportunities at the default 5-position cap; the scanner bounds this again by the weight
      // budget, so asking for more than the budget allows is reported rather than paid for.
      max: intFrom(env.TRADE_OPPORTUNITY_MAX, 20, 1, 100),
      // One bad reading is a warning, not an eviction: a pair that pauses for a candle should not be
      // thrown off the list and re-discovered a minute later.
      strikes: intFrom(env.TRADE_OPPORTUNITY_STRIKES, 2, 1, 10),
      cooldownMs: intFrom(env.TRADE_OPPORTUNITY_COOLDOWN_MS, 300_000, 0, 3_600_000),
    },
    maxNotionalDeviationRatio: floatFrom(env.TRADE_MAX_NOTIONAL_DEVIATION_RATIO, 1.5, 1, 4),
    minStopDistanceFraction: floatFrom(env.TRADE_MIN_STOP_DISTANCE_PCT, 0.0005, 0.0001, 0.05),
    halted: boolFrom(env.TRADE_HALT, false),
    allowMainnet: boolFrom(env.TRADE_ALLOW_MAINNET, false),
    allowClientProvidedKeys: boolFrom(env.TRADE_ALLOW_CLIENT_KEYS, false),
    source: env.TRADE_MAX_LEVERAGE || env.TRADE_MAX_MARGIN_USDT || env.TRADE_ALLOW_MAINNET ? 'env' : 'defaults',
  };
}

export type Violation = { code: string; message: string };

export interface OpenRequestFacts {
  symbol: string;
  side: 'LONG' | 'SHORT';
  margin: number;
  leverage: number;
  openPositionsCount: number;
  /** Realized PnL so far today, negative = losing. */
  realizedPnlTodayUsdt?: number;
  isTestnet: boolean;
}

/** Validate an OPEN request against policy. Closes are always allowed (they reduce risk). */
export function validateOpenRequest(
  policy: RiskPolicy,
  facts: OpenRequestFacts
): { ok: true } | { ok: false; violations: Violation[] } {
  const violations: Violation[] = [];
  const symbol = String(facts.symbol || '').toUpperCase();

  if (policy.halted) {
    violations.push({
      code: 'TRADE_HALTED',
      message: 'New entries are halted by server policy (TRADE_HALT=true). Closing existing positions is still allowed.',
    });
  }

  if (!facts.isTestnet && !policy.allowMainnet) {
    violations.push({
      code: 'MAINNET_DISABLED',
      message:
        'Mainnet order placement is not enabled on this deployment. Set TRADE_ALLOW_MAINNET=true only after a clean testnet run, or keep the bot on testnet.',
    });
  }

  if (!symbol) {
    violations.push({ code: 'SYMBOL_REQUIRED', message: 'Trading symbol is required.' });
  } else if (policy.symbolAllowlist.length > 0 && !policy.symbolAllowlist.includes(symbol)) {
    violations.push({
      code: 'SYMBOL_NOT_ALLOWED',
      message: `${symbol} is not on the server symbol allowlist (TRADE_SYMBOL_ALLOWLIST).`,
    });
  }

  if (!Number.isFinite(facts.margin) || facts.margin <= 0) {
    violations.push({ code: 'MARGIN_INVALID', message: 'Margin must be a positive number.' });
  } else if (facts.margin > policy.maxMarginUsdt) {
    violations.push({
      code: 'MARGIN_TOO_LARGE',
      message: `Margin $${facts.margin.toFixed(2)} exceeds the server cap of $${policy.maxMarginUsdt.toFixed(2)} (TRADE_MAX_MARGIN_USDT).`,
    });
  }

  if (
    !Number.isFinite(facts.leverage) ||
    facts.leverage < policy.minLeverage ||
    facts.leverage > policy.maxLeverage
  ) {
    violations.push({
      code: 'LEVERAGE_OUT_OF_RANGE',
      message: `Leverage ${facts.leverage} is outside the permitted ${policy.minLeverage}x-${policy.maxLeverage}x band (TRADE_MAX_LEVERAGE).`,
    });
  }

  const notional = facts.margin * facts.leverage;
  if (Number.isFinite(notional) && notional > policy.maxNotionalUsdt) {
    violations.push({
      code: 'NOTIONAL_TOO_LARGE',
      message: `Requested notional $${notional.toFixed(2)} exceeds the server cap of $${policy.maxNotionalUsdt.toFixed(2)} (TRADE_MAX_NOTIONAL_USDT).`,
    });
  }

  if (facts.openPositionsCount >= policy.maxOpenPositions) {
    violations.push({
      code: 'MAX_OPEN_POSITIONS',
      message: `${facts.openPositionsCount}/${policy.maxOpenPositions} positions open — no new entries until one closes.`,
    });
  }

  const daily = Number(facts.realizedPnlTodayUsdt ?? 0);
  if (policy.maxDailyLossUsdt > 0 && daily <= -policy.maxDailyLossUsdt) {
    violations.push({
      code: 'DAILY_LOSS_BREAKER',
      message: `Daily loss breaker tripped: realized PnL today is $${daily.toFixed(2)}, beyond the $${policy.maxDailyLossUsdt.toFixed(2)} limit (TRADE_MAX_DAILY_LOSS_USDT). Entries locked for the rest of the UTC day.`,
    });
  }

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true };
}

/**
 * Daily-loss breaker, kept as its own decision so the "unknown PnL" case cannot be silently
 * treated as "no loss". `realizedPnlTodayUsdt === null` means the exchange could not be asked
 * (network/limit failure) — with a breaker configured that must FAIL CLOSED, because the whole
 * point of the breaker is to stop trading after a bad day, and a bot that keeps trading whenever
 * the income endpoint hiccups is not a breaker at all.
 */
export function dailyLossGate(
  policy: RiskPolicy,
  realizedPnlTodayUsdt: number | null
): { ok: true } | { ok: false; code: 'DAILY_LOSS_BREAKER' | 'DAILY_LOSS_UNKNOWN'; message: string } {
  if (policy.maxDailyLossUsdt <= 0) return { ok: true };

  if (realizedPnlTodayUsdt === null || !Number.isFinite(realizedPnlTodayUsdt)) {
    return {
      ok: false,
      code: 'DAILY_LOSS_UNKNOWN',
      message: `Today's realized PnL could not be read from Binance (/fapi/v1/income), so the $${policy.maxDailyLossUsdt.toFixed(2)} daily-loss breaker cannot be evaluated. Entries are locked until the exchange answers — retry in a moment.`,
    };
  }

  if (realizedPnlTodayUsdt <= -policy.maxDailyLossUsdt) {
    return {
      ok: false,
      code: 'DAILY_LOSS_BREAKER',
      message: `Daily loss breaker tripped: net realized PnL today is $${realizedPnlTodayUsdt.toFixed(2)}, beyond the $${policy.maxDailyLossUsdt.toFixed(2)} limit (TRADE_MAX_DAILY_LOSS_USDT). Entries locked for the rest of the UTC day.`,
    };
  }

  return { ok: true };
}

/**
 * USDT-M futures accounts come in two position modes. This bot is written for One-Way mode:
 * orders carry no `positionSide`, and closes use `reduceOnly`, which Hedge Mode rejects. Nothing
 * here switches the mode (that is an account-wide change that fails while positions are open), so
 * entries are refused with an actionable message instead of failing at the exchange.
 */
export function positionModeViolation(dualSidePosition: boolean): Violation | null {
  if (!dualSidePosition) return null;
  return {
    code: 'HEDGE_MODE_UNSUPPORTED',
    message:
      'This Binance account is in Hedge Mode, but the bot places One-Way orders (no positionSide, reduceOnly closes). Switch the Futures account to One-Way Mode in the Binance UI before trading. No order was sent.',
  };
}

/** Public-safe summary for the UI (never exposes secrets). */
export function policySummary(policy: RiskPolicy) {
  return {
    maxLeverage: policy.maxLeverage,
    minLeverage: policy.minLeverage,
    maxMarginUsdt: policy.maxMarginUsdt,
    maxNotionalUsdt: policy.maxNotionalUsdt,
    maxOpenPositions: policy.maxOpenPositions,
    maxDailyLossUsdt: policy.maxDailyLossUsdt,
    symbolAllowlist: policy.symbolAllowlist,
    discovery: policy.discovery,
    scan: policy.scan,
    opportunity: policy.opportunity,
    halted: policy.halted,
    mainnetAllowed: policy.allowMainnet,
    clientKeysAllowed: policy.allowClientProvidedKeys,
    source: policy.source,
  };
}
