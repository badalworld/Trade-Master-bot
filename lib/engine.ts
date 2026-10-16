/**
 * Unattended server-side engine: the part that must keep working when the browser tab is closed.
 *
 * Two jobs, deliberately separated:
 *
 *  GUARDIAN (always on once enabled): reconcile the ledger against the exchange, verify each
 *  position this app opened still has a live protective stop on the book, replace it if it was
 *  cancelled, flatten if a stop cannot be established, and settle trades from the exchange's own
 *  income ledger. This is risk control, and it never opens anything.
 *
 *  ENTRY (off by default, `TRADE_ENGINE_AUTO_ENTRY=true`): scan the universe and submit entries
 *  through the exact same `lib/order-executor` path the UI uses.
 *
 * Positions the engine did not open are reported as `foreign` and never traded — the app must not
 * start closing money the user placed by hand.
 */

import {
  BinanceApiError,
  type BinanceCreds,
  getAccount,
  getConditionalOrders,
  type ConditionalOrder,
  getLivePositions,
  type LivePosition,
  getRealizedPnlToday,
  getSettledPnlSince,
  placeBracketOrder,
} from './binance-client.ts';
import { formatToStep } from './exchange-specs.ts';
import {
  classifyError,
  failureMessage,
  toRawFailure,
  type BinanceFailure,
  type BinanceFailureCode,
} from './binance-errors.ts';
import { closePosition, getSpecMap, openPosition, type OpenSuccess, type RecoveryBody } from './order-executor.ts';
import {
  classifyExit,
  detectBreach,
  evaluateEntryGate,
  findProtectiveStop,
  planBracketEnforcement,
} from './guardian.ts';
import { resolveOpportunityCap, scanUniverse, selectBestCandidate } from './market-data.ts';
import { loadOpportunityList, saveOpportunityList } from './opportunity-store.ts';
import { describeOpportunityChange } from './opportunity-list.ts';
import { ledger } from './position-ledger.ts';
import { loadRiskPolicy, type RiskPolicy } from './risk-policy.ts';
import { envCredentials } from './trade-guard.ts';
import { roundCryptoPrice, type ClosedTrade } from './trading-engine.ts';

export interface EngineConfig {
  enabled: boolean;
  autoEntry: boolean;
  enforceBrackets: boolean;
  /**
   * Open positions even though the ledger cannot be persisted. Off by default: it is the difference
   * between "a restart loses the daily-loss memory and the record of which positions are ours" and
   * "the bot does not trade until the data directory is fixed".
   */
  allowNonDurableLedger: boolean;
  intervalMs: number;
  /** Cycles a stop can stay missing before the position is flattened to protect capital. */
  unprotectedTolerance: number;
  leverage: number;
  /** Seed values for the server-side compounding ladder. */
  baseMargin: number;
  compoundingPercent: number;
}

export interface EngineEvent {
  at: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';
  kind: string;
  message: string;
}

export interface EngineStatus {
  running: boolean;
  config: EngineConfig;
  credentialSource: 'env' | 'none';
  network: 'testnet' | 'mainnet';
  cycles: number;
  startedAt: number | null;
  lastCycleAt: number | null;
  lastCycleDurationMs: number | null;
  nextCycleAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  /**
   * Classified diagnosis of `lastError` — what actually happened and what to do about it. The raw
   * message alone is what let an operator stare at "Mandatory parameter 'timestamp' was not sent" and
   * go looking for a broken API key.
   */
  lastFailure: EngineFailureSummary | null;
  cooldownUntil: number | null;
  entriesHalted: boolean;
  dailyLossLocked: boolean;
  realizedPnlTodayUsdt: number;
  ownedPositions: number;
  foreignPositions: string[];
  unprotectedPositions: string[];
  lastScan: {
    at: number;
    ok: boolean;
    signals: number;
    failures: number;
    /** Stage-1 output: how much of the market was ranked, and where the board came from. */
    board: { source: 'binance' | 'fallback'; universeSize: number; liquidCount: number } | null;
    /** Pairs the funnel refused this cycle, by reason (choppy, vol-below-floor, ...). */
    skipped: Record<string, number>;
    /** True when a candidate was found and an entry was attempted. */
    selected: string | null;
    /**
     * The opportunity list after this cycle: how many assets it holds, which joined, which left and
     * why, and which are only warned. Null when the list is disabled.
     */
    opportunity: EngineOpportunitySummary | null;
  } | null;
  events: EngineEvent[];
  ledgerDurable: boolean;
  /** Where the ledger is written, and the last persistence error if there was one. */
  ledgerPath: string;
  ledgerError: string | null;
  /** Writes that failed since start — a counter, because the log only prints the first of each kind. */
  ledgerFailures: number;
}

/**
 * The opportunity list as the engine reports it: what the fast-path universe held this cycle, what
 * joined, what left and why. Shared by the status payload and the UI.
 */
export interface EngineOpportunitySummary {
  size: number;
  cap: number;
  scanned: number;
  held: string[];
  promoted: string[];
  removed: { symbol: string; reason: string; detail: string }[];
  warned: { symbol: string; strikes: number; reason: string }[];
  /** Age of the market ranking the list was reconciled against, in ms. */
  boardAgeMs: number;
  durable: boolean;
}

export interface EngineFailureSummary {
  code: BinanceFailureCode;
  title: string;
  action: string;
  retryable: boolean;
  at: number;
  /** Consecutive cycles that failed this same way (1 = first occurrence). */
  repeats: number;
  /** Binance's own words, kept verbatim for bug reports. */
  raw: string;
}

/** What the previous failed cycle ended on, so a repeat can be recognised as a repeat. */
export interface EngineFailureStreak {
  code: BinanceFailureCode;
  repeats: number;
}

export interface CycleFailurePlan {
  failure: BinanceFailure;
  /** Consecutive occurrences of this same failure, this cycle included. */
  repeats: number;
  /** Whether to emit an event this cycle — repeats are throttled (see `planCycleFailure`). */
  log: boolean;
  kind: 'CYCLE_FAILED' | 'CYCLE_STILL_FAILING';
  level: 'ERROR' | 'WARN';
  message: string;
  /** Idle time before the next attempt; 0 keeps the normal cycle interval. */
  cooldownMs: number;
}

