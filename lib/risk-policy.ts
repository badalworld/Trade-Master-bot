/**
 * Server-side risk policy for Trade Master.
 *
 * The client UI is *not* a security boundary: it clamps leverage to 10-15x, but a route that
 * trusts the client can be driven to any size by a bug in the loop, a replayed request, or a
 * stolen key. Every number that limits loss is therefore re-checked here, on the server, from env.
 *
 * Pure + env-injected so it is unit-testable without Next.
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

export interface RiskPolicy {
  maxLeverage: number;
  minLeverage: number;
  maxMarginUsdt: number;
  maxNotionalUsdt: number;
  maxOpenPositions: number;
  /** Realized loss (positive number) that halts new entries for the UTC day. 0 = disabled. */
  maxDailyLossUsdt: number;
  /** Empty array = allow any symbol on the exchange. */
  symbolAllowlist: string[];
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
  const symbolAllowlist = rawList
    ? rawList
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : [...DEFAULT_SCANNED_SYMBOLS];

  const maxLeverage = intFrom(env.TRADE_MAX_LEVERAGE, 15, 1, 25);

  return {
    maxLeverage,
    // Strategy is designed for 10x-15x isolated; below 10x the brackets stop making sense.
    minLeverage: intFrom(env.TRADE_MIN_LEVERAGE, 10, 1, maxLeverage),
    maxMarginUsdt: floatFrom(env.TRADE_MAX_MARGIN_USDT, 25, 1, 100000),
    maxNotionalUsdt: floatFrom(env.TRADE_MAX_NOTIONAL_USDT, 500, 5, 1000000),
    maxOpenPositions: intFrom(env.TRADE_MAX_OPEN_POSITIONS, 5, 1, 20),
    maxDailyLossUsdt: floatFrom(env.TRADE_MAX_DAILY_LOSS_USDT, 50, 0, 1000000),
    symbolAllowlist,
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
    halted: policy.halted,
    mainnetAllowed: policy.allowMainnet,
    clientKeysAllowed: policy.allowClientProvidedKeys,
    source: policy.source,
  };
}
