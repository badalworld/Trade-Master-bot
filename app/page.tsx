'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Header } from '@/components/Header';
import { KpiMetricsStrip, type BinanceAccountMetrics } from '@/components/KpiMetricsStrip';
import { ActivePositions } from '@/components/ActivePositions';
import { ScannerTable } from '@/components/ScannerTable';
import { InteractiveChart } from '@/components/InteractiveChart';
import { TradeHistory } from '@/components/TradeHistory';
import { DiagnosticsLog, type LogEntry } from '@/components/DiagnosticsLog';
import { SettingsView, type BotSettings } from '@/components/SettingsView';
import { PnlChartWidget } from '@/components/PnlChartWidget';
import { TradeResultOverlay, type TradeResultPayload } from '@/components/TradeResultOverlay';
import { EngineStatusPanel, type EngineStatusPayload } from '@/components/EngineStatusPanel';
import { OperatorGate, signOutOperator } from '@/components/OperatorGate';
import { generateUniqueId } from '@/lib/utils';
import { classifyExit } from '@/lib/guardian';
import type { CredentialSession } from '@/components/SettingsView';
import {
  calculateNextTradeMargin,
  canOpenNewTrade,
  checkRateLimit,
  roundCryptoPrice,
  type SignalEvaluation,
  type TradePosition,
  type ClosedTrade,
  type CompoundingState,
  type RateLimitStatus,
  type Candle,
} from '@/lib/trading-engine';

// LocalStorage Keys for persistent state across app restarts
const STORAGE_KEYS = {
  SETTINGS: 'trade_master_settings_v1',
  STARTING_BALANCE: 'trade_master_starting_balance_v1',
  POSITIONS: 'trade_master_positions_v1',
  CLOSED_TRADES: 'trade_master_closed_trades_v1',
  COMPOUNDING: 'trade_master_compounding_v1',
  LOGS: 'trade_master_logs_v1',
  BINANCE_ACCOUNT: 'trade_master_binance_account_v1',
};

// Initial default settings matching user requirements ($2 Base Margin, 10x-15x Isolated Leverage)
const DEFAULT_SETTINGS: BotSettings = {
  // Testnet is the default: a fresh deploy must never be pointed at real money by accident.
  isTestnet: true,
  baseMargin: 2.0, // $2.00 base margin
  leverage: 10, // 10x isolated leverage (10x-15x supported)
  maxOpenTrades: 5, // max 5 concurrent trades
  compoundingPercent: 20, // 20% of profit amount
  scanIntervalSeconds: 15, // 15s scan
  rateLimitSafetyCap: 95, // 95% threshold
};

const SESSION_NONE: CredentialSession = {
  active: false,
  source: 'none',
  isTestnet: true,
};

/** Fired when a money endpoint answers "operator session required" so the UI can re-lock itself. */
const OPERATOR_LOCK_EVENT = 'tm-operator-locked';

/**
 * Every mutating call carries `X-TM-Request` so the cookie-authenticated endpoints reject anything
 * a cross-site form or fetch could reproduce, and no call ever carries API keys.
 */
async function apiPost<T extends Record<string, unknown>>(
  path: string,
  payload: Record<string, unknown> = {}
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TM-Request': '1' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  const code = String((data as { code?: unknown }).code ?? '');
  if ((res.status === 401 || res.status === 503) && code.startsWith('OPERATOR_')) {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPERATOR_LOCK_EVENT));
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * True when a refusal came from the operator wall rather than from the Binance session, so the UI
 * tells the user to sign in instead of claiming their API key is broken.
 */
const isOperatorLockout = (data: unknown): boolean =>
  String((data as { code?: unknown } | null)?.code ?? '').startsWith('OPERATOR_');

const INITIAL_POSITIONS: TradePosition[] = [];
const INITIAL_TRADES: ClosedTrade[] = [];

const INITIAL_LOGS: LogEntry[] = [
  {
    id: 'log-1',
    timestamp: new Date().toLocaleTimeString(),
    category: 'SYSTEM',
    severity: 'INFO',
    message: 'Trade Master terminal initialized ($2.00 Base Margin · 10x–15x Isolated · 3-Indicator TP/SL).',
  },
  {
    id: 'log-2',
    timestamp: new Date().toLocaleTimeString(),
    category: 'RATE_LIMIT',
    severity: 'SUCCESS',
    message: 'Binance API Shield active (95% safety cap).',
  },
];

