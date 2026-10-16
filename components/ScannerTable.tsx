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
} from 'lucide-react';
import type { SignalEvaluation } from '@/lib/trading-engine';
import { formatCryptoPrice } from '@/lib/utils';

interface ScannerTableProps {
  signals: SignalEvaluation[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  onManualExecute: (signal: SignalEvaluation) => void;
  isMaxPositionsReached: boolean;
  botActive: boolean;
  scanCountdown?: number;
  isScanning?: boolean;
  hasApiKey?: boolean;
  onGoToSettings?: () => void;
}

export function ScannerTable({
  signals,
  selectedSymbol,
  onSelectSymbol,
  onManualExecute,
  isMaxPositionsReached,
  botActive,
  scanCountdown = 15,
  isScanning = false,
  hasApiKey = false,
  onGoToSettings,
}: ScannerTableProps) {
  const [sortBy, setSortBy] = useState<'volatility' | 'score' | 'symbol'>('volatility');

  const sortedSignals = [...signals].sort((a, b) => {
    if (sortBy === 'volatility') {
      return (b.volatilityPercent || 0) - (a.volatilityPercent || 0);
    }
    if (sortBy === 'score') {
      return b.score - a.score;
    }
    return a.symbol.localeCompare(b.symbol);
  });

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
              Binance 5m High-Volatility Scanner
            </h2>
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-slate-400">{signals.length} pairs</span>
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
                    <span className="text-slate-400">Scan Ready (15s)</span>
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
              className={`px-2.5 py-1 rounded font-medium transition-colors flex items-center gap-1 ${
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
              className={`px-2.5 py-1 rounded font-medium transition-colors ${
                sortBy === 'score'
                  ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-800/80 font-bold shadow-[0_0_8px_rgba(0,240,255,0.3)]'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              Signal Score
            </button>
          </div>
        </div>

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
                className="mt-2 px-5 py-2.5 bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-bold text-xs rounded-lg transition-all shadow-[0_0_16px_rgba(0,240,255,0.4)]"
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
                  <th className="py-2.5 px-3">HVN Profile (POC)</th>
                  <th className="py-2.5 px-3">Heavy Absorption</th>
                  <th className="py-2.5 px-3">Imbalance 3:1</th>
                  <th className="py-2.5 px-3">Signal & Score</th>
                  <th className="py-2.5 px-3">Dynamic TP / SL</th>
                  <th className="py-2.5 px-3 text-right">Bot Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {sortedSignals.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-10 text-center text-slate-500 font-sans">
                      {isScanning
                        ? 'Connecting to Binance Futures API...'
                        : 'No active scan signals yet. Click "Start Bot" in Settings to begin scanning.'}
                    </td>
                  </tr>
                ) : (
                  sortedSignals.map((sig) => {
                    const isSelected = sig.symbol === selectedSymbol;
                    const isBull = sig.action === 'LONG';
                    const isBear = sig.action === 'SHORT';
                    const isHighVol = (sig.volatilityPercent || 0) >= 1.5;

                    return (
                      <tr
                        key={sig.symbol}
                        onClick={() => onSelectSymbol(sig.symbol)}
                        className={`transition-colors cursor-pointer ${
                          isSelected ? 'bg-slate-800/80' : 'hover:bg-slate-800/40'
                        }`}
                      >
                        {/* Symbol */}
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-200">{sig.symbol}</span>
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

                        {/* Volatility Index */}
                        <td className="py-3 px-3 tabular-nums font-semibold">
                          <div className="flex items-center gap-1 text-amber-400">
                            <span>{(sig.volatilityPercent || 1.2).toFixed(2)}%</span>
                            <span className="text-[10px] text-slate-500 font-sans">Index</span>
                          </div>
                          <div className="w-16 h-1 bg-slate-800 rounded-full mt-1.5 overflow-hidden">
                            <div
                              className="h-full bg-amber-400"
                              style={{
                                width: `${Math.min(100, (sig.volatilityPercent || 1.2) * 25)}%`,
                              }}
                            />
                          </div>
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
                        </td>

                        {/* Indicator 2: Heavy Absorption */}
                        <td className="py-3 px-3">
                          <div>
                            {Boolean(sig.absorption?.isHeavyAbsorption ?? sig.absorption?.isAbsorptionDetected) ? (
                              <span
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold ${
                                  (sig.absorption?.absorptionType === 'BULLISH' || sig.absorption?.type === 'BULLISH_ABSORPTION')
                                    ? 'text-emerald-400 bg-emerald-950/60 border border-emerald-800/40'
                                    : 'text-rose-400 bg-rose-950/60 border border-rose-800/40'
                                }`}
                              >
                                {(sig.absorption?.absorptionType === 'BULLISH' || sig.absorption?.type === 'BULLISH_ABSORPTION') ? 'Bull' : 'Bear'}{' '}
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
                            {Boolean(sig.imbalance?.hasStackedImbalance ?? sig.imbalance?.isImbalanceDetected) ? (
                              <span
                                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-bold ${
                                  (sig.imbalance?.imbalanceSide === 'BUY' || sig.imbalance?.type === 'BUY_IMBALANCE')
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
                        <td className="py-3 px-3">
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
                          <div className="text-[10px] text-slate-500 font-sans truncate max-w-[140px] mt-0.5">
                            {sig.reasons[0] || 'Flow consolidation'}
                          </div>
                        </td>

                        {/* Dynamic TP & SL */}
                        <td className="py-3 px-3 tabular-nums">
                          <div className="text-emerald-400">TP: ${formatCryptoPrice(sig.tpPrice)}</div>
                          <div className="text-rose-400 text-[11px]">SL: ${formatCryptoPrice(sig.slPrice)}</div>
                        </td>

                        {/* Bot Execution Action */}
                        <td className="py-3 px-3 text-right">
                          {botActive && (isBull || isBear) ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-sans text-emerald-400 bg-emerald-950/50 px-2 py-1 rounded border border-emerald-800/40">
                              <CheckCircle2 className="w-3 h-3" />
                              Auto-Ready
                            </span>
                          ) : (
                            <button
                              disabled={isMaxPositionsReached || (!isBull && !isBear)}
                              onClick={(e) => {
                                e.stopPropagation();
                                onManualExecute(sig);
                              }}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-sans font-medium rounded transition-colors ${
                                isMaxPositionsReached || (!isBull && !isBear)
                                  ? 'bg-slate-800/50 text-slate-600 cursor-not-allowed border border-slate-800'
                                  : isBull
                                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                                  : 'bg-rose-600 hover:bg-rose-500 text-white'
                              }`}
                              title={
                                isMaxPositionsReached
                                  ? 'Maximum 5 positions reached'
                                  : 'Execute trade with 10x leverage'
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
