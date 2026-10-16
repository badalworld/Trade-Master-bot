/**
 * Pure diagnosis for `GET /api/config/check`.
 *
 * Answers the question operators actually ask — "why isn't my key active?" — by turning the
 * deployment's configuration, reachability and verification facts into one verdict plus a list of
 * explicit, actionable issues. Kept free of I/O so every branch is unit-testable.
 */

import type { BinanceFailure } from './binance-errors';

export type ConfigIssueSeverity = 'blocker' | 'warning';

export interface ConfigIssue {
  code: string;
  severity: ConfigIssueSeverity;
  title: string;
  detail: string;
  action: string;
}

export interface ReachabilityProbe {
  reachable: boolean;
  latencyMs: number | null;
  /** null while the probe is inconclusive. */
  failure: BinanceFailure | null;
}

export interface ConfigCheckInput {
  operator: { required: boolean; configured: boolean; authenticated: boolean; mode: string };
  keys: {
    apiKeyPresent: boolean;
    apiSecretPresent: boolean;
    /** Raw `BINANCE_TESTNET` string, null when the variable is unset. */
    testnetRaw: string | null;
    isTestnet: boolean;
  };
  credentials: { source: 'env' | 'session' | 'none'; keyHint: string | null };
  verification: { attempted: boolean; ok: boolean; failure: BinanceFailure | null };
  reachability: { testnet: ReachabilityProbe; mainnet: ReachabilityProbe };
  engine: { enabled: boolean; autoEntry: boolean; running: boolean };
  ledger: { durable: boolean; path: string };
  policy: {
    halted: boolean;
    allowMainnet: boolean;
    maxMarginUsdt: number;
    maxDailyLossUsdt: number;
    maxOpenPositions: number;
    /** Universe settings, so an operator can see which pairs the bot is allowed to reach. */
    discovery?: {
      enabled: boolean;
      topN: number;
      minQuoteVolumeUsdt: number;
    };
    scan?: {
      topN: number;
      minVolatilityPercent: number;
      maxVolatilityPercent: number;
      chopAdxFloor: number;
      chopEfficiencyFloor: number;
    };
    symbolAllowlist?: string[];
  };
}

export type ConfigVerdict =
  | 'LOCKED_OPERATOR_TOKEN_MISSING'
  | 'NO_CREDENTIALS'
  | 'GEO_BLOCKED'
  | 'BINANCE_UNREACHABLE'
  | 'CREDENTIALS_REJECTED'
  | 'MAINNET_LOCKED'
  | 'READY_TESTNET'
  | 'READY_MAINNET';

export interface ConfigCheckResult {
  verdict: ConfigVerdict;
  headline: string;
  targetNetwork: 'testnet' | 'mainnet';
  issues: ConfigIssue[];
}

const issue = (
  code: string,
  severity: ConfigIssueSeverity,
  title: string,
  detail: string,
  action: string
): ConfigIssue => ({ code, severity, title, detail, action });