const MAX_EVENTS = 60;
const MIN_INTERVAL_MS = 5000;
const COOLDOWN_MS = 60_000;
/** Slow poll for failures no retry can fix — long enough to spare the API, short enough to notice a fix. */
const BACKOFF_MS = 120_000;
/** Identical answers in a row before a deterministic failure is treated as settled, not a blip. */
const DETERMINISTIC_TOLERANCE = 3;
/** After the first line, log the same repeating failure once every N cycles instead of every cycle. */
const REPEAT_LOG_EVERY = 20;

/**
 * Failures that only a human can clear: the exchange has given a definite answer and re-asking
 * cannot change it. Transient classes (network, timeout, rate limit) are deliberately absent — for
 * those, retrying soon *is* the fix.
 */
const DETERMINISTIC_CODES = new Set<BinanceFailureCode>([
  'GEO_BLOCKED',
  'INVALID_KEY',
  'IP_NOT_ALLOWED',
  'KEY_NETWORK_MISMATCH',
  'SIGNATURE_INVALID',
  'TIMESTAMP_DRIFT',
  'REQUEST_INVALID',
  'UNKNOWN',
]);

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

export function loadEngineConfig(env: Record<string, string | undefined> = process.env): EngineConfig {
  return {
    // Off unless explicitly enabled: an applet must not start trading by itself when deployed.
    enabled: bool(env.TRADE_ENGINE_ENABLED, false),
    autoEntry: bool(env.TRADE_ENGINE_AUTO_ENTRY, false),
    enforceBrackets: bool(env.TRADE_ENGINE_ENFORCE_BRACKETS, true),
    // Default false: fail closed on the money path. Set true only if you accept an in-memory ledger.
    allowNonDurableLedger: bool(env.TRADE_ENGINE_ALLOW_NON_DURABLE_LEDGER, false),
    intervalMs: Math.max(MIN_INTERVAL_MS, parseInt(env.TRADE_ENGINE_INTERVAL_MS ?? '15000', 10) || 15000),
    unprotectedTolerance: Math.max(0, parseInt(env.TRADE_ENGINE_UNPROTECTED_TOLERANCE ?? '2', 10) || 2),
    leverage: Math.min(15, Math.max(1, parseInt(env.TRADE_ENGINE_LEVERAGE ?? '10', 10) || 10)),
    baseMargin: Math.max(1, parseFloat(env.TRADE_ENGINE_BASE_MARGIN ?? '2') || 2),
    compoundingPercent: Math.min(100, Math.max(0, parseFloat(env.TRADE_ENGINE_COMPOUNDING_PCT ?? '20') || 20)),
  };
}

/**
 * Decide what a failed cycle should say, and how soon it should try again.
 *
 * Pure on purpose. The loop's most consequential recovery behaviour — does it hammer the exchange
 * every 15s and print one identical ERROR per cycle, or does it settle down and keep an eye on the
 * problem? — has to be reviewable and testable without a live exchange.
 *
 * Two shapes of failure were previously treated identically:
 *
 *  - TRANSIENT (network, timeout, rate limit): retrying soon is the fix, so the cadence is untouched.
 *  - DETERMINISTIC (bad key, IP not on the whitelist, geo-block, malformed request): no retry changes
 *    the answer, only a human can. Retrying every 15s burns API weight and buries the one line that
 *    matters under identical copies of itself — the log this was written for held 60 copies of the
 *    same error in twelve minutes. After a few attempts the loop settles into a slow poll and repeats
 *    the line only occasionally. It never stops polling: the fix happens on Binance's side (a key
 *    regenerated, an IP whitelisted) and has to be picked up without anyone restarting the app.
 */
export function planCycleFailure(
  err: unknown,
  opts: { isTestnet: boolean; previous?: EngineFailureStreak | null }
): CycleFailurePlan {
  const failure = classifyError(err, opts.isTestnet);
  const raw = toRawFailure(err).message;
  const repeats = opts.previous?.code === failure.code ? opts.previous.repeats + 1 : 1;
  const first = repeats === 1;
  const binanceCode = failure.binanceCode !== null ? `, binance ${failure.binanceCode}` : '';

  return {
    failure,
    repeats,
    log: first || repeats % REPEAT_LOG_EVERY === 0,
    kind: first ? 'CYCLE_FAILED' : 'CYCLE_STILL_FAILING',
    level: first ? 'ERROR' : 'WARN',
    message: first
      ? `${failureMessage(failure)} [${failure.code}${binanceCode}] — Binance said: ${raw}`
      : `repeat ${repeats}, same failure [${failure.code}${binanceCode}]: ${failure.title} — ${failure.action}`,
    cooldownMs: cooldownForFailure(failure.code, repeats),
  };
}

/**
 * How long to wait before asking again. Rate limits keep the existing 60s window reset; a
 * deterministic failure earns a slower poll once it has proved it is not a blip.
 */
function cooldownForFailure(code: BinanceFailureCode, repeats: number): number {
  if (code === 'RATE_LIMITED') return COOLDOWN_MS;
  if (repeats < DETERMINISTIC_TOLERANCE) return 0;
  return DETERMINISTIC_CODES.has(code) ? BACKOFF_MS : 0;
}

type Timer = ReturnType<typeof setTimeout>;

class TradeEngine {
  private timer: Timer | null = null;
  private running = false;
  private busy = false;
  private haltEntries = false;
  /** The failure the previous cycle ended on, so an identical one can be recognised as a repeat. */
  private failureStreak: EngineFailureStreak | null = null;
  /** Reported once instead of every cycle, so a non-durable volume cannot drown the log. */
  private opportunityDurabilityWarned = false;
  private ledgerDurabilityWarned = false;
  private status: EngineStatus;
  private events: EngineEvent[] = [];

