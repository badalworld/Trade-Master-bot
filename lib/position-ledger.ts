/**
 * Durable, server-side trade ledger.
 *
 * Before this, open positions / closed trades / compounding state lived only in one browser's
 * `localStorage`, so a closed tab or a cleared profile left real Binance positions untracked and
 * reset the compounding ladder mid-streak. This store is the server's own record.
 *
 * Persistence is a JSON file (atomic tmp+rename) under TRADE_DATA_DIR. On a platform with an
 * ephemeral filesystem (Cloud Run without a volume) the in-memory state still works for the life of
 * the process — which is what matters for protecting positions — but durability across restarts
 * requires a mounted volume, or swapping readState/writeState for a database adapter.
 */

import fs from 'fs';
import path from 'path';
import {
  calculateNextTradeMargin,
  type ClosedTrade,
  type CompoundingState,
  type TradePosition,
} from './trading-engine.ts';

export interface EnginePositionMeta {
  /** Bracket order ids as last confirmed on the exchange. */
  slOrderId?: number | string | null;
  tpOrderId?: number | string | null;
  /** Order id returned by the entry submission. */
  orderId?: number | string;
  /** Positions the engine did not open are reported but never traded. */
  foreign?: boolean;
  /** Consecutive cycles where the protective stop could not be confirmed. */
  unprotectedCycles?: number;
  signalId?: string;
}

export type LedgerPositions = Record<string, TradePosition & EnginePositionMeta>;

export interface LedgerState {
  version: number;
  updatedAt: number;
  startedAt: number;
  positions: LedgerPositions;
  closedTrades: ClosedTrade[];
  compounding: CompoundingState;
  realizedPnlTodayUsdt: number;
  /** The UTC day `realizedPnlTodayUsdt` belongs to. */
  pnlDay: string;
  /**
   * Which Binance environment these positions belong to. A ledger written by testnet must never be
   * used to manage (or flatten) mainnet positions after a config change — they are different
   * accounts, and treating them as the same is how someone's real position gets closed by accident.
   */
  network: 'testnet' | 'mainnet' | null;
}

export const DEFAULT_COMPOUNDING: CompoundingState = {
  baseMargin: 2.0,
  currentMargin: 2.0,
  lastProfit: 0,
  compoundingPercent: 20,
  consecutiveWins: 0,
  totalCompoundedProfitPool: 0,
};

const MAX_CLOSED_TRADES = 1000;

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function emptyState(): LedgerState {
  const now = Date.now();
  return {
    version: 1,
    updatedAt: now,
    startedAt: now,
    positions: {},
    closedTrades: [],
    compounding: { ...DEFAULT_COMPOUNDING },
    realizedPnlTodayUsdt: 0,
    pnlDay: utcDay(now),
    network: null,
  };
}

export function ledgerPath(): string {
  const dir = (process.env.TRADE_DATA_DIR ?? '').trim() || path.join(process.cwd(), '.data');
  return path.join(dir, 'trade-ledger.json');
}

function readState(): LedgerState {
  try {
    const file = ledgerPath();
    if (!fs.existsSync(file)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LedgerState>;
    const state = { ...emptyState(), ...parsed } as LedgerState;
    // A hand-edited or half-written file must never crash the guardian loop.
    if (!state.positions || typeof state.positions !== 'object') state.positions = {};
    if (!Array.isArray(state.closedTrades)) state.closedTrades = [];
    state.compounding = { ...DEFAULT_COMPOUNDING, ...(state.compounding ?? {}) };
    // A stale day's realized PnL must not keep the loss breaker tripped forever.
    if (state.pnlDay !== utcDay(Date.now())) {
      state.pnlDay = utcDay(Date.now());
      state.realizedPnlTodayUsdt = 0;
    }
    return state;
  } catch {
    return emptyState();
  }
}

function writeState(snapshot: LedgerState): void {
  try {
    const file = ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(tmp, file); // atomic replace: a crash cannot truncate the ledger
  } catch (err) {
    // Durability is best-effort; the in-memory copy stays authoritative for this process — but
    // silently losing the ledger is not acceptable either.
    console.error('[ledger] persist failed:', (err as Error).message);
  }
}

let state: LedgerState | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function ensure(): LedgerState {
  if (!state) state = readState();
  return state;
}

function touch(): void {
  const s = ensure();
  s.updatedAt = Date.now();
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (state) writeState(state);
  }, 150);
}

/**
 * Synchronous mutation on an in-memory copy with debounced write-through, so a cycle can never
 * observe a half-applied update. (The browser version raced precisely because React state updates
 * are deferred.)
 */
/** Cached on globalThis for the same reason as `engine`: instrumentation and app routes are
 * compiled separately, and two in-memory copies of one ledger file would overwrite each other. */
