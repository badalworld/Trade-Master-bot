'use client';

import React, { useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowUpRight,
  ArrowDownRight,
  Zap,
  CheckCircle2,
  Flame,
  ArrowUpDown,
  Clock,
  RefreshCw,
  KeyRound,
  Ban,
} from 'lucide-react';
import type { SignalEvaluation } from '@/lib/trading-engine';
import type { OpportunityBoardSummary, OpportunityScanReport } from '@/lib/market-data';

/** What the scanner needs to know about the opportunity list (a slice of the scan report + entries). */
export type OpportunityListReport = OpportunityScanReport & { cap: number; boardAgeMs: number; durable?: boolean | null };
import { formatCryptoPrice } from '@/lib/utils';

interface ScannerTableProps {
  signals: SignalEvaluation[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  onManualExecute: (signal: SignalEvaluation) => void;
  isMaxPositionsReached: boolean;
  botActive: boolean;
  scanCountdown?: number;
  scanIntervalSeconds?: number;
  leverage?: number;
  isScanning?: boolean;
  hasApiKey?: boolean;
  onGoToSettings?: () => void;
  /** Stage-1 output: what the whole market looked like before the shortlist was chosen. */
  board?: OpportunityBoardSummary | null;
  /** Pairs the funnel refused last cycle, by reason. */
  skipped?: Record<string, number> | null;
  /** Ranked liquid pairs that did not fit the shortlist this cycle. */
  shortlistSkipped?: number | null;
  /**
   * The opportunity list: the pairs the market scan promoted, scanned on their own every cycle. This
   * is the fast path the bot trades from, so the strip says what is on it and what just left it.
   */
  opportunity?: OpportunityListReport | null;
  /** Volatility band in force (floor = chop floor, ceiling = blow-off ceiling). */
  volatilityBand?: { minPercent: number; maxPercent: number } | null;
  /** Chop thresholds in force, shown so the verdicts on screen are self-explaining. */
  chopFilter?: { adxFloor: number; efficiencyFloor: number } | null;
}

export function ScannerTable({
  signals,
  selectedSymbol,
  onSelectSymbol,
  onManualExecute,
  isMaxPositionsReached,
  botActive,
  scanCountdown = 15,
  scanIntervalSeconds = 15,
  leverage = 10,
  isScanning = false,
  hasApiKey = false,
  onGoToSettings,
  board = null,
  skipped = null,
  volatilityBand = null,
  chopFilter = null,
  shortlistSkipped = null,
  opportunity = null,
}: ScannerTableProps) {
  const chopFloorLabel = chopFilter ? chopFilter.adxFloor : 20;
  const chopEfficiencyLabel = chopFilter ? chopFilter.efficiencyFloor : 0.3;
  // Default is now score-first, matching how the engine actually chooses: the best setup inside the
  // volatility band wins, and volatility is the tie-break (it still sorts the list on demand).
  const [sortBy, setSortBy] = useState<'volatility' | 'score' | 'symbol'>('score');

  const sortedSignals = [...signals].sort((a, b) => {
    if (sortBy === 'volatility') {
      return (b.volatilityPercent || 0) - (a.volatilityPercent || 0);
    }
    if (sortBy === 'score') {
      if (b.score !== a.score) return b.score - a.score;
      return (b.volatilityPercent || 0) - (a.volatilityPercent || 0);
    }
    return a.symbol.localeCompare(b.symbol);
  });

  const tradeableCount = signals.filter((s) => s.scan?.tradeable !== false).length;
  const listEntry = (symbol: string) => opportunity?.state.entries.find((e) => e.symbol === symbol) ?? null;
  const promotedSet = new Set((opportunity?.promoted ?? []).map((e) => e.symbol));
  const warnedMap = new Map((opportunity?.warned ?? []).map((w) => [w.symbol, w]));
  const skippedEntries = Object.entries(skipped ?? {});
  const skippedLabel = skippedEntries.map(([reason, count]) => `${count} ${reason}`).join(' · ');

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="neon-section"
    >
      <div className="neon-section-inner overflow-hidden">
        {/* Animated Order Flow Scanning Radar Beam */}
        {isScanning && (
          <motion.div
            initial={{ x: '-100%' }}
            animate={{ x: '100%' }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            className="h-[2px] w-full bg-gradient-to-r from-transparent via-cyan-400 to-transparent shadow-[0_0_10px_#00f0ff]"
          />
        )}

        {/* Header & Controls */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Flame className="w-4 h-4 text-cyan-400" />
              Binance 5m Volatility Scanner
            </h2>
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-slate-400">
                {board && board.source === 'binance'
                  ? `${board.liquidCount} liquid / ${board.universeSize} perps → ${signals.length} scanned`
                  : `${signals.length} pairs`}
              </span>
              <span className="text-slate-600">·</span>
              <span className="text-slate-400">{tradeableCount} tradeable</span>
              <span className="text-slate-600">·</span>
              {/* Live Time Countdown in Scan Header */}
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-cyan-300">
                {isScanning ? (
                  <>
                    <RefreshCw className="w-3 h-3 text-cyan-400 animate-spin" />
                    <span>Scanning market...</span>
                  </>
                ) : botActive ? (
                  <>
                    <Clock className="w-3 h-3 text-cyan-400" />
                    <span>
                      Countdown: 00:{scanCountdown.toString().padStart(2, '0')} ({scanCountdown}s)
                    </span>
                  </>
                ) : (
                  <>
                    <Clock className="w-3 h-3 text-slate-500" />
                    <span className="text-slate-400">Scan Ready ({scanIntervalSeconds}s)</span>
                  </>
                )}
              </span>
            </div>
          </div>

          {/* Sort Controls */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-400 flex items-center gap-1 font-medium">
              <ArrowUpDown className="w-3.5 h-3.5 text-slate-500" />
              Sort:
            </span>
            <button
              onClick={() => setSortBy('volatility')}
              className={`interactive-glow-btn px-2.5 py-1 rounded font-medium transition-colors flex items-center gap-1 ${
                sortBy === 'volatility'
                  ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-800/80 font-bold shadow-[0_0_8px_rgba(0,240,255,0.3)]'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Flame className="w-3 h-3 text-cyan-400" />
              High Volatility
            </button>

            <button
              onClick={() => setSortBy('score')}
              className={`interactive-glow-btn px-2.5 py-1 rounded font-medium transition-colors ${
                sortBy === 'score'
                  ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-800/80 font-bold shadow-[0_0_8px_rgba(0,240,255,0.3)]'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              Signal Score
            </button>
          </div>
        </div>

        {/* Stage 1 at a glance: how much of the market was ranked, and the most volatile names on it */}
        {(board || skippedEntries.length > 0 || volatilityBand) && (
          <div className="px-5 py-2 border-b border-slate-800/70 bg-slate-950/40 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono">
            {board && (
              <span className="text-slate-400">
                <span className="text-cyan-300 font-semibold">Opportunity board</span>{' '}
                {board.source === 'binance'
                  ? `top ${board.candidates.length} of ${board.liquidCount} liquid perps (≥$${(board.minQuoteVolumeUsdt / 1_000_000).toFixed(0)}M/24h), most volatile first`
                  : `built-in majors (market ranking unavailable${board.error ? `: ${board.error}` : ''})`}
              </span>
            )}
            {board && board.candidates.length > 0 && (
              <span className="text-slate-500">
                hottest:{' '}
                {board.candidates.slice(0, 5).map((c, i) => (
                  <span key={c.symbol}>
                    {i > 0 && ' · '}
                    <span className="text-amber-300">{c.symbol}</span>
                    <span className="text-slate-600"> {c.amplitudePercent.toFixed(1)}%</span>
                  </span>
                ))}
              </span>
            )}
            {volatilityBand && (
              <span className="text-slate-500">
                band: <span className="text-slate-300">{volatilityBand.minPercent}%–{volatilityBand.maxPercent}%</span> · chop filter:{' '}
                <span className="text-slate-300">ADX&lt;{chopFloorLabel} &amp; ER&lt;{chopEfficiencyLabel}</span>
              </span>
            )}
            {skippedEntries.length > 0 && (
              <span className="text-rose-300/90">refused: {skippedLabel}</span>
            )}
            {typeof shortlistSkipped === 'number' && shortlistSkipped > 0 && (
              <span className="text-slate-500">
                {shortlistSkipped} more ranked pair{shortlistSkipped === 1 ? '' : 's'} not scanned this cycle
              </span>
            )}
          </div>
        )}

        {/* The opportunity list: what the market scan promoted, and what it took back */}
        {opportunity && (
          <div className="px-5 py-2 border-b border-slate-800/70 bg-slate-950/60 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono">
            <span className="text-slate-300">
              <span className="text-cyan-300 font-semibold">Opportunity list</span>{' '}
              {opportunity.state.entries.length}/{opportunity.cap} pair{opportunity.state.entries.length === 1 ? '' : 's'} · scanned every cycle
            </span>
            <span className="text-slate-500">market ranking {Math.round(opportunity.boardAgeMs / 1000)}s old</span>
            {opportunity.held.length > 0 && (
              <span className="text-slate-500">{opportunity.held.length} held by open positions</span>
            )}
            {opportunity.promoted.length > 0 && (
              <span className="text-emerald-300">
                + {opportunity.promoted.map((e) => `${e.symbol} (rank ${e.boardRank})`).join(', ')}
              </span>
            )}
            {opportunity.removed.length > 0 && (
              <span className="text-rose-300/90">
                − {opportunity.removed.map((r) => `${r.symbol} (${r.reason})`).join(', ')} removed
              </span>
            )}
            {opportunity.warned.length > 0 && (
              <span className="text-amber-300/90">
                {opportunity.warned.map((w) => `${w.symbol} strike ${w.strikes}`).join(', ')}
              </span>
            )}
            {opportunity.durable === false && (
              <span className="text-amber-300/90">not persisted — a restart re-discovers the market</span>
            )}
          </div>
        )}

        {/* Empty State when no API credentials are provided */}
        {!hasApiKey ? (
          <div className="p-12 text-center flex flex-col items-center justify-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-cyan-950/60 border border-cyan-800/60 flex items-center justify-center text-cyan-400">
              <KeyRound className="w-6 h-6" />
            </div>
            <h3 className="text-base font-bold text-slate-100">Binance API Key Required</h3>
            <p className="text-xs text-slate-400 max-w-md font-sans">
              To guarantee 100% real live execution with zero paper trading, please add your Binance Futures API Key & Secret in Settings. The scanner and automated bot will start scanning directly from your authenticated Binance account.
            </p>
            {onGoToSettings && (
              <button
                type="button"
                onClick={onGoToSettings}
                className="interactive-glow-btn mt-2 px-5 py-2.5 bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-bold text-xs rounded-lg transition-all shadow-[0_0_16px_rgba(0,240,255,0.4)]"
              >
                Go to Settings & Add API Key
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/60 text-slate-400 border-b border-slate-800 font-medium">
                <tr>
                  <th className="py-2.5 px-4">Futures Pair</th>
                  <th className="py-2.5 px-3">5m Price</th>
                  <th className="py-2.5 px-3">Volatility %</th>
                  <th className="py-2.5 px-3">Trend / Chop</th>
                  <th className="py-2.5 px-3">Vol Rank</th>
                  <th className="py-2.5 px-3">Regime</th>
                  <th className="py-2.5 px-3">HVN Profile (POC)</th>
                  <th className="py-2.5 px-3">Heavy Absorption</th>
                  <th className="py-2.5 px-3">Imbalance 3:1</th>
                  <th className="py-2.5 px-3">Signal & Score</th>
                  <th className="py-2.5 px-3">Indicator TP / SL</th>
                  <th className="py-2.5 px-3 text-right">Bot Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {sortedSignals.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="py-10 text-center text-slate-500 font-sans">
                      {isScanning
                        ? 'Connecting to Binance Futures API...'
                        : skippedEntries.length > 0
                        ? `No pair passed the entry rules this cycle — ${skippedLabel}.`
                        : 'No active scan signals yet. Click "Start Bot" in Settings to begin scanning.'}
                    </td>
                  </tr>
                ) : (
                  sortedSignals.map((sig) => {
                    const isSelected = sig.symbol === selectedSymbol;
                    const isBull = sig.action === 'LONG';
                    const isBear = sig.action === 'SHORT';
                    const isHighVol = (sig.volatilityPercent || 0) >= 1.5;
                    const blocked = sig.scan?.tradeable === false;

                    return (
                      <tr
                        key={sig.symbol}
                        onClick={() => onSelectSymbol(sig.symbol)}
                        className={`transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-cyan-950/30 border-l-2 border-l-cyan-400'
                            : 'hover:bg-slate-800/40'
                        }`}
                      >
                        {/* Symbol */}
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-200">{sig.symbol}</span>
                            {(() => {
                              const entry = listEntry(sig.symbol);
                              if (!entry) return null;
                              const warned = warnedMap.get(sig.symbol);
                              return (
                                <span
                                  className="text-[10px] text-slate-400 bg-slate-900 px-1 py-0.2 rounded border border-slate-700/70 font-sans"
                                  title={`On the opportunity list since ${new Date(entry.addedAt).toLocaleTimeString()} · ranked #${entry.boardRank} on the market board (1 = most volatile)`}
                                >
                                  LIST #{entry.boardRank}
                                </span>
                              );
                            })()}
                            {promotedSet.has(sig.symbol) && (
                              <span className="text-[10px] text-emerald-300 bg-emerald-950/70 px-1 py-0.2 rounded border border-emerald-800/60 font-sans font-bold">
                                NEW
                              </span>
                            )}
                            {warnedMap.has(sig.symbol) && (
                              <span
                                className="text-[10px] text-amber-300 bg-amber-950/70 px-1 py-0.2 rounded border border-amber-800/60 font-sans font-bold"
                                title={`Strike ${warnedMap.get(sig.symbol)?.strikes}: this pass failed (${warnedMap.get(sig.symbol)?.reason}). At the limit it leaves the opportunity list.`}
                              >
                                STRIKE {warnedMap.get(sig.symbol)?.strikes}
                              </span>
                            )}
                            {isHighVol && (
                              <span className="text-[10px] text-amber-300 bg-amber-950/70 px-1 py-0.2 rounded border border-amber-800/60 flex items-center gap-0.5 font-sans font-bold">
                                <Flame className="w-2.5 h-2.5 text-amber-400" />
                                FAST
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 font-sans mt-0.5">
                            USDT-M Perpetual
                          </div>
                        </td>

                        {/* Price */}
                        <td className="py-3 px-3 tabular-nums font-medium text-slate-200">
                          ${formatCryptoPrice(sig.currentPrice)}
                        </td>

                        {/* Volatility: the band metric, measured on settled candles only */}
                        <td className="py-3 px-3 tabular-nums font-semibold">
                          <div
                            className={`flex items-center gap-1 ${
                              sig.scan?.volatilityLevel === 'LOW'
                                ? 'text-slate-400'
                                : sig.scan?.volatilityLevel === 'HIGH'
                                ? 'text-rose-400'
                                : 'text-amber-400'
                            }`}
                          >
                            <span>{(sig.volatilityPercent || 0).toFixed(2)}%</span>
                            <span className="text-[10px] text-slate-500 font-sans">
                              {sig.scan?.volatilityLevel === 'LOW'
                                ? 'quiet'
                                : sig.scan?.volatilityLevel === 'HIGH'
                                ? 'violent'
                                : 'band'}
                            </span>
                          </div>
                          <div className="w-16 h-1 bg-slate-800 rounded-full mt-1.5 overflow-hidden">
                            <div
                              className={`h-full ${
                                sig.scan?.volatilityLevel === 'HIGH' ? 'bg-rose-400' : 'bg-amber-400'
                              }`}
                              style={{ width: `${Math.min(100, (sig.volatilityPercent || 0) * 25)}%` }}
                            />
                          </div>
                        </td>

                        {/* Trend vs chop: ADX and Kaufman efficiency ratio, on settled candles */}
                        <td className="py-3 px-3 tabular-nums">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={
                                sig.regime?.trendStrength === 'TRENDING'
                                  ? 'text-emerald-400'
                                  : sig.regime?.trendStrength === 'CHOPPY'
                                  ? 'text-rose-400'
                                  : 'text-amber-300'
                              }
                            >
                              {Number.isFinite(sig.regime?.adx) ? sig.regime.adx.toFixed(0) : '—'}
                            </span>
                            <span className="text-[10px] text-slate-500 font-sans">ADX</span>
                            <span className="text-slate-600">/</span>
                            <span className="text-slate-300">
                              {Number.isFinite(sig.regime?.efficiencyRatio) ? sig.regime.efficiencyRatio.toFixed(2) : '—'}
                            </span>
                            <span className="text-[10px] text-slate-500 font-sans">ER</span>
                          </div>
                          <div className="text-[10px] text-slate-500 font-sans mt-0.5">{sig.regime?.trendStrength ?? '—'}</div>
                        </td>

                        {/* Percentile of volatility within this scan: the "most → least volatile" rank */}
                        <td className="py-3 px-3 tabular-nums">
                          <div className="flex items-center gap-1.5">
                            <span className="text-cyan-300 font-semibold">
                              {sig.scan ? sig.scan.volatilityRank : '—'}
                            </span>
                            <span className="text-[10px] text-slate-500 font-sans">pct</span>
                          </div>
                          <div className="w-12 h-1 bg-slate-800 rounded-full mt-1.5 overflow-hidden">
                            <div
                              className="h-full bg-cyan-400"
                              style={{ width: `${sig.scan ? sig.scan.volatilityRank : 0}%` }}
                            />
                          </div>
                        </td>

                        {/* Regime verdict — why the engine would or would not take this pair */}
                        <td className="py-3 px-3">
                          {sig.scan?.tradeable === false ? (
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-sans font-semibold text-rose-300 bg-rose-950/60 border border-rose-800/50"
                              title={sig.scan.skipDetail}
                            >
                              <Ban className="w-3 h-3" />
                              {sig.scan.skipReason === 'choppy'
                                ? 'CHOPPY'
                                : sig.scan.skipReason === 'vol-above-ceiling'
                                ? 'TOO VIOLENT'
                                : sig.scan.skipReason === 'vol-below-floor'
                                ? 'TOO QUIET'
                                : 'NO DATA'}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-sans font-semibold text-emerald-300 bg-emerald-950/50 border border-emerald-800/40">
                              <CheckCircle2 className="w-3 h-3" />
                              TRADEABLE
                            </span>
                          )}
                          {sig.scan?.skipDetail && (
                            <div className="text-[10px] text-slate-500 font-sans mt-1 max-w-[150px] truncate" title={sig.scan.skipDetail}>
                              {sig.scan.skipDetail}
                            </div>
                          )}
                        </td>

                        {/* Indicator 1: HVN Profile & POC */}
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${
                                sig.hvnProfile.priceRelation === 'ABOVE_POC'
                                  ? 'text-emerald-400 bg-emerald-950/60'
                                  : sig.hvnProfile.priceRelation === 'BELOW_POC'
                                  ? 'text-rose-400 bg-rose-950/60'
                                  : 'text-amber-300 bg-amber-950/60'
                              }`}
                            >
                              {sig.hvnProfile.priceRelation.replace('_', ' ')}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                            POC: ${formatCryptoPrice(sig.hvnProfile.pocPrice)}
                          </div>
                        </td>

                        {/* Indicator 2: Heavy Absorption */}
                        <td className="py-3 px-3">
                          <div>
                            {Boolean(
                              sig.absorption?.isHeavyAbsorption ??
                                sig.absorption?.isAbsorptionDetected
                            ) ? (
                              <span
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold ${
                                  sig.absorption?.absorptionType === 'BULLISH' ||
                                  sig.absorption?.type === 'BULLISH_ABSORPTION'
                                    ? 'text-emerald-400 bg-emerald-950/60 border border-emerald-800/40'
                                    : 'text-rose-400 bg-rose-950/60 border border-rose-800/40'
                                }`}
                              >
                                {sig.absorption?.absorptionType === 'BULLISH' ||
                                sig.absorption?.type === 'BULLISH_ABSORPTION'
                                  ? 'Bull'
                                  : 'Bear'}{' '}
                                {sig.absorption?.ratio ?? sig.absorption?.absorptionScore ?? 0}%
                              </span>
                            ) : (
                              <span className="text-slate-400 text-[11px] font-sans">
                                Normal Flow
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                            Delta: {(sig.absorption?.deltaVolume ?? 0) > 0 ? '+' : ''}
                            {(sig.absorption?.deltaVolume ?? 0).toFixed(0)}
                          </div>
                        </td>

                        {/* Indicator 3: Stacked Imbalance 3:1 */}
                        <td className="py-3 px-3">
                          <div>
                            {Boolean(
                              sig.imbalance?.hasStackedImbalance ??
                                sig.imbalance?.isImbalanceDetected
                            ) ? (
                              <span
                                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-bold ${
                                  sig.imbalance?.imbalanceSide === 'BUY' ||
                                  sig.imbalance?.type === 'BUY_IMBALANCE'
                                    ? 'text-emerald-400 bg-emerald-950/60'
                                    : 'text-rose-400 bg-rose-950/60'
                                }`}
                              >
                                {sig.imbalance?.maxImbalanceRatio ?? 1}x Stacked 3:1
                              </span>
                            ) : (
                              <span className="text-slate-500 text-[11px] font-sans">Balanced</span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                            Levels: {sig.imbalance?.stackedImbalanceCount ?? 0}
                          </div>
                        </td>

                        {/* Signal & Score */}
                        <td className="py-3 px-3" title={sig.reasons.join(' • ')}>
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-bold ${
                                isBull
                                  ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/60'
                                  : isBear
                                  ? 'bg-rose-950/80 text-rose-300 border border-rose-700/60'
                                  : 'bg-slate-800 text-slate-400 border border-slate-700'
                              }`}
                            >
                              {isBull ? (
                                <ArrowUpRight className="w-3 h-3" />
                              ) : isBear ? (
                                <ArrowDownRight className="w-3 h-3" />
                              ) : null}
                              {sig.signal}
                            </span>
                            <span className="text-xs font-semibold tabular-nums text-slate-300">
                              {sig.score}%
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-500 font-sans truncate max-w-[160px] mt-0.5">
                            {sig.reasons[0] || 'Flow consolidation'}
                          </div>
                        </td>

                        {/* Dynamic TP & SL */}
                        <td className="py-3 px-3 tabular-nums">
                          <div className="text-emerald-400">
                            TP: ${formatCryptoPrice(sig.tpPrice)}
                          </div>
                          <div className="text-rose-400 text-[11px]">
                            SL: ${formatCryptoPrice(sig.slPrice)}
                          </div>
                        </td>

                        {/* Bot Execution Action */}
                        <td className="py-3 px-3 text-right">
                          {botActive && (isBull || isBear) && !blocked ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-sans text-emerald-400 bg-emerald-950/50 px-2 py-1 rounded border border-emerald-800/40">
                              <CheckCircle2 className="w-3 h-3" />
                              Auto-Ready
                            </span>
                          ) : (
                            <button
                              disabled={isMaxPositionsReached || blocked || (!isBull && !isBear)}
                              onClick={(e) => {
                                e.stopPropagation();
                                onManualExecute(sig);
                              }}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-sans font-medium rounded transition-colors ${
                                isMaxPositionsReached || blocked || (!isBull && !isBear)
                                  ? 'bg-slate-800/50 text-slate-600 cursor-not-allowed border border-slate-800'
                                  : isBull
                                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                                  : 'bg-rose-600 hover:bg-rose-500 text-white'
                              }`}
                              title={
                                blocked
                                  ? `Refused by the regime gate: ${sig.scan?.skipDetail ?? sig.scan?.skipReason}`
                                  : isMaxPositionsReached
                                  ? 'Maximum open positions reached'
                                  : `Execute trade with ${leverage}x isolated leverage`
                              }
                            >
                              <Zap className="w-3 h-3" />
                              {isBull ? 'Long' : isBear ? 'Short' : 'Neutral'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </motion.div>
  );
}