  constructor() {
    this.status = {
      running: false,
      config: loadEngineConfig(),
      credentialSource: 'none',
      network: 'testnet',
      cycles: 0,
      startedAt: null,
      lastCycleAt: null,
      lastCycleDurationMs: null,
      nextCycleAt: null,
      lastError: null,
      lastErrorAt: null,
      lastFailure: null,
      cooldownUntil: null,
      entriesHalted: false,
      dailyLossLocked: false,
      realizedPnlTodayUsdt: 0,
      ownedPositions: 0,
      foreignPositions: [],
      unprotectedPositions: [],
      lastScan: null,
      events: [],
      ledgerDurable: false,
      ledgerPath: '',
      ledgerError: null,
      ledgerFailures: 0,
    };
  }

  /**
   * Say once — in the operator's language, with the actual path and the fix — that the ledger cannot
   * be written. `writeState` already keeps the repeated failures out of the log; this is the line
   * that explains what it means for a trading bot, and it is refreshed in the status every cycle so
   * the panel and `/api/config/check` show it without anyone reading logs.
   */
  private reportLedgerDurability(): void {
    const persistence = ledger.persistence();
    this.status = {
      ...this.status,
      ledgerDurable: persistence.durable,
      ledgerPath: persistence.path,
      ledgerError: persistence.error,
      ledgerFailures: persistence.failures,
    };

    if (persistence.durable) return;
    if (this.ledgerDurabilityWarned) return;
    this.ledgerDurabilityWarned = true;

    const entriesNote = this.status.config.autoEntry
      ? this.status.config.allowNonDurableLedger
        ? 'Automated entries continue because TRADE_ENGINE_ALLOW_NON_DURABLE_LEDGER=true.'
        : 'Automated entries are REFUSED until this is fixed (the daily-loss breaker and the record of which positions are ours would reset on every restart).'
      : 'Guardian-only mode is unaffected: existing positions are still protected.';
    this.log(
      'WARN',
      'LEDGER_NOT_DURABLE',
      `The trade ledger cannot be written to ${persistence.path}${persistence.error ? ` (${persistence.error})` : ''}. ` +
        `Everything the engine keeps — positions, compounding, today's realized loss — lives only in memory and is lost when this process restarts. ` +
        `${entriesNote} Fix: mount a writable volume and point TRADE_DATA_DIR at it (on Cloud Run the default /app path is read-only; /tmp works but dies with the instance).`
    );
  }

  private log(level: EngineEvent['level'], kind: string, message: string): void {
    const event = { at: Date.now(), level, kind, message };
    this.events = [event, ...this.events].slice(0, MAX_EVENTS);
    const line = `[engine:${level.toLowerCase()}] ${kind}: ${message}`;
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
  }

  /** Env credentials only: an unattended loop cannot depend on a browser session cookie. */
  private creds(): BinanceCreds | null {
    const env = envCredentials();
    if (!env) return null;
    return { apiKey: env.apiKey, apiSecret: env.apiSecret, isTestnet: env.isTestnet };
  }

  start(): { ok: boolean; message: string } {
    if (this.running) return { ok: true, message: 'Engine already running' };
    const creds = this.creds();
    if (!creds) {
      const message =
        'Engine not started: BINANCE_API_KEY / BINANCE_API_SECRET are required for unattended operation (a browser session cannot outlive the tab).';
      this.log('ERROR', 'START_REFUSED', message);
      return { ok: false, message };
    }

    const network = creds.isTestnet ? ('testnet' as const) : ('mainnet' as const);
    const ledgerNetwork = ledger.getNetwork();
    if (ledgerNetwork && ledgerNetwork !== network) {
      const message =
        `The saved ledger belongs to ${ledgerNetwork} but credentials now point at ${network}. Refusing to start: those positions belong to a different account. ` +
        `Clear it (or point the keys back at ${ledgerNetwork}) before continuing.`;
      this.log('ERROR', 'NETWORK_MISMATCH', message);
      return { ok: false, message };
    }
    ledger.setNetwork(network);

    const config = loadEngineConfig();
    // Entries may also be switched on from the app itself (persisted), so "fully automated" does not
    // require redeploying with a new environment variable every time.
    const persistedAutopilot = ledger.getAutopilot().serverEntries && (!ledger.getNetwork() || ledger.getNetwork() === network);
    const effective = { ...config, autoEntry: config.autoEntry || persistedAutopilot };
    ledger.setPolicyInputs(config.baseMargin, config.compoundingPercent);
    this.status = {
      ...this.status,
      config: effective,
      running: true,
      credentialSource: 'env',
      network,
      startedAt: Date.now(),
      ledgerDurable: ledger.isDurable(),
    };
    this.running = true;
    this.schedule(0);
    this.reportLedgerDurability();
    this.log(
      'SUCCESS',
      'STARTED',
      `Guardian loop active on ${creds.isTestnet ? 'testnet' : 'MAINNET'} every ${Math.round(config.intervalMs / 1000)}s · auto-entry ${effective.autoEntry ? `ON (${config.autoEntry ? 'env' : 'autopilot switch'})` : 'OFF (guardian only)'} · bracket enforcement ${effective.enforceBrackets ? 'ON' : 'OFF'}`
    );
    if (!creds.isTestnet && !effective.autoEntry) {
      this.log('WARN', 'MAINNET_GUARDIAN', 'Guardian is running against MAINNET: it can close positions but will not open them unless TRADE_ENGINE_AUTO_ENTRY=true.');
    }
    return { ok: true, message: 'Engine started' };
  }

  stop(reason = 'stopped by operator'): { ok: boolean; message: string } {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = false;
    this.status = { ...this.status, running: false, nextCycleAt: null };
    ledger.flush();
    const persistence = ledger.persistence();
    this.log(
      'WARN',
      'STOPPED',
      persistence.durable
        ? `Engine ${reason}; ledger flushed to disk.`
        : `Engine ${reason}; the in-memory ledger was NOT persisted (${persistence.error ?? 'the data directory is not writable'}). ` +
          'Positions, compounding and the daily-loss figure are lost when this process ends.'
    );
    return { ok: true, message: `Engine ${reason}` };
  }