export function buildConfigCheck(input: ConfigCheckInput): ConfigCheckResult {
  const { operator, keys, credentials, verification, reachability, engine, ledger, policy } = input;
  const targetNetwork: 'testnet' | 'mainnet' = keys.isTestnet ? 'testnet' : 'mainnet';
  const issues: ConfigIssue[] = [];
  const envKeysPresent = keys.apiKeyPresent && keys.apiSecretPresent;
  let unreachableReported = false;

  // ---------------------------------------------------------------------------------------------
  // Blockers — trading cannot work until these are fixed
  // ---------------------------------------------------------------------------------------------

  const operatorLocked = operator.required && !operator.configured;
  if (operatorLocked) {
    issues.push(
      issue(
        'OPERATOR_TOKEN_MISSING',
        'blocker',
        'Server Binance keys are set but TM_OPERATOR_TOKEN is not',
        'Order placement, closes, account reads and engine controls would be reachable by anyone who can open this URL, so every money endpoint deliberately refuses with 503 OPERATOR_AUTH_NOT_CONFIGURED.',
        'Set TM_OPERATOR_TOKEN to a random value of at least 32 characters (e.g. `openssl rand -hex 32`) as a secret/variable on the platform, then redeploy and sign in once from the UI.'
      )
    );
  }

  const anyEnvKey = keys.apiKeyPresent || keys.apiSecretPresent;
  const partialEnvKeys = anyEnvKey && !envKeysPresent;

  if (partialEnvKeys) {
    // The more specific cause wins: "half a key pair" is a different fix from "no keys at all".
    issues.push(
      issue(
        'PARTIAL_ENV_KEYS',
        'blocker',
        `Only ${keys.apiKeyPresent ? 'BINANCE_API_KEY' : 'BINANCE_API_SECRET'} is set`,
        'Both halves of the pair are required. With one missing the server resolves no env credentials at all and falls back to a browser session.',
        `Add the missing ${keys.apiKeyPresent ? 'BINANCE_API_SECRET' : 'BINANCE_API_KEY'} as a secret on the platform, then redeploy.`
      )
    );
  } else if (credentials.source === 'none') {
    issues.push(
      issue(
        'NO_CREDENTIALS',
        'blocker',
        'No Binance credentials are available to the server',
        'Neither BINANCE_API_KEY/BINANCE_API_SECRET nor an authenticated browser session is present, so the bot cannot read the account or place orders.',
        'Set BINANCE_API_KEY and BINANCE_API_SECRET (Secrets tab) for unattended operation, or connect keys once in Settings → Binance Connection.'
      )
    );
  }

  const reach = targetNetwork === 'testnet' ? reachability.testnet : reachability.mainnet;
  const reachCode = reach.failure?.code;
  const geoBlocked =
    reachCode === 'GEO_BLOCKED' || (verification.attempted && verification.failure?.code === 'GEO_BLOCKED');
  const failureCode = verification.failure?.code ?? 'CREDENTIALS_REJECTED';
  const failureIsTransport = failureCode === 'NETWORK_UNREACHABLE' || failureCode === 'TIMEOUT';

  if (geoBlocked) {
    issues.push(
      issue(
        'GEO_BLOCKED',
        'blocker',
        `Binance refuses requests from this deployment's location (${targetNetwork}, HTTP 451)`,
        reach.failure?.title ??
          verification.failure?.title ??
          'Binance decided this from the source IP before authentication, so no key can work.',
        reach.failure?.action ?? verification.failure?.action ?? 'Move the deployment to a permitted region.'
      )
    );
  } else if (!reach.reachable && envKeysPresent) {
    // One connectivity blocker, not two: the verification below would report the same transport
    // failure again, which reads like two separate problems.
    unreachableReported = true;
    issues.push(
      issue(
        'BINANCE_UNREACHABLE',
        'blocker',
        `This server cannot reach Binance ${targetNetwork} (${reach.failure?.code ?? 'UNREACHABLE'})`,
        reach.failure?.title ?? 'The public ping did not answer, so no authenticated call can either.',
        reach.failure?.action ??
          'Check the deployment egress (DNS resolution and outbound HTTPS), then re-run this check.'
      )
    );
  }

  if (
    verification.attempted &&
    !verification.ok &&
    !geoBlocked &&
    !(failureIsTransport && unreachableReported)
  ) {
    const f = verification.failure;
    issues.push(
      issue(
        failureCode,
        'blocker',
        f?.title ?? 'Binance rejected the configured credentials',
        `The credentials resolved from ${credentials.source === 'env' ? 'server environment variables' : 'the browser session'} were refused by the ${targetNetwork} endpoint.`,
        f?.action ?? 'Verify the key, its permissions and its IP restriction in Binance API Management.'
      )
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Warnings — works, but not as safely / not as expected
  // ---------------------------------------------------------------------------------------------

  if (keys.testnetRaw === null) {
    issues.push(
      issue(
        'TESTNET_FLAG_UNSET',
        'warning',
        'BINANCE_TESTNET is not set, so this deployment is on TESTNET (paper funds)',
        'Testnet is the safe default. Every order goes to testnet.binancefuture.com with testnet-only keys, no matter what the browser toggle says.',
        'This is expected while validating. To trade real money later, set BINANCE_TESTNET=false AND TRADE_ALLOW_MAINNET=true, and use mainnet keys.'
      )
    );
  }

  if (credentials.source === 'session' && operator.required) {
    issues.push(
      issue(
        'SESSION_CREDENTIALS_EPHEMERAL',
        'warning',
        'Credentials come from a browser session, not from server secrets',
        'Browser-supplied keys live in server memory only and are lost on every restart or redeploy (which also stops the bot); the unattended engine cannot use them at all.',
        'For hands-off operation, set BINANCE_API_KEY / BINANCE_API_SECRET and TM_OPERATOR_TOKEN as secrets instead.'
      )
    );
  }

  if (!engine.enabled) {
    issues.push(
      issue(
        'ENGINE_DISABLED',
        'warning',
        'The server-side engine is off (TRADE_ENGINE_ENABLED is not true)',
        'Positions are only monitored while a browser tab is open; nothing re-arms a missing stop or settles the ledger when the tab closes.',
        'To enable unattended protection, set TRADE_ENGINE_ENABLED=true (keep TRADE_ENGINE_AUTO_ENTRY=false at first: guardian only, it protects but never opens).'
      )
    );
  } else if (!engine.running) {
    issues.push(
      issue(
        'ENGINE_NOT_RUNNING',
        'warning',
        'The engine is enabled but not running',
        'It did not start at boot — most often because no server-side credentials were available, or the ledger belongs to the other network.',
        'Check the engine panel events for START_REFUSED / NETWORK_MISMATCH, fix the cause, then start it.'
      )
    );
  }

  if (!ledger.durable) {
    issues.push(
      issue(
        'LEDGER_EPHEMERAL',
        'warning',
        `The trade ledger is not writable at ${ledger.path}`,
        'Without a writable ledger the engine cannot persist positions, compounding or the daily-loss figure across restarts.',
        'Point TRADE_DATA_DIR at a mounted, writable volume (on a container the default location dies with the instance).'
      )
    );
  }

  const discovery = policy.discovery;
  const scan = policy.scan;
  if (discovery && !discovery.enabled && (policy.symbolAllowlist ?? []).length === 0) {
    issues.push(
      issue(
        'UNIVERSE_FIXED_LIST',
        'warning',
        'Market discovery is OFF: only the built-in major list is scanned',
        'TRADE_DISCOVERY_ENABLED=false pins the universe to the 12 built-in majors, so any more volatile pair listed on Binance is invisible to the scanner.',
        'Set TRADE_DISCOVERY_ENABLED=true to rank the whole USDT-M market each scan (or set TRADE_SYMBOL_ALLOWLIST to name the pairs you do want).'
      )
    );
  }
  if (discovery?.enabled && (policy.symbolAllowlist ?? []).length === 0 && scan) {
    issues.push(
      issue(
        'UNIVERSE_MARKET_WIDE',
        'warning',
        'The whole market is tradeable: entries are bounded by the scan funnel, not by a symbol list',
        `Ranking every USDT-M perpetual with at least $${(discovery.minQuoteVolumeUsdt / 1_000_000).toFixed(0)}M of 24h turnover, deep-scanning the most volatile ${scan.topN}, and refusing chop (ADX<${scan.chopAdxFloor} and ER<${scan.chopEfficiencyFloor}) and out-of-band volatility (${scan.minVolatilityPercent}%-${scan.maxVolatilityPercent}%). Pairs outside that funnel cannot be entered by the bot.`,
        'Set TRADE_SYMBOL_ALLOWLIST to restrict the bot to named pairs, or TRADE_DISCOVERY_ENABLED=false to go back to the built-in major list.'
      )
    );
  }
  if (scan && scan.minVolatilityPercent >= scan.maxVolatilityPercent) {
    issues.push(
      issue(
        'VOLATILITY_BAND_EMPTY',
        'blocker',
        'The volatility band cannot be satisfied: the floor is not below the ceiling',
        `TRADE_MIN_VOLATILITY_PCT=${scan.minVolatilityPercent} and TRADE_MAX_VOLATILITY_PCT=${scan.maxVolatilityPercent} refuse every pair, so no entry can ever be taken.`,
        'Set a floor strictly below the ceiling, e.g. TRADE_MIN_VOLATILITY_PCT=0.6 and TRADE_MAX_VOLATILITY_PCT=4.'
      )
    );
  }

  if (policy.halted) {
    issues.push(
      issue(
        'TRADE_HALTED',
        'warning',
        'TRADE_HALT is on: new entries are blocked',
        'Closes and stop protection still work, so an existing position can always be unwound.',
        'Set TRADE_HALT=false (or use Resume entries in the engine panel) when you intend to open new positions.'
      )
    );
  }

  if (targetNetwork === 'mainnet' && !policy.allowMainnet && !geoBlocked) {
    issues.push(
      issue(
        'MAINNET_LOCKED',
        'warning',
        'These are MAINNET credentials, but order placement is still locked',
        'The server refuses every real-money order while TRADE_ALLOW_MAINNET is false, regardless of what the browser requests.',
        'Complete a clean testnet run first, then set TRADE_ALLOW_MAINNET=true and confirm with "I UNDERSTAND" in the UI.'
      )
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Verdict
  // ---------------------------------------------------------------------------------------------

  let verdict: ConfigVerdict;
  if (operatorLocked) verdict = 'LOCKED_OPERATOR_TOKEN_MISSING';
  else if (geoBlocked) verdict = 'GEO_BLOCKED';
  else if (!reach.reachable && envKeysPresent) verdict = 'BINANCE_UNREACHABLE';
  else if (credentials.source === 'none' || partialEnvKeys || !envKeysPresent) {
    verdict = 'NO_CREDENTIALS';
  } else if (verification.attempted && !verification.ok && failureIsTransport) verdict = 'BINANCE_UNREACHABLE';
  else if (verification.attempted && !verification.ok) verdict = 'CREDENTIALS_REJECTED';
  else if (targetNetwork === 'mainnet' && !policy.allowMainnet) verdict = 'MAINNET_LOCKED';
  else verdict = targetNetwork === 'testnet' ? 'READY_TESTNET' : 'READY_MAINNET';

  const headline: Record<ConfigVerdict, string> = {
    LOCKED_OPERATOR_TOKEN_MISSING:
      'Locked: server Binance keys exist but no TM_OPERATOR_TOKEN is configured, so all money endpoints answer 503 by design.',
    NO_CREDENTIALS:
      'No usable credentials: the server has no complete Binance key pair (and/or no verified browser session).',
    GEO_BLOCKED: "Geo-blocked: Binance refuses this server's location (HTTP 451). Only moving the deployment can fix it.",
    BINANCE_UNREACHABLE: 'Unreachable: this server cannot reach Binance. No credential would work until egress is fixed.',
    CREDENTIALS_REJECTED: 'Credentials rejected by the exchange — see the blocker below for the exact cause.',
    MAINNET_LOCKED: 'Configured for mainnet but locked: TRADE_ALLOW_MAINNET is false, so no real order can be sent yet.',
    READY_TESTNET: 'Ready on TESTNET (paper funds): credentials verified and reachable. No real money is at risk.',
    READY_MAINNET: 'Ready on MAINNET: credentials verified, reachable, and live order placement is enabled.',
  };

  return { verdict, headline: headline[verdict], targetNetwork, issues };
}
