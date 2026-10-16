'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  Activity,
  AlertTriangle,
  Octagon,
  Play,
  RefreshCw,
  Server,
  Shield,
  ShieldAlert,
  Square,
} from 'lucide-react';

export interface EngineLedgerPosition {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  markPrice: number;
  margin: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  entryTime: number;
  foreign: boolean;
  unprotectedCycles: number;
}

export interface EngineStatusPayload {
  success: boolean;
  timestamp: number;
  engine: {
    running: boolean;
    config: {
      /** TRADE_ENGINE_ENABLED — without it the loop cannot run at all, so both controls are inert. */
      enabled: boolean;
      autoEntry: boolean;
      enforceBrackets: boolean;
      intervalMs: number;
      unprotectedTolerance: number;
      leverage: number;
      baseMargin: number;
      compoundingPercent: number;
    };
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
     * Classified diagnosis of `lastError`. Rendered instead of the bare message: "the API key is
     * wrong" and "this app sent a malformed request" need completely different reactions from the
     * operator, and the raw string cannot tell them apart.
     */
    lastFailure: {
      code: string;
      title: string;
      action: string;
      retryable: boolean;
      at: number;
      /** How many consecutive cycles have failed this same way. */
      repeats: number;
      raw: string;
    } | null;
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
      board: { source: 'binance' | 'fallback'; universeSize: number; liquidCount: number } | null;
      skipped: Record<string, number>;
      selected: string | null;
    } | null;
    events: Array<{ at: number; level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS'; kind: string; message: string }>;
    ledgerDurable: boolean;
  };
  policy: {
    maxLeverage: number;
    maxMarginUsdt: number;
    maxNotionalUsdt: number;
    maxOpenPositions: number;
    maxDailyLossUsdt: number;
    halted: boolean;
    mainnetAllowed: boolean;
  };
  ledger: {
    network: 'testnet' | 'mainnet' | null;
    updatedAt: number;
    openPositions: EngineLedgerPosition[];
    closedTrades: unknown[];
    totals: { closed: number; realizedPnl: number; wins: number };
    compounding: { baseMargin: number; currentMargin: number; consecutiveWins: number; totalCompoundedProfitPool: number };
    realizedPnlTodayUsdt: number;
  };
}

interface Props {
  state: EngineStatusPayload | null;
  loading: boolean;
  error: string | null;
  onAction: (action: 'start' | 'stop' | 'halt-entries' | 'resume-entries' | 'flatten-all') => Promise<string | null>;
  /** Turns server-side entry automation on/off; returns an error string when it was refused. */
  onToggleAutopilot: (enabled: boolean, confirm?: string) => Promise<string | null>;
  onRefresh: () => void;
}