export default function HomePage() {
  // Navigation
  const [activeTab, setActiveTab] = useState<'positions' | 'scanner' | 'history' | 'logs' | 'settings'>('settings');

  // Bot Core State
  const [botActive, setBotActive] = useState<boolean>(false);
  const [settings, setSettings] = useState<BotSettings>(DEFAULT_SETTINGS);
  const [session, setSession] = useState<CredentialSession>(SESSION_NONE);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('BTCUSDT');

  // Binance Account Auto-Sync State (Starting Balance, Current Equity, Fees, Funding)
  const [binanceAccount, setBinanceAccount] = useState<BinanceAccountMetrics>({
    startingBalance: 0,
    currentEquity: 0,
    availableBalance: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    commissionFees: 0,
    fundingFees: 0,
    isSynced: false,
  });

  // Market & Signals
  const [signals, setSignals] = useState<SignalEvaluation[]>([]);
  const [candlesMap, setCandlesMap] = useState<Record<string, Candle[]>>({});
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanCountdown, setScanCountdown] = useState<number>(15);

  // Positions & Compounding
  const [positions, setPositions] = useState<TradePosition[]>(INITIAL_POSITIONS);
  const [closingPositionId, setClosingPositionId] = useState<string | null>(null);
  const [closedTrades, setClosedTrades] = useState<ClosedTrade[]>(INITIAL_TRADES);
  const [compoundingState, setCompoundingState] = useState<CompoundingState>({
    baseMargin: 2.0,
    currentMargin: 2.0,
    lastProfit: 0,
    compoundingPercent: 20,
    consecutiveWins: 0,
    totalCompoundedProfitPool: 0,
  });

  // Rate Limiting & Logs
  const [rateLimitStatus, setRateLimitStatus] = useState<RateLimitStatus>({
    usedWeight: 24,
    maxLimit: 1200,
    usageRatio: 0.02,
    usagePercent: 2.0,
    isSafe: true,
    isThrottled: false,
    remainingWeight: 1116,
  });
  const [logs, setLogs] = useState<LogEntry[]>(INITIAL_LOGS);

  // Operator session: when this deployment holds server-side Binance keys, the money endpoints
  // require a signed operator cookie — the CSRF header alone is not authentication.
  const [operator, setOperator] = useState<{
    required: boolean;
    configured: boolean;
    authenticated: boolean;
  } | null>(null);

  // Server-side guardian: authoritative position protection + ledger, alive without this tab.
  const [engineState, setEngineState] = useState<EngineStatusPayload | null>(null);
  const [engineLoading, setEngineLoading] = useState<boolean>(false);
  const [engineError, setEngineError] = useState<string | null>(null);

  // Connection Test
  const [isTestingConnection, setIsTestingConnection] = useState<boolean>(false);
  const [connectionResult, setConnectionResult] = useState<{
    tested: boolean;
    success: boolean;
    message: string;
    latencyMs?: number;
    balance?: {
      totalWalletBalance: number;
      availableBalance: number;
    } | null;
  } | null>(null);

  // Full Screen Celebration / Sad Mode Modal on Trade Close
  const [tradeResultModal, setTradeResultModal] = useState<TradeResultPayload | null>(null);

  // Track in-flight automated closes so a single position isn't closed twice concurrently
  const closingIdsRef = useRef<Set<string>>(new Set());
  // ...and in-flight opens/scans, which previously had no lock at all: two overlapping scan cycles
  // could submit the same live entry twice.
  const scanInFlightRef = useRef<boolean>(false);
  // Symbols the server engine is actively guarding. The browser monitor stands down for those so a
  // trade is never closed (or booked) twice.
  const engineManagedRef = useRef<Set<string>>(new Set());
  // Signals already submitted this session, so a re-render can't re-fire an order.
  const submittedSignalsRef = useRef<Set<string>>(new Set());
  // True while the server engine is actually running: it is then the book of record for positions
  // it owns (it settles from Binance's income stream, not from a flat fee estimate).
  const engineAuthorityRef = useRef<boolean>(false);
  // Mirror of `positions` for async reconciliation code (state is not readable inside callbacks).
  const positionsRef = useRef<TradePosition[]>([]);
  // Set after `finalizePositionClose` is defined; lets the 30s account sync book vanished positions
  // without the two callbacks depending on each other (which would be a dependency cycle).
  const finalizeCloseRef = useRef<
    ((pos: TradePosition, exitPrice: number, reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL_CLOSE') => void) | null
  >(null);

  // Global Interactive Mouse-Move Spotlight & Button Glow Tracker (Jitter Interactive-Button-Glow)
  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const hoveredEls = document.querySelectorAll<HTMLElement>(
        '.neon-section:hover, .neon-card:hover, .interactive-glow-btn:hover'
      );
      hoveredEls.forEach((el) => {
        const rect = el.getBoundingClientRect();
        el.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
        el.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
        el.style.setProperty('--spotlight-opacity', '1');
      });
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', handlePointerMove);
  }, []);

  // Helper to append logs (instantly persists up to 500 entries so logs are never lost on restart)
  const appendLog = useCallback(
    (
      category: LogEntry['category'],
      severity: LogEntry['severity'],
      message: string,
      details?: Record<string, unknown> | string
    ) => {
      const newEntry: LogEntry = {
        id: generateUniqueId('log'),
        timestamp: new Date().toLocaleTimeString(),
        category,
        severity,
        message,
        details,
      };
      setLogs((prev) => {
        const updated = [newEntry, ...prev].slice(0, 500);
        try {
          localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(updated));
        } catch {
          // ignore
        }
        return updated;
      });
    },
    []
  );

  // 1. PERSISTENCE RESTORATION (On Mount)
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const savedSettings = localStorage.getItem(STORAGE_KEYS.SETTINGS);
        let parsedSettings: Partial<BotSettings> | null = null;
        if (savedSettings) {
          parsedSettings = JSON.parse(savedSettings);

          // Older builds persisted the raw API key/secret in this blob. Scrub it: browser storage is
          // not a keystore, and anything written there should be treated as exposed.
          const legacy = parsedSettings as Record<string, unknown>;
          if (legacy && (legacy.apiKey || legacy.apiSecret)) {
            delete legacy.apiKey;
            delete legacy.apiSecret;
            localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(parsedSettings));
            setTimeout(() => {
              appendLog(
                'SYSTEM',
                'WARN',
                'Removed a Binance API key/secret that an earlier version had saved in this browser. Delete that key on Binance (API Management) and re-add it via Settings — treat it as exposed.'
              );
            }, 0);
          }
          if (legacy && typeof legacy.isTestnet === 'undefined') legacy.isTestnet = true;
          setSettings((prev) => ({
            ...prev,
            ...parsedSettings,
            baseMargin: Number(parsedSettings?.baseMargin) || 2.0,
            leverage: Math.min(15, Math.max(10, Number(parsedSettings?.leverage) || 10)),
          }));
        }

        const savedAccount = localStorage.getItem(STORAGE_KEYS.BINANCE_ACCOUNT);
        if (savedAccount) {
          const parsed = JSON.parse(savedAccount);
          setBinanceAccount((prev) => ({ ...prev, ...parsed }));
        }

        const savedPositions = localStorage.getItem(STORAGE_KEYS.POSITIONS);
        if (savedPositions) {
          const parsed = JSON.parse(savedPositions);
          if (Array.isArray(parsed)) setPositions(parsed);
        }

        const savedTrades = localStorage.getItem(STORAGE_KEYS.CLOSED_TRADES);
        if (savedTrades) {
          const parsed = JSON.parse(savedTrades);
          if (Array.isArray(parsed)) setClosedTrades(parsed);
        }

        const savedCompounding = localStorage.getItem(STORAGE_KEYS.COMPOUNDING);
        if (savedCompounding) {
          const parsed = JSON.parse(savedCompounding);
          const restoredBase = Number(parsedSettings?.baseMargin ?? parsed.baseMargin) || 2.0;
          const restoredCompPct = Number(parsedSettings?.compoundingPercent ?? parsed.compoundingPercent) || 20;
          setCompoundingState((prev) => ({
            ...prev,
            ...parsed,
            baseMargin: restoredBase,
            compoundingPercent: restoredCompPct,
            currentMargin:
              (parsed.consecutiveWins || 0) === 0
                ? restoredBase
                : Math.max(restoredBase, Number(parsed.currentMargin) || restoredBase),
          }));
        } else if (parsedSettings) {
          const restoredBase = Number(parsedSettings.baseMargin) || 2.0;
          const restoredCompPct = Number(parsedSettings.compoundingPercent) || 20;
          setCompoundingState((prev) => ({
            ...prev,
            baseMargin: restoredBase,
            currentMargin: restoredBase,
            compoundingPercent: restoredCompPct,
          }));
        }

        const savedLogs = localStorage.getItem(STORAGE_KEYS.LOGS);
        if (savedLogs) {
          const parsed = JSON.parse(savedLogs);
          if (Array.isArray(parsed) && parsed.length > 0) setLogs(parsed);
        }
      } catch {
        // ignore JSON parse errors
      }
    }, 0);

    return () => clearTimeout(timer);
  }, [appendLog]);

  // Helper to apply updated settings and sync CompoundingState
  const applyUpdatedSettings = useCallback((newSet: BotSettings) => {
    setSettings(newSet);
    const newBase = Number(newSet.baseMargin) || 2.0;
    const newCompPct = Number(newSet.compoundingPercent) || 20;
    setCompoundingState((prev) => ({
      ...prev,
      baseMargin: newBase,
      compoundingPercent: newCompPct,
      currentMargin: prev.consecutiveWins === 0 ? newBase : Math.max(newBase, prev.currentMargin),
    }));
  }, []);

  // 2. PERSISTENCE SAVERS
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    } catch {
      // ignore
    }
  }, [settings]);

  useEffect(() => {
    if (binanceAccount.isSynced) {
      localStorage.setItem(STORAGE_KEYS.BINANCE_ACCOUNT, JSON.stringify(binanceAccount));
    }
  }, [binanceAccount]);

  useEffect(() => {
    positionsRef.current = positions;
    localStorage.setItem(STORAGE_KEYS.POSITIONS, JSON.stringify(positions));
  }, [positions]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.CLOSED_TRADES, JSON.stringify(closedTrades));
  }, [closedTrades]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.COMPOUNDING, JSON.stringify(compoundingState));
  }, [compoundingState]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(logs.slice(0, 500)));
  }, [logs]);

  // 3. BINANCE ACCOUNT AUTO-SYNC (Fetches Starting Balance, Equity, Platform Fees, Funding Fees & Live Positions)
  const syncBinanceAccount = useCallback(async () => {
    try {
      const { ok, status, data } = await apiPost<Record<string, any>>('/api/binance/sync-account', {});

      if (status === 401 || status === 403) {
        // An operator lockout is not a Binance credential problem — leave the session view alone.
        if (isOperatorLockout(data)) return;
        setSession((prev) => (prev.active ? { ...prev, active: false, source: 'none' } : prev));
        return;
      }

      if (ok) {
        if (typeof data.usedWeight === 'number') {
          setRateLimitStatus(
            checkRateLimit(data.usedWeight, 1200, (settings.rateLimitSafetyCap || 95) / 100)
          );
        }

        if (data.success && data.balance) {
          const b = data.balance;

          setBinanceAccount((prev) => {
            const lockedStarting =
              prev.startingBalance > 0
                ? prev.startingBalance
                : b.totalWalletBalance || b.currentEquity || 0;

            localStorage.setItem(STORAGE_KEYS.STARTING_BALANCE, String(lockedStarting));

            return {
              startingBalance: lockedStarting,
              currentEquity: b.currentEquity || b.totalWalletBalance,
              availableBalance: b.availableBalance,
              realizedPnl: b.totalRealizedPnl,
              unrealizedPnl: b.totalUnrealizedProfit,
              commissionFees: b.totalCommissionFees,
              fundingFees: b.totalFundingFees,
              isSynced: true,
            };
          });

          // Reconcile open positions markPrice & unrealizedPnl with live Binance positions, and
          // adopt any exchange position this browser doesn't know about (new device, cleared
          // storage, or a position the exchange bracket opened). Blindness to a live position is
          // worse than a duplicate row.
          if (Array.isArray(data.positions) && data.positions.length > 0) {
            setPositions((prevPositions) => {
              const liveBySymbol = new Map<
                string,
                {
                  symbol: string;
                  side: 'LONG' | 'SHORT';
                  quantity: number;
                  entryPrice: number;
                  markPrice: number;
                  unrealizedProfit: number;
                  leverage: number;
                  margin: number;
                }
              >();
              for (const lp of data.positions) {
                liveBySymbol.set(lp.symbol, lp);
              }

              const knownSymbols = new Set(prevPositions.map((p) => p.symbol));
              const adopted: TradePosition[] = data.positions
                .filter((lp: { symbol: string; quantity: number }) => {
                  if (knownSymbols.has(lp.symbol)) return false;
                  return Math.abs(Number(lp.quantity) || 0) > 0;
                })
                .map((lp: {
                  symbol: string;
                  side: 'LONG' | 'SHORT';
                  quantity: number;
                  entryPrice: number;
                  markPrice: number;
                  unrealizedProfit: number;
                  leverage: number;
                  margin: number;
                }) => {
                  const unrealizedPnl = Number(lp.unrealizedProfit.toFixed(2));
                  return {
                    id: `exch-${lp.symbol}-${Math.round(lp.entryPrice * 1000)}`,
                    symbol: lp.symbol,
                    side: lp.side,
                    entryPrice: lp.entryPrice,
                    markPrice: lp.markPrice,
                    margin: lp.margin,
                    leverage: lp.leverage || settings.leverage,
                    quantity: Math.abs(lp.quantity),
                    // Unknown from here: brackets live on the exchange. Zero means "no local
                    // monitor", not "no stop" — ActivePositions flags these rows.
                    stopLoss: 0,
                    takeProfit: 0,
                    unrealizedPnl,
                    unrealizedPnlPercent: lp.margin > 0 ? Number(((unrealizedPnl / lp.margin) * 100).toFixed(2)) : 0,
                    entryTime: Date.now(),
                    adoptedFromExchange: true,
                  };
                });

              if (adopted.length > 0) {
                setTimeout(() => {
                  appendLog(
                    'SYSTEM',
                    'WARN',
                    `Adopted ${adopted.length} live Binance position(s) not present in this browser: ${adopted.map((a) => `${a.symbol} ${a.side} x${a.quantity}`).join(', ')}. No local TP/SL is set for them — check their brackets on Binance.`
                  );
                }, 0);
              }

              return [...prevPositions.map((pos) => {
                const liveMatch = liveBySymbol.get(pos.symbol);
                if (!liveMatch) return pos;
                const markPrice = liveMatch.markPrice > 0 ? liveMatch.markPrice : pos.markPrice;
                const entryPrice = liveMatch.entryPrice > 0 ? liveMatch.entryPrice : pos.entryPrice;
                const margin = liveMatch.margin > 0 ? liveMatch.margin : pos.margin;
                const leverage = liveMatch.leverage > 0 ? liveMatch.leverage : pos.leverage;
                const unrealizedPnl = Number(liveMatch.unrealizedProfit.toFixed(2));
                const unrealizedPnlPercent =
                  margin > 0 ? Number(((unrealizedPnl / margin) * 100).toFixed(2)) : pos.unrealizedPnlPercent;

                return {
                  ...pos,
                  entryPrice,
                  markPrice,
                  margin,
                  leverage,
                  quantity: liveMatch.quantity > 0 ? liveMatch.quantity : pos.quantity,
                  unrealizedPnl,
                  unrealizedPnlPercent,
                };
              }), ...adopted];
            });
          }

          // Reconcile the other direction: a position that is gone from Binance (exchange bracket
          // fired, closed by hand, or settled by the engine) must not live on as a phantom open row.
          // Only `positionsVerified` answers count — a failed positionRisk call returns an empty
          // list that must never be read as "the account is flat".
          if (data.balance?.positionsVerified === true) {
            const liveSymbols = new Set<string>(
              (Array.isArray(data.positions) ? data.positions : []).map(
                (lp: { symbol: string }) => lp.symbol
              )
            );
            const vanished = positionsRef.current.filter((p) => !liveSymbols.has(p.symbol));
            for (const gone of vanished) {
              // Reuse the normal close path: it books locally (or stands down for the engine) and
              // reports the reason from where the price sat relative to the bracket.
              void finalizeCloseRef.current?.(gone, gone.markPrice, classifyExit(gone, gone.markPrice));
            }
          }
        }
      }
    } catch {
      // Background sync is best-effort; failures are surfaced by the next scan instead.
    }
  }, [settings.rateLimitSafetyCap, settings.leverage, appendLog]);

  // Refresh the server-side session/policy state (never stores keys client-side).
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/binance/credentials', { credentials: 'same-origin', cache: 'no-store' });
        const data = await res.json();
        if (!alive || !res.ok) return;
        setSession({
          active: Boolean(data.active),
          source: data.source ?? 'none',
          isTestnet: data.isTestnet !== false,
          keyHint: data.keyHint ?? null,
          expiresInMs: data.expiresInMs ?? null,
          orderPlacementAllowed: data.policy ? !data.policy.halted : undefined,
          mainnetAllowed: data.policy?.mainnetAllowed,
        });
      } catch {
        /* server unreachable — leave current session view alone */
      }
    };
    load();
    const interval = setInterval(load, 120000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  // Operator session state (public endpoint: it only reports *whether* a session is required).
  const refreshOperator = useCallback(async () => {
    try {
      const res = await fetch('/api/operator/status', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setOperator({
        required: Boolean(data.required),
        configured: Boolean(data.configured),
        authenticated: Boolean(data.authenticated),
      });
    } catch {
      /* server unreachable — leave the current view alone */
    }
  }, []);

  useEffect(() => {
    // Scheduled rather than called inline so the effect body performs no state update itself.
    const kick = setTimeout(() => void refreshOperator(), 250);
    const interval = setInterval(() => void refreshOperator(), 60000);
    const onLocked = () =>
      setOperator((prev) => ({
        required: true,
        configured: prev ? prev.configured : true,
        authenticated: false,
      }));
    window.addEventListener(OPERATOR_LOCK_EVENT, onLocked);
    return () => {
      clearTimeout(kick);
      clearInterval(interval);
      window.removeEventListener(OPERATOR_LOCK_EVENT, onLocked);
    };
  }, [refreshOperator]);

  // Auto-sync account whenever a server session exists, every 30s.
  useEffect(() => {
    if (!session.active) return;
    const initialTimer = setTimeout(() => {
      syncBinanceAccount();
    }, 0);
    const interval = setInterval(syncBinanceAccount, 30000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [session.active, session.isTestnet, syncBinanceAccount]);

  const refreshEngineStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/engine/status', {
        headers: { 'X-TM-Request': '1' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => null)) as EngineStatusPayload | null;
      if (res.ok && data) {
        setEngineState(data);
        setEngineError(null);
        engineManagedRef.current = new Set(
          (data.ledger?.openPositions ?? []).filter((p) => !p.foreign).map((p) => p.symbol)
        );
        // Only while the loop is genuinely running does it settle trades from exchange income; a
        // stopped engine will never book anything, so local booking must take over again.
        engineAuthorityRef.current = Boolean(data.engine?.running);
      } else {
        setEngineError(data ? JSON.stringify(data).slice(0, 160) : `HTTP ${res.status}`);
      }
    } catch (err) {
      setEngineError((err as Error).message);
    } finally {
      setEngineLoading(false);
    }
  }, []);

  useEffect(() => {
    // Scheduled rather than called inline so the effect itself performs no state update.
    const kick = setTimeout(() => void refreshEngineStatus(), 250);
    const interval = setInterval(() => void refreshEngineStatus(), 10000);
    return () => {
      clearTimeout(kick);
      clearInterval(interval);
    };
  }, [refreshEngineStatus]);

  const onRefreshEngine = React.useCallback(() => {
    setEngineLoading(true);
    void refreshEngineStatus();
  }, [refreshEngineStatus]);

  const handleEngineAction = useCallback(
    async (action: 'start' | 'stop' | 'halt-entries' | 'resume-entries' | 'flatten-all'): Promise<string | null> => {
      try {
        const { ok, data } = await apiPost<Record<string, unknown>>('/api/engine/control', {
          action,
          ...(action === 'flatten-all' ? { confirm: 'FLATTEN' } : {}),
        });
        await refreshEngineStatus();
        appendLog(
          'SYSTEM',
          ok ? 'SUCCESS' : 'WARN',
          `Engine ${action}: ${String(data.message ?? data.error ?? (ok ? 'done' : 'failed'))}`
        );
        return ok ? null : String(data.error ?? data.message ?? 'Engine action failed');
      } catch (err) {
        return (err as Error).message;
      }
    },
    [appendLog, refreshEngineStatus]
  );

  /** Register a UI-opened position with the server guardian so it survives this tab closing. */
  const trackWithEngine = useCallback(async (pos: TradePosition) => {
    try {
      await apiPost('/api/engine/track', pos as unknown as Record<string, unknown>);
    } catch {
      /* the local ledger stays authoritative; the panel will show if tracking failed */
    }
  }, []);

  const untrackWithEngine = useCallback(async (symbol: string) => {
    try {
      await fetch(`/api/engine/track?symbol=${encodeURIComponent(symbol)}`, {
        method: 'DELETE',
        headers: { 'X-TM-Request': '1' },
        credentials: 'same-origin',
      });
    } catch {
      /* best effort */
    }
  }, []);

  /** One switch, no redeploy: let the server open trades unattended (still fully policy-gated). */
  const handleToggleAutopilot = useCallback(
    async (enabled: boolean, confirm?: string): Promise<string | null> => {
      const { ok, data } = await apiPost<Record<string, unknown>>('/api/engine/control', {
        action: 'set-auto-entry',
        enabled,
        ...(confirm ? { confirm } : {}),
      });
      await refreshEngineStatus();
      appendLog(
        'SYSTEM',
        ok ? (enabled ? 'WARN' : 'INFO') : 'ERROR',
        `Autopilot: ${String(data.message ?? data.error ?? 'no response')}`
      );
      return ok ? null : String(data.error ?? data.message ?? 'Could not change autopilot state');
    },
    [appendLog, refreshEngineStatus]
  );

  // Execute a position close on Binance and record trade history + compounding
  const finalizePositionClose = useCallback(
    async (
      pos: TradePosition,
      exitPrice: number,
      reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL_CLOSE'
    ) => {
      if (closingIdsRef.current.has(pos.id)) return;
      closingIdsRef.current.add(pos.id);
      setClosingPositionId(pos.id);

      let finalExitPrice = exitPrice;

      /**
       * A close that the exchange did not confirm is NOT a closed trade. Booking it anyway would
       * fabricate PnL from an estimate and hide a live position from this dashboard, so every
       * failure path below keeps the row and says what is actually known. (The 30s account sync
       * reconciles the other way round: once Binance really is flat, it books the trade.)
       */
      const abortClose = (message: string) => {
        appendLog('ERROR', 'ERROR', message);
        closingIdsRef.current.delete(pos.id);
        setClosingPositionId(null);
      };

      // Flatten on the exchange through the guarded endpoint. The server closes the *live*
      // position size it reads from Binance, so a stale local quantity can't leave a residual.
      if (session.active) {
        try {
          const { ok, status, data: closeData } = await apiPost<Record<string, any>>('/api/binance/execute', {
            action: 'CLOSE',
            symbol: pos.symbol,
            side: pos.side,
            price: exitPrice,
          });

          if (status === 401 || status === 403) {
            if (isOperatorLockout(closeData)) {
              return abortClose(
                `Operator sign-in required to close ${pos.symbol} — the server refused before reaching Binance, so the position is untouched. Sign in and close it again.`
              );
            }
            setSession((prev) => ({ ...prev, active: false, source: 'none' }));
            return abortClose(
              `Not authorized to close ${pos.symbol} on Binance (Binance session rejected) — the position is still open there. Reconnect your API key in Settings and retry.`
            );
          }

          if (!ok || !closeData.success) {
            const detail = closeData.error || `HTTP ${status}`;
            return abortClose(
              `Binance close failed for ${pos.symbol}: ${detail} The position may still be OPEN on the exchange — verify on Binance. This row is intentionally kept so it cannot be forgotten.`
            );
          }

          if (Number(closeData.avgPrice) > 0) finalExitPrice = Number(closeData.avgPrice);

          if (closeData.noPosition && engineManagedRef.current.has(pos.symbol)) {
              // The engine already settled this trade against the exchange income ledger. Booking it
              // again here from local prices would double-count PnL and corrupt the compounding step.
              appendLog('ORDER', 'INFO', `${pos.symbol} was settled by the server engine (see the engine log); not re-booked locally.`);
              engineManagedRef.current.delete(pos.symbol);
              setPositions((prev) => prev.filter((p) => p.id !== pos.id));
              closingIdsRef.current.delete(pos.id);
              setClosingPositionId(null);
              void untrackWithEngine(pos.symbol);
              return;
            }
            if (engineAuthorityRef.current && engineManagedRef.current.has(pos.symbol)) {
              // The running engine owns this symbol and settles from Binance's income stream (real
              // commission + funding), so it is the book of record for it. Deliberately NOT booking
              // here: a local flat-fee estimate would double-count the trade and let the browser's
              // compounding ladder drift away from the settled one. The ledger row is left in place
              // so the engine can settle this close on its next cycle.
              appendLog(
                'ORDER',
                'INFO',
                `${pos.symbol} closed on Binance. The server engine owns this position, so it settles the trade from the exchange income ledger (real fees + funding) and books it there — this browser does not re-book it. See the engine panel for the settled PnL.`
              );
              engineManagedRef.current.delete(pos.symbol);
              setPositions((prev) => prev.filter((p) => p.id !== pos.id));
              closingIdsRef.current.delete(pos.id);
              setClosingPositionId(null);
              void refreshEngineStatus();
              return;
            }
            if (closeData.noPosition) {
              appendLog('ORDER', 'INFO', `${pos.symbol} was already flat on Binance (exchange bracket fired). Recorded locally at $${roundCryptoPrice(finalExitPrice)}.`);
            }
            void untrackWithEngine(pos.symbol);
        } catch (err) {
          const e = err as Error;
          return abortClose(
            `Close request for ${pos.symbol} errored (${e.message}). The exchange state is unknown — verify the position on Binance; the row is kept and the next sync will reconcile it.`
          );
        }
      }

      const priceDiff =
        pos.side === 'LONG' ? finalExitPrice - pos.entryPrice : pos.entryPrice - finalExitPrice;
      const notional = pos.margin * pos.leverage;
      const grossPnl = pos.entryPrice > 0 ? (priceDiff / pos.entryPrice) * notional : 0;
      // Deduct Binance Futures round-trip taker commission (0.05% per side = 0.10% of notional)
      const roundTripFee = notional * 0.001;
      const realizedPnl = Number((grossPnl - roundTripFee).toFixed(2));
      const realizedPnlPercent =
        pos.margin > 0 ? Number(((realizedPnl / pos.margin) * 100).toFixed(2)) : 0;

      const isWin = realizedPnl > 0;

      setCompoundingState((prevComp) => {
        const compoundingResult = calculateNextTradeMargin(prevComp, {
          isWin,
          profit: realizedPnl,
        });

        const closedTradeRecord: ClosedTrade = {
          id: generateUniqueId('trade'),
          symbol: pos.symbol,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice: roundCryptoPrice(finalExitPrice),
          margin: pos.margin,
          leverage: pos.leverage,
          pnl: realizedPnl,
          pnlPercent: realizedPnlPercent,
          entryTime: pos.entryTime,
          exitTime: Date.now(),
          reason,
          isWin,
          compoundingBonusGenerated: compoundingResult.bonusAdded,
        };

        setClosedTrades((prev) => {
          const map = new Map<string, ClosedTrade>();
          map.set(closedTradeRecord.id, closedTradeRecord);
          for (const item of prev) {
            if (!map.has(item.id)) {
              map.set(item.id, item);
            }
          }
          return Array.from(map.values());
        });

        setTradeResultModal({
          isOpen: true,
          isProfit: closedTradeRecord.isWin,
          pnl: closedTradeRecord.pnl,
          pnlPercent: closedTradeRecord.pnlPercent,
          symbol: closedTradeRecord.symbol,
          side: closedTradeRecord.side,
          entryPrice: closedTradeRecord.entryPrice,
          exitPrice: closedTradeRecord.exitPrice,
          reason: closedTradeRecord.reason,
          compoundingBonus: closedTradeRecord.compoundingBonusGenerated,
        });

        appendLog(
          'ORDER',
          isWin ? 'SUCCESS' : 'WARN',
          `${reason.replace('_', ' ')} executed on ${pos.symbol} at $${roundCryptoPrice(finalExitPrice)}. Net PnL (after fees): ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)} (${realizedPnlPercent.toFixed(2)}%). Next trade margin: $${compoundingResult.nextMargin.toFixed(2)}`
        );

        return compoundingResult.newState;
      });

      setPositions((prev) => prev.filter((p) => p.id !== pos.id));
      closingIdsRef.current.delete(pos.id);
      setClosingPositionId(null);
      syncBinanceAccount();
    },
    [appendLog, session.active, syncBinanceAccount, untrackWithEngine, refreshEngineStatus]
  );

  // Expose the latest close function to the account-sync reconciler (a ref, not a dependency, so
  // `syncBinanceAccount` and `finalizePositionClose` do not form a useCallback cycle).
  useEffect(() => {
    finalizeCloseRef.current = (pos, exitPrice, reason) => {
      void finalizePositionClose(pos, exitPrice, reason);
    };
  }, [finalizePositionClose]);

  // Scan Market Pairs
  const runMarketScan = useCallback(async () => {
    // Two overlapping cycles used to be able to submit the same live entry twice: closes had an
    // in-flight lock, opens had nothing.
    if (scanInFlightRef.current) return;
    scanInFlightRef.current = true;

    if (botActive && !session.active) {
      scanInFlightRef.current = false;
      setBotActive(false);
      appendLog(
        'ERROR',
        'ERROR',
        'Binance session is not active on the server — bot PAUSED and no orders will be sent. Reconnect your API key in Settings.'
      );
      return;
    }

    const safetyCap = settings.rateLimitSafetyCap || 95;
    if (rateLimitStatus.isThrottled || rateLimitStatus.usagePercent >= safetyCap) {
      appendLog(
        'RATE_LIMIT',
        'WARN',
        `API rate limit reached ${rateLimitStatus.usagePercent.toFixed(1)}% (>=${safetyCap}% safety cap). Halting scan cycle and waiting for cooldown.`
      );
      setIsScanning(false);
      scanInFlightRef.current = false;
      return;
    }

    setIsScanning(true);
    try {
      // The server derives testnet/mainnet from the session, so the scanner can never evaluate a
      // different market from the one the executor trades.
      const res = await fetch(`/api/binance/scan?safetyCap=${safetyCap}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => null);
      if (data && Array.isArray(data.failures) && data.failures.length > 0) {
        appendLog(
          'SCAN',
          'WARN',
          `${data.failures.length}/${Array.isArray(data.requestedPairs) ? data.requestedPairs.length : '?'} pairs returned no usable candles (${data.failures
            .slice(0, 3)
            .map((f: { pair: string; error: string }) => `${f.pair}: ${f.error}`)
            .join('; ')}).`
        );
      }
      if (!res.ok && (!data || !Array.isArray(data.signals))) {
        appendLog('ERROR', 'ERROR', `Market scan failed: ${data?.error || `HTTP ${res.status}`}. No orders sent this cycle.`);
      }
      if (data && data.signals && Array.isArray(data.signals)) {
          setSignals(data.signals);
          if (data.candles) {
            setCandlesMap(data.candles);
          }
          if (data.rateLimitStatus) {
            setRateLimitStatus(data.rateLimitStatus);
          }

          // Evaluate Auto-Trade Opportunity
          if (botActive) {
            const topScore = data.signals[0];
            appendLog(
              'SCAN',
              'INFO',
              `Market scan evaluated ${data.signals.length} Binance 5m pairs. Top setup: ${topScore?.symbol || 'None'} (${topScore?.signal || 'NEUTRAL'}, Score: ${topScore?.score || 0}%, Volatility: ${topScore?.volatilityPercent?.toFixed(2) || '0'}%).`
            );

            const openLimit = canOpenNewTrade(positions.length, settings.maxOpenTrades);
            if (openLimit.allowed) {
              const openSymbols = new Set(positions.map((p) => p.symbol));
              const topCandidate = data.signals.find(
                (s: SignalEvaluation) =>
                  !openSymbols.has(s.symbol) &&
                  // The server refuses symbols with no exchange filter data; don't even try.
                  (data.tradeable ? data.tradeable[s.symbol] !== false : true) &&
                  !submittedSignalsRef.current.has(
                    `${s.symbol}:${s.action}:${s.currentPrice}`
                  ) &&
                  (s.signal === 'STRONG_BUY' ||
                    s.signal === 'STRONG_SELL' ||
                    (s.signal === 'BUY' && s.score >= 65) ||
                    (s.signal === 'SELL' && s.score >= 65))
              );

              if (topCandidate) {
                appendLog(
                  'SIGNAL',
                  'SUCCESS',
                  `HIGH-PROBABILITY 3-INDICATOR CONVERGENCE: ${topCandidate.signal} on ${topCandidate.symbol} (Score: ${topCandidate.score}%). HVN: ${topCandidate.hvnProfile.priceRelation} (POC $${topCandidate.hvnProfile.pocPrice}), Absorption: ${topCandidate.absorption.type}, Imbalance: ${topCandidate.imbalance.type}. Submitting order to Binance...`
                );

                const tradeMargin = compoundingState.currentMargin;
                const leverage = Math.min(15, Math.max(10, settings.leverage || 10));
                const entryPrice = topCandidate.currentPrice;

                try {
                  const signalId = `${topCandidate.symbol}:${topCandidate.action}:${topCandidate.currentPrice}:${topCandidate.score}`;
                  submittedSignalsRef.current.add(signalId);

                  const { ok, status, data: execData } = await apiPost<Record<string, any>>(
                    '/api/binance/execute',
                    {
                      action: 'OPEN',
                      symbol: topCandidate.symbol,
                      side: topCandidate.action, // mapped to BUY/SELL in the execute route
                      margin: tradeMargin,
                      leverage,
                      price: entryPrice,
                      stopLoss: topCandidate.slPrice,
                      takeProfit: topCandidate.tpPrice,
                      // One signal -> one order. A replayed cycle is rejected server-side.
                      idempotencyKey: generateUniqueId('sig'),
                    }
                  );

                  if (status === 401 || status === 403) {
                    setBotActive(false);
                    if (isOperatorLockout(execData)) {
                      appendLog('ERROR', 'ERROR', `Operator sign-in required (${status}). Bot paused before sending any order — sign in again to resume.`);
                      return;
                    }
                    setSession((prev) => ({ ...prev, active: false, source: 'none' }));
                    appendLog('ERROR', 'ERROR', `Execution unauthorized (${status}). Bot paused — reconnect your API session in Settings.`);
                    return;
                  }

                  if (!ok || !execData.success) {
                    const violations = Array.isArray(execData.violations)
                      ? ` ${execData.violations.map((v: { message: string }) => v.message).join(' | ')}`
                      : '';

                    // The server says an order DID reach Binance even though the call failed:
                    // stop trading, adopt the real position, and surface the exposure loudly.
                    if (execData.orderPlaced) {
                      setBotActive(false);
                      appendLog(
                        'ERROR',
                        'ERROR',
                        `⚠ AMBIGUOUS EXECUTION (${execData.code || 'UNKNOWN'}): ${execData.error} Bot paused so no further entries are sent.`
                      );
                      void syncBinanceAccount();
                      return;
                    }

                    appendLog(
                      'ERROR',
                      'ERROR',
                      `Binance live order NOT placed: ${execData.error || execData.code || 'API rejected the order'}.${violations}`
                    );
                    return;
                  }

                  const fillPrice = parseFloat(execData.avgPrice) || entryPrice;
                  const quantity = parseFloat(execData.executedQty) || 0;
                  // Book what the exchange actually did — LOT_SIZE/MIN_NOTIONAL rounding can change
                  // the committed notional, and the compounding ladder must follow reality.
                  const bookedMargin =
                    Number(execData.effectiveMargin) > 0
                      ? Number(execData.effectiveMargin)
                      : tradeMargin;

                  const newPosition: TradePosition = {
                    id: String(execData.orderId || generateUniqueId('pos')),
                    symbol: topCandidate.symbol,
                    side: topCandidate.action as 'LONG' | 'SHORT',
                    entryPrice: fillPrice,
                    markPrice: fillPrice,
                    margin: bookedMargin,
                    leverage: Number(execData.leverage) || leverage,
                    quantity:
                      quantity > 0
                        ? quantity
                        : Number(((bookedMargin * leverage) / fillPrice).toFixed(6)),
                    stopLoss: Number(execData.stopLoss) || topCandidate.slPrice,
                    takeProfit: Number(execData.takeProfit) || topCandidate.tpPrice,
                    unrealizedPnl: 0,
                    unrealizedPnlPercent: 0,
                    entryTime: Date.now(),
                    slOrderId: execData.slOrderId,
                    tpOrderId: execData.tpOrderId,
                  };

                  let didAdd = false;
                  setPositions((prev) => {
                    if (prev.length >= settings.maxOpenTrades) return prev;
                    if (prev.some((p) => p.symbol === topCandidate.symbol)) return prev;
                    didAdd = true;
                    return [...prev, newPosition];
                  });

                  if (didAdd) {
                    appendLog(
                      'ORDER',
                      'SUCCESS',
                      `${execData.network === 'testnet' ? 'TESTNET' : 'LIVE MAINNET'} ORDER FILLED: ${execData.orderSide || topCandidate.action} ${newPosition.quantity} ${topCandidate.symbol} @ $${newPosition.entryPrice}. Notional $${Number(execData.effectiveNotional).toFixed(2)} / margin $${bookedMargin.toFixed(2)} @ ${newPosition.leverage}x isolated. SL $${newPosition.stopLoss} on exchange${execData.slOrderId ? ' ✓' : ' ✗ MISSING'} · TP $${newPosition.takeProfit}${execData.tpOrderId ? ' ✓' : ' (not placed)'}. Order ${execData.orderId}`,
                      {
                        signal: topCandidate.signal,
                        score: topCandidate.score,
                        sizingNotes: execData.sizingNotes,
                        bracketWarning: execData.bracketWarning,
                        reasons: topCandidate.reasons,
                      }
                    );
                    if (execData.bracketWarning) {
                      appendLog('SYSTEM', 'WARN', `Trade Master: ${execData.bracketWarning}`);
                    }
                    void trackWithEngine(newPosition);
                    syncBinanceAccount();
                  }
                } catch (apiErr: unknown) {
                  const err = apiErr as Error;
                  appendLog('ERROR', 'ERROR', `Live API execution exception: ${err.message}`);
                }
              } else {
                appendLog(
                  'SCAN',
                  'INFO',
                  `No pairs met entry threshold (>=65% score or STRONG signal) in this cycle. Standing by for next ${settings.scanIntervalSeconds || 15}s scan.`
                );
              }
            } else {
              appendLog(
                'SYSTEM',
                'INFO',
                `Max positions capacity reached (${positions.length}/${settings.maxOpenTrades}). Monitoring open trades for Indicator TP/SL.`
              );
            }
          }
      }
    } catch (err: unknown) {
      const error = err as Error;
      appendLog('ERROR', 'ERROR', `Scan error: ${error.message}`);
    } finally {
      setIsScanning(false);
      setScanCountdown(settings.scanIntervalSeconds || 15);
      scanInFlightRef.current = false;
    }
  }, [
    botActive,
    compoundingState.currentMargin,
    positions,
    rateLimitStatus.isThrottled,
    rateLimitStatus.usagePercent,
    session.active,
    settings.leverage,
    settings.maxOpenTrades,
    settings.rateLimitSafetyCap,
    settings.scanIntervalSeconds,
    appendLog,
    syncBinanceAccount,
    trackWithEngine,
  ]);

  const runMarketScanRef = useRef(runMarketScan);
  useEffect(() => {
    runMarketScanRef.current = runMarketScan;
  }, [runMarketScan]);

  // Automated Scan Loop
  useEffect(() => {
    if (!botActive) return;

    const cycleTime = settings.scanIntervalSeconds || 15;
    const timer = setInterval(() => {
      setScanCountdown((prev) => {
        if (prev <= 1) {
          setTimeout(() => {
            runMarketScanRef.current();
          }, 0);
          return cycleTime;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [botActive, settings.scanIntervalSeconds]);

  // Position Real-Price Update & Indicator-Driven Dynamic TP/SL Engine (0% Simulation)
  useEffect(() => {
    if (positions.length === 0) return;

    const updateInterval = setInterval(() => {
      const toClose: {
        pos: TradePosition;
        exitPrice: number;
        reason: 'TAKE_PROFIT' | 'STOP_LOSS';
      }[] = [];

      setPositions((prevPositions) =>
        prevPositions.map((pos) => {
          const liveCandles = candlesMap[pos.symbol];
          // Use real Binance kline close or keep synced Binance markPrice (no Math.random() simulation)
          const currentPrice =
            liveCandles && liveCandles.length > 0
              ? roundCryptoPrice(liveCandles[liveCandles.length - 1].close)
              : pos.markPrice;

          const priceDiff =
            pos.side === 'LONG' ? currentPrice - pos.entryPrice : pos.entryPrice - currentPrice;
          const notional = pos.margin * pos.leverage;
          const grossPnl = pos.entryPrice > 0 ? (priceDiff / pos.entryPrice) * notional : 0;
          const unrealizedPnl = Number(grossPnl.toFixed(2));
          const unrealizedPnlPercent =
            pos.margin > 0 ? Number(((unrealizedPnl / pos.margin) * 100).toFixed(2)) : 0;

          let isHitTP = false;
          let isHitSL = false;

          if (pos.takeProfit > 0 && pos.stopLoss > 0) {
            if (pos.side === 'LONG') {
              if (currentPrice >= pos.takeProfit) isHitTP = true;
              if (currentPrice <= pos.stopLoss) isHitSL = true;
            } else {
              if (currentPrice <= pos.takeProfit) isHitTP = true;
              if (currentPrice >= pos.stopLoss) isHitSL = true;
            }
          }

          if (
            (isHitTP || isHitSL) &&
            !closingIdsRef.current.has(pos.id) &&
            // The server engine owns this one: two brains acting on one position means a duplicated
            // close and a double-booked trade in history.
            !engineManagedRef.current.has(pos.symbol)
          ) {
            toClose.push({
              pos: { ...pos, markPrice: currentPrice, unrealizedPnl, unrealizedPnlPercent },
              exitPrice: currentPrice,
              reason: isHitTP ? 'TAKE_PROFIT' : 'STOP_LOSS',
            });
          }

          return {
            ...pos,
            markPrice: currentPrice,
            unrealizedPnl,
            unrealizedPnlPercent,
          };
        })
      );

      for (const item of toClose) {
        finalizePositionClose(item.pos, item.exitPrice, item.reason);
      }
    }, 2000);

    return () => clearInterval(updateInterval);
  }, [candlesMap, positions.length, finalizePositionClose]);

  // Close Position Manually on Binance & Local State
  const handleClosePosition = useCallback(
    (posId: string) => {
      const pos = positions.find((p) => p.id === posId);
      if (!pos) return;
      finalizePositionClose(pos, pos.markPrice, 'MANUAL_CLOSE');
    },
    [positions, finalizePositionClose]
  );

  // Manual Trade Execution from Scanner
  const handleManualExecute = useCallback(
    async (sig: SignalEvaluation) => {
      if (!session.active) {
        appendLog('ORDER', 'WARN', 'No active Binance session on the server — open one in Settings before placing a manual order.');
        setActiveTab('settings');
        return;
      }

      const check = canOpenNewTrade(positions.length, settings.maxOpenTrades);
      if (!check.allowed) {
        appendLog('ORDER', 'WARN', `Cannot open trade: ${check.reason}`);
        return;
      }

      const tradeMargin = compoundingState.currentMargin;
      const leverage = Math.min(15, Math.max(10, settings.leverage || 10));

      try {
        const { ok, status, data: execData } = await apiPost<Record<string, any>>(
          '/api/binance/execute',
          {
            action: 'OPEN',
            symbol: sig.symbol,
            side: sig.action,
            margin: tradeMargin,
            leverage,
            price: sig.currentPrice,
            stopLoss: sig.slPrice,
            takeProfit: sig.tpPrice,
            idempotencyKey: generateUniqueId('man'),
          }
        );

        if (status === 401 || status === 403) {
          if (isOperatorLockout(execData)) {
            appendLog('ERROR', 'ERROR', `Operator sign-in required (${status}) — no order was sent. Sign in again to trade.`);
            return;
          }
          setSession((prev) => ({ ...prev, active: false, source: 'none' }));
          appendLog('ERROR', 'ERROR', 'Execution unauthorized — reconnect your API session in Settings.');
          setActiveTab('settings');
          return;
        }

        if (!ok || !execData.success) {
          if (execData.orderPlaced) {
            setBotActive(false);
            appendLog('ERROR', 'ERROR', `⚠ AMBIGUOUS EXECUTION (${execData.code || 'UNKNOWN'}): ${execData.error}. Bot paused.`);
            void syncBinanceAccount();
            return;
          }
          appendLog(
            'ERROR',
            'ERROR',
            `Binance live order NOT placed: ${execData.error || execData.code || 'API rejected the order'}`
          );
          return;
        }

        const entryPrice = parseFloat(execData.avgPrice) || sig.currentPrice;
        const quantity = parseFloat(execData.executedQty) || 0;
        const bookedMargin =
          Number(execData.effectiveMargin) > 0 ? Number(execData.effectiveMargin) : tradeMargin;

        const newPos: TradePosition = {
          id: String(execData.orderId || generateUniqueId('pos')),
          symbol: sig.symbol,
          side: sig.action as 'LONG' | 'SHORT',
          entryPrice,
          markPrice: entryPrice,
          margin: bookedMargin,
          leverage: Number(execData.leverage) || leverage,
          quantity:
            quantity > 0 ? quantity : Number(((bookedMargin * leverage) / entryPrice).toFixed(6)),
          stopLoss: Number(execData.stopLoss) || sig.slPrice,
          takeProfit: Number(execData.takeProfit) || sig.tpPrice,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          entryTime: Date.now(),
          slOrderId: execData.slOrderId,
          tpOrderId: execData.tpOrderId,
        };

        let didAdd = false;
        setPositions((prev) => {
          if (prev.length >= settings.maxOpenTrades) return prev;
          if (prev.some((p) => p.symbol === sig.symbol)) return prev;
          didAdd = true;
          return [...prev, newPos];
        });

        if (didAdd) {
          appendLog(
            'ORDER',
            'SUCCESS',
            `${execData.network === 'testnet' ? 'TESTNET' : 'LIVE MAINNET'} MANUAL ORDER FILLED: ${execData.orderSide} ${quantity} ${sig.symbol} @ $${entryPrice}. Notional $${Number(execData.effectiveNotional).toFixed(2)} (margin $${bookedMargin.toFixed(2)} @ ${leverage}x). SL $${sig.slPrice}${execData.slOrderId ? ' on exchange ✓' : ' ✗ MISSING'} · TP $${sig.tpPrice}${execData.tpOrderId ? ' ✓' : ' (not placed)'}. Order ID: ${execData.orderId}`
          );
          if (execData.bracketWarning) {
            appendLog('SYSTEM', 'WARN', `Trade Master: ${execData.bracketWarning}`);
          }
          void trackWithEngine(newPos);
          syncBinanceAccount();
        }
      } catch (apiErr: unknown) {
        const err = apiErr as Error;
        appendLog('ERROR', 'ERROR', `Live API execution exception: ${err.message}`);
      }
    },
    [
      appendLog,
      compoundingState.currentMargin,
      positions.length,
      session.active,
      settings.leverage,
      settings.maxOpenTrades,
      syncBinanceAccount,
      trackWithEngine,
    ]
  );

  // Test Binance Connection
  const handleTestConnection = async () => {
    setIsTestingConnection(true);
    try {
      const { ok, data } = await apiPost<Record<string, any>>('/api/binance/test-connection', {});

      if (data?.policy) {
        setSession((prev) => ({
          ...prev,
          orderPlacementAllowed: !data.policy.halted,
          mainnetAllowed: data.policy.mainnetAllowed,
        }));
      }

      if (ok) {
        const isOk = Boolean(data.auth?.valid);
        setConnectionResult({
          tested: true,
          success: isOk,
          message:
            data.auth?.message ||
            (isOk
              ? 'Connected to Binance Futures successfully'
              : 'Binance ping succeeded, but API key authentication failed'),
          latencyMs: data.ping?.latencyMs,
          balance: data.auth?.balance,
        });

        appendLog(
          'SYSTEM',
          isOk ? 'SUCCESS' : 'WARN',
          `Binance connection test: ${data.auth?.message || data.ping?.status}. Latency: ${data.ping?.latencyMs ?? 0}ms.`
        );

        if (isOk) {
          syncBinanceAccount();
        }
      } else {
        setConnectionResult({
          tested: true,
          success: false,
          message: data.error || 'Connection verification failed',
        });
        appendLog('ERROR', 'ERROR', `Binance connection test failed: ${data.error}`);
      }
    } catch (err: unknown) {
      const error = err as Error;
      setConnectionResult({
        tested: true,
        success: false,
        message: error.message || 'Network error reaching test endpoint',
      });
      appendLog('ERROR', 'ERROR', `Network error during Binance test: ${error.message}`);
    } finally {
      setIsTestingConnection(false);
    }
  };

  const handleConnectCredentials = useCallback(
    async (apiKey: string, apiSecret: string, isTestnet: boolean) => {
      try {
        const { ok, data } = await apiPost<Record<string, any>>('/api/binance/credentials', {
          apiKey,
          apiSecret,
          isTestnet,
        });

        if (ok && data.success) {
          setSession({
            active: true,
            source: 'session',
            isTestnet: Boolean(data.network === 'testnet'),
            keyHint: data.keyHint ?? null,
          });
          setSettings((prev) => ({ ...prev, isTestnet: data.network !== 'mainnet' }));
          appendLog(
            'SYSTEM',
            data.network === 'mainnet' ? 'WARN' : 'SUCCESS',
            `Binance ${data.network} credentials verified. ${data.message}`
          );
          void syncBinanceAccount();
          return true;
        }

        appendLog('ERROR', 'ERROR', `Credential verification failed: ${data.error || 'Binance rejected the key'}`);
        return false;
      } catch (err) {
        appendLog('ERROR', 'ERROR', `Credential verification error: ${(err as Error).message}`);
        return false;
      }
    },
    [appendLog, syncBinanceAccount]
  );

  const handleDisconnectCredentials = useCallback(async () => {
    try {
      await fetch('/api/binance/credentials', {
        method: 'DELETE',
        headers: { 'X-TM-Request': '1' },
        credentials: 'same-origin',
      });
    } catch {
      /* still drop local view */
    }
    setBotActive(false);
    setSession({ active: false, source: 'none', isTestnet: true });
    appendLog('SYSTEM', 'WARN', 'Binance credential session revoked on the server. Bot stopped; no further orders will be sent.');
  }, [appendLog]);

  // Performance calculations
  const totalPnl = closedTrades.reduce((acc, t) => acc + t.pnl, 0);
  const winningTrades = closedTrades.filter((t) => t.isWin).length;
  const losingTrades = closedTrades.length - winningTrades;
  const winRate = closedTrades.length > 0 ? (winningTrades / closedTrades.length) * 100 : 0;
  const baseStartingCapital =
    binanceAccount.startingBalance > 0 ? binanceAccount.startingBalance : 100.0;
  const totalPnlPercent = (totalPnl / baseStartingCapital) * 100;

  // Bot Start/Pause handlers
  const handleStartBot = useCallback(
    (updatedSettings?: BotSettings) => {
      const activeSettings = updatedSettings || settings;
      if (!session.active) {
        appendLog(
          'SYSTEM',
          'WARN',
          'Cannot start bot: no verified Binance session on the server. Open one in Settings first.'
        );
        setActiveTab('settings');
        return;
      }
      if (!activeSettings.isTestnet) {
        appendLog(
          'SYSTEM',
          'WARN',
          'MAINNET START: this bot will send real orders with real funds. Confirm your stop-loss policy and available balance on Binance before proceeding.'
        );
      }

      if (updatedSettings) {
        applyUpdatedSettings(updatedSettings);
      }
      setBotActive(true);
      setActiveTab('positions');
      setScanCountdown(activeSettings.scanIntervalSeconds || 15);
      runMarketScan();
      syncBinanceAccount();
      appendLog(
        'SYSTEM',
        'SUCCESS',
        `Trade Master bot STARTED on ${activeSettings.isTestnet ? 'TESTNET (paper)' : 'MAINNET (REAL MONEY)'}: scanning 5m pairs every ${activeSettings.scanIntervalSeconds || 15}s with $${activeSettings.baseMargin.toFixed(2)} base margin (${activeSettings.leverage}x isolated).`
      );
    },
    [settings, session.active, runMarketScan, appendLog, syncBinanceAccount, applyUpdatedSettings]
  );

  const handlePauseBot = useCallback(() => {
    setBotActive(false);
    setScanCountdown(settings.scanIntervalSeconds || 15);
    appendLog('SYSTEM', 'WARN', 'Trade Master bot PAUSED by user. Automated scanning halted.');
  }, [settings.scanIntervalSeconds, appendLog]);

  const handleToggleBot = useCallback(() => {
    if (botActive) {
      handlePauseBot();
    } else {
      if (!session.active) {
        appendLog(
          'SYSTEM',
          'WARN',
          'Cannot start bot: a verified Binance API session is required. Configure it in Settings.'
        );
        setActiveTab('settings');
        return;
      }
      handleStartBot();
    }
  }, [botActive, handlePauseBot, handleStartBot, session.active, appendLog]);

  const selectedSignal = signals.find((s) => s.symbol === selectedSymbol) || signals[0];
  const activeSymbolForChart = selectedSignal?.symbol || selectedSymbol;
  const selectedCandles = candlesMap[activeSymbolForChart] || [];
  const selectedActivePosition = positions.find((p) => p.symbol === activeSymbolForChart);
  const availableSymbols = signals.map((s) => s.symbol);

  // Nothing on this page is reachable before the operator signs in — every money endpoint behind it
  // answers 401 until then, so rendering the terminal would only show a broken shell.
  if (operator && operator.required && !operator.authenticated) {
    return <OperatorGate configured={operator.configured} onAuthenticated={() => void refreshOperator()} />;
  }

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* 1. Header (Top Bar Contract) */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        botActive={botActive}
        onToggleBot={handleToggleBot}
        openPositionsCount={positions.length}
        maxOpenPositions={settings.maxOpenTrades}
        hasApiKey={session.active}
      />

      {/* 2. Main Terminal Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6">
        {/* KPI telemetry cards belong to the terminal (1st page) only — other tabs are focused views */}
        {activeTab === 'positions' && (
        <KpiMetricsStrip
          totalPnl={totalPnl}
          totalPnlPercent={totalPnlPercent}
          winRate={winRate}
          totalTrades={closedTrades.length}
          winningTrades={winningTrades}
          losingTrades={losingTrades}
          openPositionsCount={positions.length}
          maxOpenPositions={settings.maxOpenTrades}
          compoundingState={compoundingState}
          rateLimitStatus={rateLimitStatus}
          scanCountdown={scanCountdown}
          scanIntervalSeconds={settings.scanIntervalSeconds}
          isScanning={isScanning}
          botActive={botActive}
          binanceAccount={binanceAccount}
        />
        )}

        {/* Tab 1: Active Positions Dashboard, PnL Chart & Selected Symbol Order Flow Chart */}
        {activeTab === 'positions' && (
          <div className="space-y-6">
            <EngineStatusPanel
              state={engineState}
              loading={engineLoading}
              error={engineError}
              onAction={handleEngineAction}
              onRefresh={onRefreshEngine}
              onToggleAutopilot={handleToggleAutopilot}
            />
            {!engineState?.engine?.running && (
              <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-800/70 bg-amber-950/30 text-[11px] text-amber-200">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <strong>No server-side guardian is running.</strong> Stop-loss re-arming, breach checks and
                  the durable ledger only work while this browser tab is open — close the tab and the only
                  protection left is whatever conditional orders are sitting on Binance. Set
                  <code className="mx-1 px-1 rounded bg-slate-900 text-cyan-300">TRADE_ENGINE_ENABLED=true</code>
                  (plus server API keys) to run it on the server.
                </span>
              </div>
            )}
            <PnlChartWidget
              trades={closedTrades}
              totalPnl={totalPnl}
              startingBalance={binanceAccount.startingBalance}
              currentEquity={binanceAccount.currentEquity}
              winRate={winRate}
              compoundingMargin={compoundingState.currentMargin}
              apiSafetyPercent={Math.max(0, 100 - rateLimitStatus.usagePercent)}
            />
            <ActivePositions
              positions={positions}
              onClosePosition={handleClosePosition}
              onSelectSymbol={(sym) => setSelectedSymbol(sym)}
              selectedSymbol={activeSymbolForChart}
              maxOpenPositions={settings.maxOpenTrades}
              leverage={settings.leverage}
              closingPositionId={closingPositionId}
            />
            {selectedCandles.length > 0 && (
              <InteractiveChart
                symbol={activeSymbolForChart}
                candles={selectedCandles}
                signal={selectedSignal}
                activePosition={selectedActivePosition}
                availableSymbols={availableSymbols}
                onSelectSymbol={(sym) => setSelectedSymbol(sym)}
                leverage={settings.leverage}
                scanIntervalSeconds={settings.scanIntervalSeconds}
              />
            )}
          </div>
        )}

        {/* Tab 2: Dedicated Market Scanner Page + Interactive 5m Order Flow Chart */}
        {activeTab === 'scanner' && (
          <div className="space-y-6">
            {session.active && (
              <InteractiveChart
                symbol={activeSymbolForChart}
                candles={selectedCandles}
                signal={selectedSignal}
                activePosition={selectedActivePosition}
                availableSymbols={availableSymbols}
                onSelectSymbol={(sym) => setSelectedSymbol(sym)}
                leverage={settings.leverage}
                scanIntervalSeconds={settings.scanIntervalSeconds}
              />
            )}
            <ScannerTable
              signals={signals}
              selectedSymbol={activeSymbolForChart}
              onSelectSymbol={(sym) => setSelectedSymbol(sym)}
              onManualExecute={handleManualExecute}
              isMaxPositionsReached={positions.length >= settings.maxOpenTrades}
              botActive={botActive}
              scanCountdown={scanCountdown}
              scanIntervalSeconds={settings.scanIntervalSeconds}
              leverage={settings.leverage}
              isScanning={isScanning}
              hasApiKey={session.active}
              onGoToSettings={() => setActiveTab('settings')}
            />
          </div>
        )}

        {/* Tab 3: Trade History & Compounding Pool */}
        {activeTab === 'history' && (
          <TradeHistory trades={closedTrades} compoundingState={compoundingState} />
        )}

        {/* Tab 4: Diagnostics Log */}
        {activeTab === 'logs' && (
          <DiagnosticsLog logs={logs} onClearLogs={() => setLogs([])} />
        )}

        {/* Tab 5: Settings */}
        {activeTab === 'settings' && (
          <SettingsView
            settings={settings}
            onUpdateSettings={(newSet) => {
              applyUpdatedSettings(newSet);
              appendLog(
                'SYSTEM',
                'INFO',
                `Bot settings updated ($${newSet.baseMargin.toFixed(2)} Base Margin · ${newSet.leverage}x Isolated · ${newSet.compoundingPercent}% Compounding).`
              );
              syncBinanceAccount();
            }}
            session={session}
            onConnectCredentials={handleConnectCredentials}
            onDisconnectCredentials={handleDisconnectCredentials}
            onTestConnection={handleTestConnection}
            isTestingConnection={isTestingConnection}
            connectionResult={connectionResult}
            botActive={botActive}
            onStartBot={handleStartBot}
            onPauseBot={handlePauseBot}
            operator={operator ? { required: operator.required, authenticated: operator.authenticated } : null}
            onOperatorSignOut={() => {
              void (async () => {
                await signOutOperator();
                await refreshOperator();
              })();
            }}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-5 px-6 text-center">
        <p className="text-xs text-slate-500 font-mono">
          © 2026 All Rights Reserved. Design &amp; Development by{' '}
          <a
            href="mailto:badalworld@gmail.com"
            className="text-cyan-400 hover:text-cyan-300 underline-offset-2 hover:underline transition-colors"
          >
            Badalworld
          </a>
        </p>
      </footer>

      {/* Full-Screen Trade Result Celebration / Sad Mode Overlay */}
      <TradeResultOverlay
        result={tradeResultModal}
        onClose={() => setTradeResultModal(null)}
      />
    </div>
  );
}
