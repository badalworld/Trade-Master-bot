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
import { closePosition, getSpecMap, openPosition, type OpenSuccess } from './order-executor.ts';
import {
  classifyExit,
  detectBreach,
  evaluateEntryGate,
  findProtectiveStop,
  planBracketEnforcement,
} from './guardian.ts';
import { isActionableSignal, scanUniverse } from './market-data.ts';
import { ledger } from './position-ledger.ts';
import { loadRiskPolicy, type RiskPolicy } from './risk-policy.ts';
import { envCredentials } from './trade-guard.ts';
import { roundCryptoPrice, type ClosedTrade } from './trading-engine.ts';

export interface EngineConfig {
  enabled: boolean;
  autoEntry: boolean;
  enforceBrackets: boolean;
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
  cooldownUntil: number | null;
  entriesHalted: boolean;
  dailyLossLocked: boolean;
  realizedPnlTodayUsdt: number;
  ownedPositions: number;
  foreignPositions: string[];
  unprotectedPositions: string[];
  lastScan: { at: number; ok: boolean; signals: number; failures: number } | null;
  events: EngineEvent[];
  ledgerDurable: boolean;
}

const MAX_EVENTS = 60;
const MIN_INTERVAL_MS = 5000;
const COOLDOWN_MS = 60_000;

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
    intervalMs: Math.max(MIN_INTERVAL_MS, parseInt(env.TRADE_ENGINE_INTERVAL_MS ?? '15000', 10) || 15000),
    unprotectedTolerance: Math.max(0, parseInt(env.TRADE_ENGINE_UNPROTECTED_TOLERANCE ?? '2', 10) || 2),
    leverage: Math.min(15, Math.max(1, parseInt(env.TRADE_ENGINE_LEVERAGE ?? '10', 10) || 10)),
    baseMargin: Math.max(1, parseFloat(env.TRADE_ENGINE_BASE_MARGIN ?? '2') || 2),
    compoundingPercent: Math.min(100, Math.max(0, parseFloat(env.TRADE_ENGINE_COMPOUNDING_PCT ?? '20') || 20)),
  };
}

type Timer = ReturnType<typeof setTimeout>;

class TradeEngine {
  private timer: Timer | null = null;
  private running = false;
  private busy = false;
  private haltEntries = false;
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
    };
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
    ledger.setPolicyInputs(config.baseMargin, config.compoundingPercent);
    this.status = {
      ...this.status,
      config,
      running: true,
      credentialSource: 'env',
      network,
      startedAt: Date.now(),
      ledgerDurable: ledger.isDurable(),
    };
    this.running = true;
    this.schedule(0);
    this.log(
      'SUCCESS',
      'STARTED',
      `Guardian loop active on ${creds.isTestnet ? 'testnet' : 'MAINNET'} every ${Math.round(config.intervalMs / 1000)}s · auto-entry ${config.autoEntry ? 'ON' : 'OFF (default)'} · bracket enforcement ${config.enforceBrackets ? 'ON' : 'OFF'}`
    );
    if (!creds.isTestnet && !config.autoEntry) {
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
    this.log('WARN', 'STOPPED', `Engine ${reason}; ledger flushed to disk.`);
    return { ok: true, message: `Engine ${reason}` };
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
    return {
      ...this.status,
      events: this.events,
      entriesHalted: this.haltEntries || loadRiskPolicy().halted,
      ledgerDurable: ledger.isDurable(),
      config: loadEngineConfig(),
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
      await this.runCycle();
      this.status = { ...this.status, lastError: null, cycles: this.status.cycles + 1 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('ERROR', 'CYCLE_FAILED', message);
      this.status = { ...this.status, lastError: message, lastErrorAt: Date.now(), cycles: this.status.cycles + 1 };
      // Rate-limit and maintenance responses get a cooldown instead of hammering the API.
      if (err instanceof BinanceApiError && (err.httpStatus === 429 || err.httpStatus === 418 || err.code === -1003)) {
        this.status = { ...this.status, cooldownUntil: Date.now() + COOLDOWN_MS };
        this.log('WARN', 'COOLDOWN', `Backing off for ${COOLDOWN_MS / 1000}s (Binance ${err.httpStatus}/${err.code ?? 'n/a'}).`);
      }
    } finally {
      this.busy = false;
      this.status = { ...this.status, lastCycleAt: Date.now(), lastCycleDurationMs: Date.now() - started };
      const wait = this.status.cooldownUntil && this.status.cooldownUntil > Date.now()
        ? this.status.cooldownUntil - Date.now()
        : this.status.config.intervalMs;
      this.schedule(wait);
    }
  }

  private async runCycle(): Promise<void> {
    const creds = this.creds();
    if (!creds) {
      this.stop('credentials disappeared');
      return;
    }
    if (this.status.cooldownUntil && this.status.cooldownUntil > Date.now()) return;

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
      canTrade: account.canTrade,
      dailyLossLocked,
      openOwned: owned.length,
      maxOpenPositions: policy.maxOpenPositions,
    });
    if (!gate.allowed && this.status.config.autoEntry) {
      this.log('INFO', 'ENTRY_BLOCKED', `No entries attempted: ${gate.reason}.`);
    }

    if (gate.allowed) {
      const scan = await scanUniverse({
        isTestnet: creds.isTestnet,
        policy,
        skip: ledger.list().map((p) => p.symbol),
      });
      this.status = {
        ...this.status,
        lastScan: { at: scan.timestamp, ok: scan.ok, signals: scan.signals.length, failures: scan.failures.length },
      };

      const candidate = scan.signals.find(
        // Fail closed: an entry needs an explicit tradeable=true from the exchange filters, not just
        // the absence of a false.
        (sig) => isActionableSignal(sig) && scan.tradeable[sig.symbol] === true && sig.action !== 'HOLD'
      );

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
          const f = result.body as { code?: string; error?: string };
          this.log('WARN', 'ENTRY_SKIPPED', `${candidate.symbol}: ${f.code ?? 'rejected'} — ${f.error ?? 'no detail'}`);
        }
      } else if (scan.ok) {
        this.log('INFO', 'NO_SETUP', `${scan.signals.length} pairs scanned, none met the entry threshold.`);
      }
    }

    this.status = {
      ...this.status,
      ownedPositions: owned.length,
      foreignPositions: ledger.list().filter((p) => p.foreign).map((p) => p.symbol),
      unprotectedPositions: unprotected,
    };
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