const fmtAgo = (ts: number | null, now: number): string => {
  if (!ts || !now) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

export function EngineStatusPanel({ state, loading, error, onAction, onToggleAutopilot, onRefresh }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  // Clock kept in state so rendering stays pure (no Date.now() during render).
  const [now, setNow] = useState<number>(0);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmFlatten, setConfirmFlatten] = useState<boolean>(false);
  const [confirmAutopilot, setConfirmAutopilot] = useState<boolean>(false);
  const [togglingAutopilot, setTogglingAutopilot] = useState<boolean>(false);

  const toggleAutopilot = async (enabled: boolean) => {
    setTogglingAutopilot(true);
    setActionError(null);
    const needsConfirm = enabled && state?.engine.network === 'mainnet';
    const message = await onToggleAutopilot(enabled, needsConfirm ? 'ENABLE_AUTOPILOT' : undefined);
    setTogglingAutopilot(false);
    setConfirmAutopilot(false);
    if (message) setActionError(message);
  };

  // Until the ticker fires, age against the server's own read timestamp.
  const nowMs = now || (state?.timestamp ?? 0);

  const run = async (action: 'start' | 'stop' | 'halt-entries' | 'resume-entries' | 'flatten-all') => {
    setBusy(action);
    setActionError(null);
    const message = await onAction(action);
    setBusy(null);
    if (message) setActionError(message);
    setConfirmFlatten(false);
  };

  const e = state?.engine;
  const running = Boolean(e?.running);
  // Read from `config`: `engine.enabled` never existed in the payload, so the Start and Autopilot
  // controls used to be disabled permanently even on a deployment that had enabled the loop.
  const engineEnabled = Boolean(e?.config.enabled);
  const guardianOnly = running && !e?.config.autoEntry;
  const owned = state?.ledger.openPositions.filter((p) => !p.foreign) ?? [];
  const foreign = state?.ledger.openPositions.filter((p) => p.foreign) ?? [];
  const unprotected = owned.filter((p) => p.stopLoss <= 0 || p.unprotectedCycles > 0);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="neon-section">
      <div className="neon-section-inner p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-cyan-400" />
            <h4 className="text-sm font-semibold text-slate-100">Server-side engine</h4>
            <span
              className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                running
                  ? guardianOnly
                    ? 'text-cyan-300 border-cyan-800 bg-cyan-950/50'
                    : 'text-emerald-300 border-emerald-800 bg-emerald-950/50'
                  : 'text-slate-400 border-slate-700 bg-slate-900'
              }`}
            >
              {running ? (guardianOnly ? 'GUARDIAN ONLY — protects, never opens' : 'GUARDIAN + AUTO-ENTRY') : 'NOT RUNNING'}
            </span>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="text-[11px] font-mono text-slate-400 hover:text-slate-200 flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            refresh
          </button>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-slate-200">
                Autopilot — no manual step in the loop
              </p>
              <p className="text-[10.5px] text-slate-500 font-mono mt-0.5">
                1. paste Binance API key → 2. press Start → 3. nothing else. Scan, entry sizing,
                leverage, TP + SL brackets, close on breach, compounding and the ledger all run by
                themselves; every order still passes the server-side risk policy.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                const next = !Boolean(e?.config.autoEntry);
                if (next && e?.network === 'mainnet' && !confirmAutopilot) {
                  setConfirmAutopilot(true);
                  return;
                }
                void toggleAutopilot(next);
              }}
              disabled={togglingAutopilot || !engineEnabled}
              title={
                engineEnabled
                  ? 'When on, the server loop opens positions too, without a browser tab. When off it only protects and settles.'
                  : 'Set TRADE_ENGINE_ENABLED=true on the server to use the unattended loop'
              }
              className={`relative shrink-0 px-3 py-1.5 text-[11px] font-semibold rounded-md border transition-colors flex items-center gap-2 ${
                e?.config.autoEntry
                  ? 'bg-emerald-500/15 border-emerald-500/60 text-emerald-300 hover:bg-emerald-500/25'
                  : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
              } disabled:opacity-40`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${e?.config.autoEntry ? 'bg-emerald-400' : 'bg-slate-500'}`}
              />
              {togglingAutopilot
                ? 'Applying…'
                : confirmAutopilot
                  ? 'Click again to confirm MAINNET entries'
                  : e?.config.autoEntry
                    ? 'Trading automatically'
                    : 'Guardian only — enable full autopilot'}
            </button>
          </div>
        </div>

        {!e ? (
          <p className="text-xs text-slate-400">
            {error ? `Could not read engine state: ${error}` : 'Loading engine state…'}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px] font-mono">
              {[
                { label: 'Network', value: e.network, tone: e.network === 'mainnet' ? 'text-rose-300' : 'text-amber-300' },
                { label: 'Credentials', value: e.credentialSource === 'env' ? 'server env' : 'none (env required)', tone: e.credentialSource === 'env' ? 'text-emerald-300' : 'text-rose-300' },
                { label: 'Cycles', value: `${e.cycles} · last ${fmtAgo(e.lastCycleAt, nowMs)}`, tone: 'text-slate-200' },
                { label: 'Interval', value: `${Math.round(e.config.intervalMs / 1000)}s`, tone: 'text-slate-200' },
                { label: 'Ledger persistence', value: e.ledgerDurable ? 'durable (TRADE_DATA_DIR)' : 'in-process only', tone: e.ledgerDurable ? 'text-emerald-300' : 'text-amber-300' },
                { label: 'Owned positions', value: `${owned.length} / ${state?.policy.maxOpenPositions ?? '?'}`, tone: 'text-slate-200' },
                { label: 'Realized today', value: `$${e.realizedPnlTodayUsdt.toFixed(2)}`, tone: e.realizedPnlTodayUsdt < 0 ? 'text-rose-300' : 'text-emerald-300' },
                {
                  label: 'Next cycle',
                  value: e.nextCycleAt && now ? `${Math.max(0, Math.round((e.nextCycleAt - nowMs) / 1000))}s` : '—',
                  tone: 'text-slate-200',
                },
              ].map((row) => (
                <div key={row.label} className="bg-slate-950/70 border border-slate-800 rounded-md px-2.5 py-2">
                  <span className="block text-slate-500 text-[10px]">{row.label}</span>
                  <span className={row.tone}>{row.value}</span>
                </div>
              ))}
            </div>

            {e.lastScan && (
              <div className="p-3 rounded-md border border-slate-800 bg-slate-950/50 text-[11px] font-mono text-slate-400 space-y-1">
                <div>
                  <span className="text-cyan-300 font-semibold">Last scan</span> · {fmtAgo(e.lastScan.at, nowMs)} ·{' '}
                  {e.lastScan.board?.source === 'binance'
                    ? `ranked ${e.lastScan.board.liquidCount} liquid of ${e.lastScan.board.universeSize} perps`
                    : 'market ranking unavailable — built-in majors used'}
                  {' → '}
                  <span className="text-slate-200">{e.lastScan.signals} deep-scanned</span>
                  {e.lastScan.failures > 0 ? ` · ${e.lastScan.failures} with no candles` : ''}
                </div>
                <div>
                  {e.lastScan.selected ? (
                    <span className="text-emerald-300">Selected {e.lastScan.selected} (best score inside the band)</span>
                  ) : (
                    <span className="text-slate-500">No pair met the entry rules this cycle</span>
                  )}
                  {Object.keys(e.lastScan.skipped ?? {}).length > 0 &&
                    ` · refused: ${Object.entries(e.lastScan.skipped)
                      .map(([reason, count]) => `${count} ${reason}`)
                      .join(', ')}`}
                </div>
              </div>
            )}

            {unprotected.length > 0 && (
              <div className="flex items-start gap-2 p-3 rounded-md border border-rose-800 bg-rose-950/40 text-[11px] text-rose-200">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <strong>{unprotected.length}</strong> owned position(s) without a confirmed stop on the exchange:{' '}
                  {unprotected.map((p) => p.symbol).join(', ')}. The engine re-arms each cycle and flattens after{' '}
                  {e.config.unprotectedTolerance + 1} failed cycles.
                </span>
              </div>
            )}

            {foreign.length > 0 && (
              <div className="flex items-start gap-2 p-3 rounded-md border border-amber-800/70 bg-amber-950/30 text-[11px] text-amber-200">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  Opened outside this app, reported only (the engine will not manage or close them):{' '}
                  {foreign.map((p) => `${p.symbol} ${p.side}`).join(', ')}
                </span>
              </div>
            )}

            {e.lastFailure ? (
              <div className="p-3 rounded-md border border-rose-900 bg-rose-950/30 text-[11px] text-rose-200 space-y-1.5">
                <div className="flex items-start gap-2">
                  <Octagon className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                  <span>
                    <strong className="text-rose-100">{e.lastFailure.title}</strong>{' '}
                    <span className="font-mono text-rose-300/70">
                      [{e.lastFailure.code}
                      {e.lastFailure.repeats > 1 ? ` · ${e.lastFailure.repeats} cycles in a row` : ''}]
                    </span>
                  </span>
                </div>
                <p className="text-rose-200/90">{e.lastFailure.action}</p>
                <p className="text-rose-300/80">
                  {e.lastFailure.retryable
                    ? 'Transient — the loop keeps retrying on its own.'
                    : 'Retrying will not change this; it needs a fix on the exchange or in the configuration.'}
                  {e.cooldownUntil && e.cooldownUntil > nowMs
                    ? ` Next attempt in ${Math.max(1, Math.round((e.cooldownUntil - nowMs) / 1000))}s.`
                    : ''}
                </p>
                <p className="font-mono text-rose-300/60 break-words">
                  first seen {fmtAgo(e.lastFailure.at, nowMs)} · Binance said: {e.lastFailure.raw}
                </p>
              </div>
            ) : (
              e.lastError && (
                <div className="p-3 rounded-md border border-rose-900 bg-rose-950/30 text-[11px] font-mono text-rose-300">
                  last error · {fmtAgo(e.lastErrorAt, nowMs)} — {e.lastError}
                </div>
              )
            )}

            {e.events.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-md border border-slate-800 bg-slate-950/60">
                {e.events.slice(0, 12).map((ev, i) => (
                  <div key={`${ev.at}-${i}`} className="px-3 py-1.5 text-[11px] font-mono border-b border-slate-900 last:border-0 flex gap-2">
                    <span className="text-slate-600 shrink-0">{new Date(ev.at).toLocaleTimeString()}</span>
                    <span
                      className={`shrink-0 font-bold ${
                        ev.level === 'ERROR'
                          ? 'text-rose-400'
                          : ev.level === 'WARN'
                            ? 'text-amber-400'
                            : ev.level === 'SUCCESS'
                              ? 'text-emerald-400'
                              : 'text-cyan-400'
                      }`}
                    >
                      {ev.kind}
                    </span>
                    <span className="text-slate-300 break-all">{ev.message}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800">
              {!running ? (
                <button
                  type="button"
                  onClick={() => void run('start')}
                  disabled={busy !== null || !engineEnabled}
                  title={engineEnabled ? 'Start the server-side guardian loop' : 'Set TRADE_ENGINE_ENABLED=true on the server first'}
                  className="mt-3 px-3 py-1.5 text-[11px] font-semibold rounded bg-cyan-400 text-slate-950 hover:bg-cyan-300 disabled:opacity-40 flex items-center gap-1.5"
                >
                  <Play className="w-3 h-3" />
                  {busy === 'start' ? 'Starting…' : 'Start guardian'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void run('stop')}
                  disabled={busy !== null}
                  className="mt-3 px-3 py-1.5 text-[11px] font-semibold rounded bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700 flex items-center gap-1.5"
                >
                  <Square className="w-3 h-3" />
                  {busy === 'stop' ? 'Stopping…' : 'Stop engine'}
                </button>
              )}

              {running && (
                <button
                  type="button"
                  onClick={() => void run(e.entriesHalted ? 'resume-entries' : 'halt-entries')}
                  disabled={busy !== null}
                  className="mt-3 px-3 py-1.5 text-[11px] rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 flex items-center gap-1.5"
                >
                  <Octagon className="w-3 h-3" />
                  {e.entriesHalted ? 'Resume entries' : 'Halt entries'}
                </button>
              )}

              {running && owned.length > 0 && (
                <button
                  type="button"
                  onClick={() => (confirmFlatten ? void run('flatten-all') : setConfirmFlatten(true))}
                  disabled={busy !== null}
                  className={`mt-3 px-3 py-1.5 text-[11px] rounded border flex items-center gap-1.5 ${
                    confirmFlatten
                      ? 'bg-rose-600 border-rose-500 text-white'
                      : 'bg-slate-900 border-rose-900 text-rose-300 hover:bg-rose-950/60'
                  }`}
                >
                  <Shield className="w-3 h-3" />
                  {confirmFlatten ? `Confirm: close ${owned.length} owned position(s)` : 'Flatten owned positions'}
                </button>
              )}

              <span className="mt-3 ml-auto text-[10px] font-mono text-slate-500 flex items-center gap-1">
                <Activity className="w-3 h-3" />
                {e.config.enforceBrackets ? 'bracket enforcement on' : 'bracket enforcement OFF'} · entry margin $
                {state?.ledger.compounding.currentMargin.toFixed(2) ?? '0.00'}
              </span>
            </div>

            {actionError && (
              <p className="text-[11px] text-rose-300 font-mono flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {actionError}
              </p>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