  /**
   * Flip server-side entries without a redeploy. Turning it on is refused while the engine is not
   * running against a network whose order gate is closed, because the switch must never become a way
   * to sneak past `TRADE_ALLOW_MAINNET` - that check still runs on every single order.
   */
  setAutoEntry(enabled: boolean, confirm?: string): { ok: boolean; message: string; requiresConfirm?: boolean } {
    const envEnabled = loadEngineConfig().autoEntry;
    // Which network would this setting actually trade on? The status field cannot answer that: before
    // the first start it still holds the safe default, so keying the confirmation off it let
    // "unattended MAINNET entries" be armed on an idle engine with nobody confirming anything.
    const creds = this.creds();
    if (enabled && !creds) {
      return {
        ok: false,
        message:
          'Nothing to enable: the unattended loop needs BINANCE_API_KEY / BINANCE_API_SECRET on the server ' +
          '(a browser session cannot outlive the tab).',
      };
    }
    const network = creds && !creds.isTestnet ? ('mainnet' as const) : ('testnet' as const);
    if (enabled && network === 'mainnet' && !envEnabled && String(confirm ?? '').trim().toUpperCase() !== 'ENABLE_AUTOPILOT') {
      return {
        ok: false,
        requiresConfirm: true,
        message:
          'Enabling unattended MAINNET entries needs an explicit confirmation (and TRADE_ALLOW_MAINNET must ' +
          'already be true). Re-send with confirm:"ENABLE_AUTOPILOT".',
      };
    }
    ledger.setAutopilot({ serverEntries: enabled });
    this.status = { ...this.status, config: { ...this.status.config, autoEntry: enabled || envEnabled } };
    const message = enabled
      ? `Server-side entries on ${network} ${this.running ? 'enabled' : 'saved; they start with the next engine start'}: the loop will scan, open and bracket positions on its own (all still bounded by the risk policy).`
      : `Server-side entries ${this.running ? 'disabled; the loop is guardian-only again' : 'cleared from the saved settings'}.`;
    this.log(enabled ? 'WARN' : 'INFO', enabled ? 'AUTOPILOT_ON' : 'AUTOPILOT_OFF', message);
    return { ok: true, message };
  }

  setHaltEntries(halt: boolean): { ok: boolean; message: string } {
    this.haltEntries = halt;
    this.status = { ...this.status, entriesHalted: halt };
    this.log('WARN', halt ? 'ENTRIES_HALTED' : 'ENTRIES_RESUMED', halt ? 'New entries halted; closes and protection continue.' : 'Entries re-enabled.');
    return { ok: true, message: halt ? 'Entries halted' : 'Entries resumed' };
  }

  getStatus(): EngineStatus {
    // Durability and policy are read live, so a stopped engine still reports the truth about the
    // mount it *would* write to (a start-time snapshot showed "in-process only" even when /data exists).
    // `autoEntry` is the exception: it is a runtime switch, so env alone would hide it (and a dashboard
    // that lies about whether the bot trades by itself is worse than a stale one).
    const envConfig = loadEngineConfig();
    const autoEntry = this.running
      ? this.status.config.autoEntry
      : envConfig.autoEntry || ledger.getAutopilot().serverEntries;
    return {
      ...this.status,
      events: this.events,
      entriesHalted: this.haltEntries || loadRiskPolicy().halted,
      ledgerDurable: ledger.isDurable(),
      config: { ...envConfig, autoEntry },
    };
  }

