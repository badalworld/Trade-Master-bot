'use client';

import React from 'react';
import { motion } from 'motion/react';
import {
  TrendingUp,
  TrendingDown,
  Layers,
  ShieldCheck,
  Zap,
  Clock,
  AlertTriangle,
  Wallet,
  Receipt,
  Percent,
} from 'lucide-react';
import type { CompoundingState, RateLimitStatus } from '@/lib/trading-engine';

export interface BinanceAccountMetrics {
  startingBalance: number;
  currentEquity: number;
  availableBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
  commissionFees: number;
  fundingFees: number;
  isSynced: boolean;
}

interface KpiMetricsStripProps {
  totalPnl: number;
  totalPnlPercent: number;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  openPositionsCount: number;
  maxOpenPositions: number;
  compoundingState: CompoundingState;
  rateLimitStatus: RateLimitStatus;
  scanCountdown: number;
  isScanning: boolean;
  botActive: boolean;
  binanceAccount?: BinanceAccountMetrics;
}

export function KpiMetricsStrip({
  totalPnl,
  totalPnlPercent,
  winRate,
  totalTrades,
  winningTrades,
  losingTrades,
  openPositionsCount,
  maxOpenPositions,
  compoundingState,
  rateLimitStatus,
  scanCountdown,
  isScanning,
  botActive,
  binanceAccount,
}: KpiMetricsStripProps) {
  const isPnlPositive = totalPnl >= 0;

  // Account synced values
  const startingBal = binanceAccount?.startingBalance || 0;
  const currentEquity = binanceAccount?.isSynced
    ? binanceAccount.currentEquity
    : 0;
  const realizedPnl = binanceAccount?.isSynced
    ? binanceAccount.realizedPnl
    : totalPnl;
  const isRealizedPositive = realizedPnl >= 0;
  const platformFees = binanceAccount?.commissionFees || 0;
  const fundingFees = binanceAccount?.fundingFees || 0;
  const isFundingPositive = fundingFees >= 0;

  return (
    <div className="space-y-4 mb-6">
      {/* Row 1: Direct Binance Futures Auto-Sync Metrics Banner (Fixed Equal Sizing) */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="grid grid-cols-2 md:grid-cols-4 gap-3"
      >
        {/* Metric 1: Starting Balance (Permanent & Locked, Never Editable) */}
        <div className="neon-card !h-[96px]">
          <div className="neon-card-inner p-3.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span className="flex items-center gap-1.5">
                <Wallet className="w-3.5 h-3.5 text-cyan-400" />
                Starting Balance
              </span>
              <span className="text-[10px] uppercase tracking-wider text-cyan-400 bg-cyan-950/80 px-1.5 py-0.5 rounded border border-cyan-800">
                Binance Synced
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <div className="text-xl font-black font-mono tabular-nums text-slate-100">
                ${startingBal.toFixed(2)}
              </div>
              <span className="text-[10px] text-slate-500 font-mono">Immutable</span>
            </div>
          </div>
        </div>

        {/* Metric 2: Current Equity */}
        <div className="neon-card !h-[96px]">
          <div className="neon-card-inner p-3.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span className="flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-cyan-400" />
                Current Equity
              </span>
              <span className="text-[10px] uppercase tracking-wider text-emerald-400 bg-emerald-950/80 px-1.5 py-0.5 rounded border border-emerald-800">
                Live Margin
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <div className="text-xl font-black font-mono tabular-nums text-emerald-400">
                ${currentEquity.toFixed(2)}
              </div>
              <span className="text-[10px] text-slate-400 font-mono">
                Avail: ${binanceAccount?.availableBalance.toFixed(2) || '0.00'}
              </span>
            </div>
          </div>
        </div>

        {/* Metric 3: Binance Platform Fees (Commission) */}
        <div className="neon-card !h-[96px]">
          <div className="neon-card-inner p-3.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span className="flex items-center gap-1.5">
                <Receipt className="w-3.5 h-3.5 text-amber-400" />
                Platform Fees
              </span>
              <span className="text-[10px] text-slate-500 font-mono">Commission</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <div className="text-xl font-black font-mono tabular-nums text-amber-400">
                -${platformFees.toFixed(4)}
              </div>
              <span className="text-[10px] text-slate-500 font-mono">Binance cut</span>
            </div>
          </div>
        </div>

        {/* Metric 4: Funding Fees (+/-) */}
        <div className="neon-card !h-[96px]">
          <div className="neon-card-inner p-3.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span className="flex items-center gap-1.5">
                <Percent className="w-3.5 h-3.5 text-cyan-400" />
                Funding Fees
              </span>
              <span
                className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-bold ${
                  isFundingPositive
                    ? 'text-emerald-400 bg-emerald-950/70'
                    : 'text-rose-400 bg-rose-950/70'
                }`}
              >
                {isFundingPositive ? '+ CREDIT' : '- DEBIT'}
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <div
                className={`text-xl font-black font-mono tabular-nums ${
                  isFundingPositive ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {isFundingPositive ? '+' : ''}${fundingFees.toFixed(4)}
              </div>
              <span className="text-[10px] text-slate-500 font-mono">8h funding rate</span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Row 2: Trading Engine Performance KPIs */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.08 }}
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3"
      >
        {/* 1. Net Realized PnL */}
        <div className="neon-card">
          <div className="neon-card-inner p-3.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400">
              <span>Realized PnL</span>
              {isRealizedPositive ? (
                <TrendingUp className="w-4 h-4 text-emerald-400" />
              ) : (
                <TrendingDown className="w-4 h-4 text-rose-400" />
              )}
            </div>
            <div className="mt-2">
              <div
                className={`text-xl font-bold font-mono tabular-nums ${
                  isRealizedPositive ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {isRealizedPositive ? '+' : ''}${realizedPnl.toFixed(2)}
              </div>
              <div className="text-[11px] font-mono tabular-nums mt-0.5 flex items-center justify-between">
                <span className={`font-bold ${isRealizedPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {isRealizedPositive ? '+' : ''}
                  {startingBal > 0
                    ? ((realizedPnl / startingBal) * 100).toFixed(2)
                    : totalPnlPercent.toFixed(2)}
                  %
                </span>
                <span className={`font-bold text-[10px] tracking-wide uppercase ${isRealizedPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {isRealizedPositive ? 'Net Profit' : 'Net Loss'}
                </span>
              </div>
              <div className="w-full bg-slate-800/80 rounded-full h-1 mt-1.5 overflow-hidden">
                <div
                  className={`h-1 rounded-full transition-all duration-1000 ease-linear ${
                    isRealizedPositive
                      ? 'bg-gradient-to-r from-emerald-600 to-emerald-400 shadow-[0_0_6px_#34d399]'
                      : 'bg-gradient-to-r from-rose-600 to-rose-400 shadow-[0_0_6px_#fb7185]'
                  }`}
                  style={{
                    width: `${Math.max(10, Math.min(100, Math.abs(totalPnlPercent) * 20))}%`,
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 2. Win Rate */}
        <div className="neon-card">
          <div className="neon-card-inner p-3.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400">
              <span>Win Rate</span>
              <span className="text-[11px] text-slate-500 font-mono">
                {winningTrades}W / {losingTrades}L
              </span>
            </div>
            <div className="mt-2">
              <div
                className={`text-xl font-bold font-mono tabular-nums ${
                  winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {totalTrades > 0 ? winRate.toFixed(1) : '0.0'}%
              </div>
              <div className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5 flex items-center justify-between">
                <span>{totalTrades} trades</span>
                <span className="text-slate-500 text-[10px]">Accuracy</span>
              </div>
              <div className="w-full bg-slate-800/80 rounded-full h-1 mt-1.5 overflow-hidden">
                <div
                  className={`h-1 rounded-full transition-all duration-1000 ease-linear ${
                    winRate >= 50
                      ? 'bg-gradient-to-r from-emerald-600 to-emerald-400 shadow-[0_0_6px_#34d399]'
                      : 'bg-gradient-to-r from-rose-600 to-rose-400 shadow-[0_0_6px_#fb7185]'
                  }`}
                  style={{ width: `${totalTrades > 0 ? Math.max(10, winRate) : 10}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 3. Open Positions Limit */}
        <div className="neon-card">
          <div className="neon-card-inner p-3.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400">
              <span>Positions</span>
              <Layers className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="mt-2">
              <div className="text-xl font-bold font-mono tabular-nums text-slate-100">
                {openPositionsCount}{' '}
                <span className="text-sm font-normal text-slate-400">
                  / {maxOpenPositions}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5 flex items-center justify-between">
                <span>{maxOpenPositions - openPositionsCount} slots free</span>
                <span className="text-slate-500 text-[10px]">Capacity</span>
              </div>
              <div className="w-full bg-slate-800/80 rounded-full h-1 mt-1.5 overflow-hidden">
                <div
                  className="h-1 rounded-full bg-gradient-to-r from-cyan-600 to-cyan-400 shadow-[0_0_6px_#00f0ff] transition-all duration-1000 ease-linear"
                  style={{
                    width: `${Math.max(15, (openPositionsCount / maxOpenPositions) * 100)}%`,
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 4. Compounded Margin Rule */}
        <div className="neon-card">
          <div className="neon-card-inner p-3.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400">
              <span>Next Margin</span>
              <Zap className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="mt-2">
              <div className="text-xl font-bold font-mono tabular-nums text-cyan-300">
                ${compoundingState.currentMargin.toFixed(2)}
              </div>
              <div className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5 flex items-center justify-between">
                <span>+20% win comp.</span>
                <span className="text-slate-500 text-[10px]">Dynamic</span>
              </div>
              <div className="w-full bg-slate-800/80 rounded-full h-1 mt-1.5 overflow-hidden">
                <div
                  className="h-1 rounded-full bg-gradient-to-r from-blue-600 to-cyan-400 shadow-[0_0_6px_#00f0ff] animate-pulse"
                  style={{ width: `${Math.min(100, (compoundingState.currentMargin / 5) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 5. Binance Rate Limit Shield */}
        <div className="neon-card">
          <div className="neon-card-inner p-3.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400">
              <span>API Weight</span>
              {rateLimitStatus.isThrottled ? (
                <AlertTriangle className="w-4 h-4 text-rose-400" />
              ) : (
                <ShieldCheck className="w-4 h-4 text-cyan-400" />
              )}
            </div>
            <div className="mt-2">
              <div
                className={`text-xl font-bold font-mono tabular-nums ${
                  rateLimitStatus.isThrottled ? 'text-rose-400' : 'text-slate-100'
                }`}
              >
                {rateLimitStatus.usagePercent.toFixed(0)}%
              </div>
              <div className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5 flex items-center justify-between">
                <span>
                  {rateLimitStatus.usedWeight} / {rateLimitStatus.maxLimit}
                </span>
                <span className="text-slate-500 text-[10px]">Shield</span>
              </div>
              <div className="w-full bg-slate-800/80 rounded-full h-1 mt-1.5 overflow-hidden">
                <div
                  className={`h-1 rounded-full transition-all duration-1000 ease-linear ${
                    rateLimitStatus.isThrottled
                      ? 'bg-rose-500 shadow-[0_0_6px_#fb7185]'
                      : 'bg-gradient-to-r from-cyan-600 to-blue-400 shadow-[0_0_6px_#00f0ff]'
                  }`}
                  style={{ width: `${Math.max(5, Math.min(100, rateLimitStatus.usagePercent))}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 6. Live Time Countdown Scanner Ticker */}
        <div className="neon-card">
          <div className="neon-card-inner p-3.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400">
              <span>Scan Cycle</span>
              <Clock className={`w-4 h-4 ${botActive ? 'text-cyan-400' : 'text-slate-500'}`} />
            </div>
            <div className="mt-2">
              <div className="text-xl font-bold font-mono tabular-nums text-cyan-300 flex items-center gap-2">
                {isScanning ? (
                  <span className="flex items-center gap-1.5 text-cyan-400">
                    <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping shadow-[0_0_8px_#00f0ff]" />
                    <span className="text-sm font-semibold tracking-wide">Scanning...</span>
                  </span>
                ) : botActive ? (
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-xl font-extrabold text-cyan-300 tracking-wider">
                      00:{scanCountdown.toString().padStart(2, '0')}
                    </span>
                    <span className="text-xs font-normal text-cyan-400/80">({scanCountdown}s)</span>
                  </span>
                ) : (
                  <span className="text-slate-400 text-sm font-medium">Ready (15s)</span>
                )}
                {botActive && !isScanning && (
                  <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_#00f0ff]" />
                )}
              </div>
              <div className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5 flex items-center justify-between">
                <span>
                  {botActive
                    ? isScanning
                      ? 'Syncing pairs...'
                      : `Next in ${scanCountdown}s`
                    : 'Start Bot to run'}
                </span>
                <span className="text-slate-500 text-[10px]">15s cycle</span>
              </div>
              <div className="w-full bg-slate-800/80 rounded-full h-1 mt-1.5 overflow-hidden">
                <div
                  className={`h-1 rounded-full transition-all duration-1000 ease-linear ${
                    botActive
                      ? isScanning
                        ? 'w-full bg-cyan-400 animate-pulse shadow-[0_0_8px_#00f0ff]'
                        : 'bg-gradient-to-r from-blue-500 to-cyan-400 shadow-[0_0_6px_#00f0ff]'
                      : 'w-full bg-slate-700'
                  }`}
                  style={{
                    width: botActive
                      ? isScanning
                        ? '100%'
                        : `${Math.max(4, Math.min(100, (scanCountdown / 15) * 100))}%`
                      : '100%',
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