const ledgerGlobal = globalThis as unknown as { __tmLedger?: typeof ledgerImpl };

const ledgerImpl = {
  snapshot(): LedgerState {
    return ensure();
  },

  list(): Array<TradePosition & EnginePositionMeta> {
    return Object.values(ensure().positions);
  },

  get(symbol: string): (TradePosition & EnginePositionMeta) | undefined {
    return ensure().positions[String(symbol).toUpperCase()];
  },

  has(symbol: string): boolean {
    return Boolean(ensure().positions[String(symbol).toUpperCase()]);
  },

  upsert(position: TradePosition & EnginePositionMeta): void {
    const s = ensure();
    s.positions[position.symbol] = { ...(s.positions[position.symbol] ?? {}), ...position };
    touch();
  },

  patch(symbol: string, changes: Partial<TradePosition & EnginePositionMeta>): void {
    const key = String(symbol).toUpperCase();
    const s = ensure();
    if (!s.positions[key]) return;
    s.positions[key] = { ...s.positions[key], ...changes };
    touch();
  },

  remove(symbol: string): (TradePosition & EnginePositionMeta) | undefined {
    const key = String(symbol).toUpperCase();
    const s = ensure();
    const existing = s.positions[key];
    if (existing) delete s.positions[key];
    touch();
    return existing;
  },

  openCount(): number {
    return Object.keys(ensure().positions).length;
  },

  /**
   * Record a closed trade and advance compounding from the settled number.
   * `netPnlUsdt` should come from the exchange's income stream when available, so commission and
   * funding are included instead of guessed at a flat 0.1%.
   */
  recordClose(trade: Omit<ClosedTrade, 'id' | 'pnl' | 'pnlPercent' | 'isWin' | 'compoundingBonusGenerated'> & { netPnlUsdt: number; id?: string }): {
    trade: ClosedTrade;
    nextMargin: number;
  } {
    const s = ensure();
    const pnl = Number(trade.netPnlUsdt);
    const id = trade.id ?? `t-${Date.now()}`;
    const base: ClosedTrade = {
      ...trade,
      id,
      pnl,
      pnlPercent: trade.margin > 0 ? Number(((pnl / trade.margin) * 100).toFixed(2)) : 0,
      isWin: pnl > 0,
      compoundingBonusGenerated: 0,
    };

    const outcome = calculateNextTradeMargin(s.compounding, { isWin: base.isWin, profit: pnl });
    base.compoundingBonusGenerated = outcome.bonusAdded;
    s.compounding = outcome.newState;

    s.closedTrades = [base, ...s.closedTrades].slice(0, MAX_CLOSED_TRADES);
    const today = utcDay(Date.now());
    if (s.pnlDay !== today) {
      s.pnlDay = today;
      s.realizedPnlTodayUsdt = 0;
    }
    s.realizedPnlTodayUsdt = Number((s.realizedPnlTodayUsdt + pnl).toFixed(4));

    delete s.positions[base.symbol];
    touch();
    return { trade: base, nextMargin: outcome.nextMargin };
  },

  setPolicyInputs(baseMargin: number, compoundingPercent: number): void {
    const s = ensure();
    s.compounding = {
      ...s.compounding,
      baseMargin,
      compoundingPercent,
      currentMargin:
        s.compounding.consecutiveWins === 0 ? baseMargin : Math.max(baseMargin, s.compounding.currentMargin),
    };
    touch();
  },

  /** Reconcile the breaker against exchange truth rather than a local running total. */
  setRealizedPnlToday(value: number): void {
    const s = ensure();
    const today = utcDay(Date.now());
    if (s.pnlDay !== today) {
      s.pnlDay = today;
      s.startedAt = Date.now();
    }
    if (Number.isFinite(value)) s.realizedPnlTodayUsdt = Number(value.toFixed(4));
    touch();
  },

  flush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (state) writeState(state);
  },

  getNetwork(): 'testnet' | 'mainnet' | null {
    return ensure().network ?? null;
  },

  setNetwork(network: 'testnet' | 'mainnet'): void {
    const s = ensure();
    if (s.network !== network) {
      s.network = network;
      writeState(s);
    }
  },

  /** True when a writable TRADE_DATA_DIR is configured, i.e. state survives a restart. */
  isDurable(): boolean {
    try {
      const dir = path.dirname(ledgerPath());
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.write-${process.pid}.probe`);
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  },

  /** Test seam: drop the in-memory copy so the next access re-reads from disk. */
  __reload(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    state = null;
  },

  /** Test seam. */
  __reset(next?: LedgerState): void {
    state = next ?? emptyState();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  },
};

export const ledger = ledgerGlobal.__tmLedger ?? (ledgerGlobal.__tmLedger = ledgerImpl);