  /** Flatten every position this engine owns. Never touches foreign positions. */
  async flattenAll(): Promise<{ ok: boolean; message: string }> {
    const creds = this.creds();
    if (!creds) return { ok: false, message: 'No server credentials configured' };
    const owned = ledger.list().filter((p) => !p.foreign);
    if (owned.length === 0) return { ok: true, message: 'No engine-owned positions to flatten' };
    let closed = 0;
    for (const pos of owned) {
      const result = await this.closeAndSettle(creds, pos.symbol, 'MANUAL_CLOSE');
      if (result) closed++;
    }
    this.log('WARN', 'FLATTEN_ALL', `Flattened ${closed}/${owned.length} engine-owned positions.`);
    return { ok: true, message: `Flattened ${closed}/${owned.length} positions` };
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.cycle();
    }, delayMs);
    this.status = { ...this.status, nextCycleAt: Date.now() + delayMs };
  }

  private async cycle(): Promise<void> {
    if (this.busy) {
      this.schedule(this.status.config.intervalMs);
      return;
    }
    this.busy = true;
    const started = Date.now();
    try {
      // A cycle skipped for cooldown is not evidence that anything recovered, so it must not clear
      // the failure the operator still has to act on.
      const outcome = await this.runCycle();
      if (outcome === 'skipped') {
        this.status = { ...this.status, cycles: this.status.cycles + 1 };
      } else {
        this.failureStreak = null;
        this.status = {
          ...this.status,
          lastError: null,
          lastErrorAt: null,
          lastFailure: null,
          cycles: this.status.cycles + 1,
        };
      }
    } catch (err) {
      const plan = planCycleFailure(err, {
        isTestnet: this.creds()?.isTestnet ?? this.status.network === 'testnet',
        previous: this.failureStreak,
      });
      this.failureStreak = { code: plan.failure.code, repeats: plan.repeats };
      if (plan.log) this.log(plan.level, plan.kind, plan.message);
      // Announce the pause once per window, not on every cycle that is still inside it.
      const alreadyCooling = Boolean(this.status.cooldownUntil && this.status.cooldownUntil > Date.now());
      if (plan.cooldownMs > 0 && !alreadyCooling) {
        this.log('WARN', 'COOLDOWN', `Next attempt in ${Math.round(plan.cooldownMs / 1000)}s (${plan.failure.code}).`);
      }
      this.status = {
        ...this.status,
        lastError: plan.failure.title,
        lastErrorAt: Date.now(),
        lastFailure: {
          code: plan.failure.code,
          title: plan.failure.title,
          action: plan.failure.action,
          retryable: plan.failure.retryable,
          at: Date.now(),
          repeats: plan.repeats,
          raw: toRawFailure(err).message,
        },
        cycles: this.status.cycles + 1,
        ...(plan.cooldownMs > 0 ? { cooldownUntil: Date.now() + plan.cooldownMs } : {}),
      };
    } finally {
      this.busy = false;
      this.status = { ...this.status, lastCycleAt: Date.now(), lastCycleDurationMs: Date.now() - started };
      const wait = this.status.cooldownUntil && this.status.cooldownUntil > Date.now()
        ? this.status.cooldownUntil - Date.now()
        : this.status.config.intervalMs;
      this.schedule(wait);
    }
  }

  private async runCycle(): Promise<'skipped' | 'done'> {
    const creds = this.creds();
    if (!creds) {
      this.stop('credentials disappeared');
      return 'skipped';
    }
    if (this.status.cooldownUntil && this.status.cooldownUntil > Date.now()) return 'skipped';

    const policy: RiskPolicy = loadRiskPolicy();
    const [account, live] = await Promise.all([
      getAccount(creds),
      getLivePositions(creds),
    ]);

    this.status = { ...this.status, network: creds.isTestnet ? 'testnet' : 'mainnet' };

    const realized = await getRealizedPnlToday(creds);
    if (Number.isFinite(realized)) ledger.setRealizedPnlToday(realized);
    const daily = ledger.snapshot().realizedPnlTodayUsdt;
    const dailyLossLocked = policy.maxDailyLossUsdt > 0 && daily <= -policy.maxDailyLossUsdt;
    this.status = { ...this.status, realizedPnlTodayUsdt: daily, dailyLossLocked };

    const liveBySymbol = new Map<string, LivePosition>();
    for (const p of live) liveBySymbol.set(p.symbol, p);

    // --- 1. Reconcile ledger vs exchange ------------------------------------
    for (const pos of ledger.list()) {
      const match = liveBySymbol.get(pos.symbol);
      if (match) {
        ledger.patch(pos.symbol, {
          markPrice: match.markPrice,
          quantity: Math.abs(match.positionAmt),
          entryPrice: match.entryPrice > 0 ? match.entryPrice : pos.entryPrice,
          margin: match.isolatedMargin > 0 ? match.isolatedMargin : pos.margin,
          leverage: match.leverage > 0 ? match.leverage : pos.leverage,
          unrealizedPnl: Number(match.unrealizedProfit.toFixed(2)),
          unrealizedPnlPercent: match.isolatedMargin > 0 ? Number(((match.unrealizedProfit / match.isolatedMargin) * 100).toFixed(2)) : 0,
        });
        continue;
      }
      if (pos.foreign) {
        ledger.remove(pos.symbol);
        this.log('INFO', 'FOREIGN_CLEARED', `${pos.symbol} is no longer open on Binance; dropped from the watch list.`);
        continue;
      }
      // Position the engine owned is gone: a bracket (or a manual close) filled it. Settle it from
      // the exchange income ledger rather than guessing.
      await this.closeAndSettle(creds, pos.symbol, classifyExit(pos, pos.markPrice), pos.entryTime);
    }

    for (const p of live) {
      if (ledger.has(p.symbol)) continue;
      ledger.upsert({
        id: `exch-${p.symbol}`,
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        margin: p.isolatedMargin,
        leverage: p.leverage || this.status.config.leverage,
        quantity: Math.abs(p.positionAmt),
        stopLoss: 0,
        takeProfit: 0,
        unrealizedPnl: Number(p.unrealizedProfit.toFixed(2)),
        unrealizedPnlPercent: 0,
        entryTime: Date.now(),
        foreign: true,
      });
      this.log('WARN', 'FOREIGN_POSITION', `${p.symbol} ${p.side} x${Math.abs(p.positionAmt)} is open on Binance but was not opened here. Reporting only — the engine will not manage or close it.`);
    }

    // --- 2. Guardian: every owned position must have a live stop -------------
    const owned = ledger.list().filter((p) => !p.foreign);
    const unprotected: string[] = [];

    // Tick/price filters come from the same cached exchange info the UI path uses, so a re-armed
    // stop can never be rejected for precision (a rejected stop is what the escalation counts).
    const specs = await getSpecMap(creds.isTestnet);

    for (const pos of owned) {
      const livePos = liveBySymbol.get(pos.symbol);
      let settledThisCycle = false;

      const needOrders = this.status.config.enforceBrackets && pos.stopLoss > 0;
      const probe = needOrders
        ? await getConditionalOrders(creds, pos.symbol)
            .then((o) => ({ known: true, orders: o }))
            .catch(() => ({ known: false, orders: [] as ConditionalOrder[] }))
        : { known: true, orders: [] as ConditionalOrder[] };

      const plan = planBracketEnforcement(pos, probe.orders, {
        enforceBrackets: this.status.config.enforceBrackets,
        unprotectedTolerance: this.status.config.unprotectedTolerance,
        stopStateKnown: probe.known,
      });

      switch (plan.kind) {
        case 'REARM_STOP': {
          const filters = specs?.[pos.symbol];
          if (!filters) {
            // No tick data => we cannot build a price the exchange will accept. Counting this as an
            // unprotected cycle would let a *metadata* outage escalate into flattening the user's
            // position, so defer and say so instead.
            this.log('WARN', 'BRACKET_DEFERRED', `${pos.symbol}: no cached tickSize; stop re-arm deferred to the next cycle.`);
            unprotected.push(pos.symbol);
            break;
          }
          const stopPrice = formatToStep(pos.stopLoss, filters.tickSize, filters.pricePrecision);
          const stopPriceNum = parseFloat(stopPrice);
          if (!(stopPriceNum > 0)) {
            this.log('WARN', 'BRACKET_DEFERRED', `${pos.symbol}: stop level ${pos.stopLoss} does not quantize onto tickSize ${filters.tickSize}; not sending it.`);
            unprotected.push(pos.symbol);
            break;
          }
          try {
            const exitSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
            const ack = await placeBracketOrder(creds, {
              symbol: pos.symbol,
              side: exitSide,
              type: 'STOP_MARKET',
              stopPrice,
              closePosition: true,
            });
            ledger.patch(pos.symbol, { slOrderId: ack.orderId, unprotectedCycles: 0, stopLoss: stopPriceNum });
            this.log('WARN', 'BRACKET_REARMED', `${plan.note} Sent at ${stopPrice}.`);
          } catch (err) {
            // Only an *answer* from Binance counts toward the flatten escalation: a network failure
            // means the stop state is unknown, and closing a position on that assumption is worse
            // than retrying next cycle.
            if (err instanceof BinanceApiError) {
              const cycles = (pos.unprotectedCycles ?? 0) + 1;
              ledger.patch(pos.symbol, { unprotectedCycles: cycles });
              unprotected.push(pos.symbol);
              this.log('ERROR', 'BRACKET_FAILED', `${pos.symbol} stop re-arm rejected (cycle ${cycles}/${this.status.config.unprotectedTolerance + 1}): ${(err as Error).message}`);
            } else {
              unprotected.push(pos.symbol);
              this.log('WARN', 'BRACKET_DEFERRED', `${pos.symbol} stop re-arm unreachable (${(err as Error).message}); retried next cycle, position left as-is.`);
            }
          }
          break;
        }
        case 'ADOPT_EXCHANGE_STOP': {
          ledger.patch(pos.symbol, { stopLoss: plan.stopPrice, slOrderId: plan.orderId, unprotectedCycles: 0 });
          this.log('INFO', 'BRACKET_ADOPTED', plan.note);
          break;
        }
        case 'FLATTEN': {
          this.log('ERROR', 'AUTO_FLATTEN', plan.note);
          await this.closeAndSettle(creds, pos.symbol, 'MANUAL_CLOSE');
          settledThisCycle = true;
          break;
        }
        case 'SKIP': {
          if (plan.reason === 'stop-state-unknown') {
            unprotected.push(pos.symbol);
            this.log('WARN', 'BRACKET_DEFERRED', `${pos.symbol}: the open-order query failed, so its stop could not be verified this cycle.`);
          } else if (plan.reason === 'no-stop-level-known' && livePos) {
            unprotected.push(pos.symbol);
          }
          break;
        }
        case 'NONE':
        default: {
          const stop = findProtectiveStop(probe.orders, pos.side);
          if (stop) ledger.patch(pos.symbol, { slOrderId: stop.orderId, unprotectedCycles: 0 });
          break;
        }
      }

      // Backstop trigger: normally the exchange fires the bracket; this only acts on a breach the
      // exchange order did not catch.
      if (livePos && !settledThisCycle) {
        const breach = detectBreach(pos, livePos.markPrice);
        if (breach) {
          this.log('WARN', 'BREACH_BACKSTOP', `${pos.symbol} breached its bracket at ${livePos.markPrice} (TP ${pos.takeProfit} / SL ${pos.stopLoss}); closing from the server.`);
          await this.closeAndSettle(creds, pos.symbol, breach);
        }
      }
    }

    if (unprotected.length > 0) {
      this.log('WARN', 'UNPROTECTED', `${unprotected.length} position(s) without a confirmed stop: ${unprotected.join(', ')}`);
    }

    // --- 3. Entries (opt-in) -------------------------------------------------
    const gate = evaluateEntryGate({
      autoEntry: this.status.config.autoEntry,
      haltedByOperator: this.haltEntries,
      haltedByPolicy: policy.halted,
      ledgerDurable: this.status.ledgerDurable,
      allowNonDurableLedger: this.status.config.allowNonDurableLedger,
      canTrade: account.canTrade,
      dailyLossLocked,
      openOwned: owned.length,
      maxOpenPositions: policy.maxOpenPositions,
    });
    if (!gate.allowed && this.status.config.autoEntry) {
      this.log('INFO', 'ENTRY_BLOCKED', `No entries attempted: ${gate.reason}.`);
    }

    if (gate.allowed) {
      // The opportunity list is the fast path: the market scan (cached, whole market) refreshes it,
      // and this cycle trades exactly its members. It is carried across restarts through the data
      // dir, so a redeploy does not have to re-discover the market before it can trade again.
      const scan = await scanUniverse({
        isTestnet: creds.isTestnet,
        policy,
        skip: ledger.list().map((p) => p.symbol),
        opportunity: loadOpportunityList(),
      });

      let opportunityReport: EngineOpportunitySummary | null = null;
      if (scan.opportunity) {
        const saved = saveOpportunityList(scan.opportunity.state);
        if (!saved.durable && !this.opportunityDurabilityWarned) {
          this.opportunityDurabilityWarned = true;
          this.log(
            'WARN',
            'OPPORTUNITY_NOT_DURABLE',
            `The opportunity list could not be written to ${'TRADE_DATA_DIR'} (${saved.error ?? 'unknown error'}). It keeps working for the life of this process, but a restart will re-discover the market from scratch.`
          );
        }

        const promoted = scan.opportunity.promoted.map((entry) => `${entry.symbol} (rank ${entry.boardRank}, ${entry.amplitudePercent.toFixed(2)}% 24h range)`);
        if (promoted.length > 0) {
          this.log(
            'SUCCESS',
            'OPPORTUNITY_ADDED',
            `${promoted.length} opportunity asset${promoted.length === 1 ? '' : 's'} promoted by the market scan: ${promoted.join(', ')}. Now scanning ${scan.opportunity.state.entries.length} pair${scan.opportunity.state.entries.length === 1 ? '' : 's'} every cycle.`
          );
        }
        if (scan.opportunity.removed.length > 0) {
          this.log(
            'INFO',
            'OPPORTUNITY_REMOVED',
            `${scan.opportunity.removed.length} pair${scan.opportunity.removed.length === 1 ? '' : 's'} left the opportunity list: ${scan.opportunity.removed.map(describeOpportunityChange).join(', ')}.`
          );
        }
        if (scan.opportunity.warned.length > 0) {
          this.log(
            'INFO',
            'OPPORTUNITY_WARNED',
            `Still listed, failed this pass: ${scan.opportunity.warned.map((w) => `${w.symbol} (${w.reason}, strike ${w.strikes}/${policy.opportunity.strikes})`).join(', ')}.`
          );
        }

        opportunityReport = {
          size: scan.opportunity.state.entries.length,
          cap: resolveOpportunityCap(policy),
          scanned: scan.opportunity.scanned.length,
          held: scan.opportunity.held,
          promoted: scan.opportunity.promoted.map((entry) => entry.symbol),
          removed: scan.opportunity.removed.map((r) => ({ symbol: r.symbol, reason: r.reason, detail: r.detail })),
          warned: scan.opportunity.warned,
          boardAgeMs: Math.max(0, scan.timestamp - scan.board.generatedAt),
          durable: saved.durable,
        };
      }

      // The board is the market-wide ranking; the shortlist below it is what was deep-scanned.
      const skippedSummary = Object.entries(scan.skipped)
        .map(([reason, count]) => `${count} ${reason}`)
        .join(', ');

      if (scan.board.source === 'fallback') {
        // The fallback board is a placeholder with no volatility readings. In list mode it must not be
        // read as "nothing qualifies", so the list is carried over as it stands — say that, rather
        // than claiming a scan of the built-in majors that no longer happens.
        const listState = scan.opportunity ? scan.opportunity.state.entries.length : null;
        this.log(
          'WARN',
          'DISCOVERY_FALLBACK',
          listState === null
            ? `Market ranking unavailable (${scan.board.error ?? 'unknown error'}); scanning the built-in ${scan.requestedPairs.length} majors instead. No pair outside that list can be found until the exchange answers.`
            : `Market ranking unavailable (${scan.board.error ?? 'unknown error'}); the opportunity list is kept as it is (${listState} pair${listState === 1 ? '' : 's'}). Nothing can be promoted or dropped until the exchange answers — a failed ranking is not evidence that a pair stopped qualifying.`
        );
      }

      // Fail closed: an entry needs an explicit tradeable=true from the exchange filters (checked in
      // the selector) and must not be refused by the regime gate. The best signal score wins;
      // volatility only breaks ties. This is the piece that used to pick the most volatile pair with
      // any signal at all.
      const candidate = selectBestCandidate(scan.signals, scan.tradeable);

      this.status = {
        ...this.status,
        lastScan: {
          at: scan.timestamp,
          ok: scan.ok,
          signals: scan.signals.length,
          failures: scan.failures.length,
          board: {
            source: scan.board.source,
            universeSize: scan.board.universeSize,
            liquidCount: scan.board.liquidCount,
          },
          skipped: scan.skipped,
          selected: candidate ? candidate.symbol : null,
          opportunity: opportunityReport,
        },
      };

      if (!candidate && scan.ok) {
        const ranked = scan.signals
          .slice(0, 3)
          .map((sig) => `${sig.symbol} ${sig.score}%${sig.scan?.skipReason ? ` (${sig.scan.skipReason})` : ''}`)
          .join(', ');
        const listNote = opportunityReport
          ? `opportunity list: ${opportunityReport.size}/${opportunityReport.cap} pair${opportunityReport.size === 1 ? '' : 's'}${opportunityReport.held.length > 0 ? ` (${opportunityReport.held.length} held by open positions)` : ''} · market ranking ${Math.round(opportunityReport.boardAgeMs / 1000)}s old · `
          : '';
        this.log(
          'INFO',
          'NO_SETUP',
          `${listNote}${scan.signals.length} pairs deep-scanned from a board of ${scan.board.liquidCount} liquid pairs` +
            `${skippedSummary ? ` · refused: ${skippedSummary}` : ''}` +
            `${ranked ? ` · closest: ${ranked}` : ''}. Nothing met the entry threshold.`
        );
      }

      if (candidate) {
        const margin = ledger.snapshot().compounding.currentMargin;
        const result = await openPosition(
          creds,
          {
            symbol: candidate.symbol,
            side: candidate.action === 'SHORT' ? 'SHORT' : 'LONG',
            margin,
            leverage: this.status.config.leverage,
            price: candidate.currentPrice,
            stopLoss: candidate.slPrice,
            takeProfit: candidate.tpPrice,
            idempotencyKey: `${candidate.symbol}:${candidate.action}:${candidate.currentPrice}:${Math.floor(Date.now() / 300000)}`,
          },
          policy
        );

        if (result.status === 200 && (result.body as { success: boolean }).success) {
          const b = result.body as OpenSuccess;
          if (b.success) {
            ledger.upsert({
              id: String(b.orderId),
              symbol: b.symbol,
              side: b.side,
              entryPrice: b.avgPrice,
              markPrice: b.avgPrice,
              margin: b.effectiveMargin,
              leverage: b.leverage,
              quantity: b.executedQty,
              stopLoss: b.stopLoss,
              takeProfit: b.takeProfit,
              unrealizedPnl: 0,
              unrealizedPnlPercent: 0,
              entryTime: b.timestamp,
              slOrderId: b.slOrderId ?? undefined,
              tpOrderId: b.tpOrderId ?? undefined,
              orderId: b.orderId,
              signalId: `${candidate.symbol}:${candidate.signal}:${candidate.score}`,
            });
            this.log('SUCCESS', 'ENTRY_OPENED', `${b.side} ${b.executedQty} ${b.symbol} @ ${b.avgPrice} (notional $${b.effectiveNotional}, margin $${b.effectiveMargin}, ${b.leverage}x) · SL ${b.stopLoss} · TP ${b.takeProfit}`);
            if (b.bracketWarning) this.log('WARN', 'BRACKET_PARTIAL', b.bracketWarning);
          }
        } else {
          const f = result.body as Partial<RecoveryBody> & { code?: string; error?: string };
          const live = Array.isArray(f.livePositions) && f.livePositions.length > 0 ? f.livePositions[0] : null;

          if (f.orderPlaced === true) {
            // The exchange may already hold a position. Opening anything else while that is
            // unresolved is how one half-known position becomes two, so entries stop here — the
            // same decision the browser loop makes when it sees `orderPlaced`.
            this.haltEntries = true;
            this.status = { ...this.status, entriesHalted: true };

            if (live && f.side) {
              // Adopt it: without a ledger row the guardian classifies it as foreign, which means
              // it would never re-arm the stop, never settle PnL and never appear in history.
              const entryPrice = live.entryPrice > 0 ? live.entryPrice : candidate.currentPrice;
              const notional = live.quantity * entryPrice;
              const margin = live.leverage > 0 ? notional / live.leverage : this.status.config.baseMargin;
              const stopLoss = typeof f.stopLoss === 'number' && f.stopLoss > 0 ? f.stopLoss : 0;

              ledger.upsert({
                id: `rec-${candidate.symbol}-${Date.now()}`,
                symbol: candidate.symbol,
                side: f.side,
                entryPrice,
                markPrice: live.markPrice > 0 ? live.markPrice : entryPrice,
                margin: Number(margin.toFixed(4)),
                leverage: live.leverage || this.status.config.leverage,
                quantity: live.quantity,
                stopLoss,
                takeProfit: 0,
                unrealizedPnl: Number((live.unrealizedProfit ?? 0).toFixed(2)),
                unrealizedPnlPercent:
                  margin > 0 ? Number((((live.unrealizedProfit ?? 0) / margin) * 100).toFixed(2)) : 0,
                entryTime: Date.now(),
                slOrderId: f.slOrderId ?? undefined,
                signalId: `${candidate.symbol}:${candidate.signal}:${candidate.score}`,
              });
              this.log(
                'WARN',
                'ENTRY_RECOVERED',
                `${candidate.symbol} ${f.side} ${live.quantity} was found live on Binance after an ambiguous entry (${f.code ?? 'no code'}). It is now in the ledger${stopLoss > 0 ? ` with stop ${stopLoss}` : ' but with no known stop level'} so the guardian can re-arm and settle it. New entries halted — resume when you have checked the position.`
              );
            } else {
              this.log(
                'ERROR',
                'ENTRY_UNRESOLVED',
                `${candidate.symbol}: ${f.code ?? 'ambiguous outcome'} — ${f.error ?? 'no detail'}. Entries halted. The exchange state could not be pinned to a position, so nothing was adopted — verify on Binance before resuming.`
              );
            }
          } else {
            this.log('WARN', 'ENTRY_SKIPPED', `${candidate.symbol}: ${f.code ?? 'rejected'} — ${f.error ?? 'no detail'}`);
          }
        }
      }
    }

    this.status = {
      ...this.status,
      ownedPositions: owned.length,
      foreignPositions: ledger.list().filter((p) => p.foreign).map((p) => p.symbol),
      unprotectedPositions: unprotected,
    };
    return 'done';
  }

  /**
   * Close a symbol and book the trade using the exchange's own income records, so commission and
   * funding are included. Falls back to price-derived PnL (explicitly labelled) if settlement data
   * is unavailable — never invents a number silently.
   */
  private async closeAndSettle(
    creds: BinanceCreds,
    symbol: string,
    reason: ClosedTrade['reason'],
    entryTime?: number
  ): Promise<boolean> {
    const pos = ledger.get(symbol);
    const result = await closePosition(creds, { symbol });
    if (result.status !== 200 || !(result.body as { success: boolean }).success) {
      const f = result.body as { error?: string };
      this.log('ERROR', 'CLOSE_FAILED', `${symbol} close failed: ${f.error ?? 'unknown'} — position state must be checked on Binance.`);
      return false;
    }

    const body = result.body as { noPosition?: boolean; avgPrice: number; executedQty: number };
    if (pos) {
      const since = entryTime ?? pos.entryTime ?? Date.now() - 3600_000;
      const settled = await getSettledPnlSince(creds, since, symbol);
      const fallbackPrice = body.avgPrice > 0 ? body.avgPrice : pos.markPrice;
      const priceDiff = pos.side === 'LONG' ? fallbackPrice - pos.entryPrice : pos.entryPrice - fallbackPrice;
      const notional = pos.margin * pos.leverage;
      const fallbackPnl = pos.entryPrice > 0 ? Number(((priceDiff / pos.entryPrice) * notional).toFixed(2)) : 0;

      const netPnlUsdt = settled ? settled.net : fallbackPnl;
      const { trade, nextMargin } = ledger.recordClose({
        symbol: pos.symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice: roundCryptoPrice(fallbackPrice),
        margin: pos.margin,
        leverage: pos.leverage,
        entryTime: pos.entryTime,
        exitTime: Date.now(),
        reason,
        netPnlUsdt,
      });

      ledger.flush();
      this.log(
        trade.isWin ? 'SUCCESS' : 'WARN',
        'TRADE_SETTLED',
        `${trade.symbol} ${trade.reason} @ $${trade.exitPrice}: net ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)} (${trade.pnlPercent.toFixed(2)}% on margin)${settled ? '' : ' [price-derived, not settled from income]'} · next margin $${nextMargin.toFixed(2)}`
      );
    } else {
      this.log('INFO', 'CLOSED_UNTRACKED', `${symbol} closed on the exchange (${body.executedQty} @ ${body.avgPrice}) with no ledger entry; nothing to settle.`);
    }
    return true;
  }
}

/**
 * Process-wide singleton.
 *
 * Next compiles `instrumentation.ts` into its own server bundle, so a plain module-level export can
 * end up with two instances in one process — the loop booted by instrumentation and a second, idle
 * one imported by the API routes (which then reports "not running" while positions are being guarded).
 * Attaching to globalThis makes it one loop per process, which is what a safety daemon has to be.
 */
const engineGlobal = globalThis as unknown as { __tmEngine?: TradeEngine };
export const engine = engineGlobal.__tmEngine ?? (engineGlobal.__tmEngine = new TradeEngine());
