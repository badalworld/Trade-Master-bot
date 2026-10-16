'use client';

import React, { useState, useEffect } from 'react';
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
  RotateCw,
  Sparkles,
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
  scanIntervalSeconds?: number;
  isScanning: boolean;
  botActive: boolean;
  binanceAccount?: BinanceAccountMetrics;
}

interface FlipCardWrapperProps {
  id: string;
  index: number;
  isFlipped: boolean;
  onToggleFlip: (id: string) => void;
  minHeightClass?: string;
  front: React.ReactNode;
  back: React.ReactNode;
}

function FlipCardWrapper({
  id,
  index,
  isFlipped,
  onToggleFlip,
  minHeightClass = 'min-h-[122px]',
  front,
  back,
}: FlipCardWrapperProps) {
  return (
    <motion.div
      initial={{ opacity: 0, rotateX: -65, y: 18, scale: 0.94 }}
      animate={{ opacity: 1, rotateX: 0, y: 0, scale: 1 }}
      transition={{
        type: 'spring',
        stiffness: 220,
        damping: 20,
        delay: index * 0.055,
      }}
      whileHover={{ y: -3, scale: 1.015 }}
      onClick={() => onToggleFlip(id)}
      className={`perspective-1000 cursor-pointer select-none group ${minHeightClass}`}
      title="Click to 3D Flip Card"
    >
      <motion.div
        animate={{ rotateY: isFlipped ? 180 : 0 }}
        transition={{
          type: 'spring',
          stiffness: 240,
          damping: 22,
          mass: 0.85,
        }}
        style={{ transformStyle: 'preserve-3d' }}
        className={`relative w-full h-full ${minHeightClass}`}
      >
        {/* Front Face */}
        <div
          style={{ backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}
          className={`neon-card w-full h-full ${minHeightClass}`}
        >
          <div className="neon-card-inner p-3.5 flex flex-col justify-between h-full">
            {front}
          </div>
        </div>

        {/* Back Face (Rotated 180deg in 3D space) */}
        <div
          style={{
            backfaceVisibility: 'hidden',
            WebkitBackfaceVisibility: 'hidden',
            transform: 'rotateY(180deg)',
          }}
          className="neon-card !absolute inset-0 w-full h-full"
        >
          <div className="neon-card-inner p-3.5 flex flex-col justify-between h-full bg-slate-950/98">
            {back}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
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
  scanIntervalSeconds = 15,
  isScanning,
  botActive,
  binanceAccount,
}: KpiMetricsStripProps) {
  const [flippedIds, setFlippedIds] = useState<Record<string, boolean>>({});
  const [autoWaveFlip, setAutoWaveFlip] = useState<boolean>(false);

  const allCardIds = [
    'starting-bal',
    'current-equity',
    'platform-fees',
    'funding-fees',
    'realized-pnl',
    'win-rate',
    'positions',
    'next-margin',
    'api-weight',
    'scan-cycle',
  ];

  const toggleCardFlip = (id: string) => {
    setFlippedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const anyFlipped = allCardIds.some((id) => flippedIds[id]);

  const handleFlipAll = () => {
    const nextState = !anyFlipped;
    const nextMap: Record<string, boolean> = {};
    allCardIds.forEach((id) => {
      nextMap[id] = nextState;
    });
    setFlippedIds(nextMap);
  };

  // Optional Jitter-style staggered wave flip animation
  useEffect(() => {
    if (!autoWaveFlip) return;
    let step = 0;
    const interval = setInterval(() => {
      const targetId = allCardIds[step % allCardIds.length];
      setFlippedIds((prev) => ({ ...prev, [targetId]: !prev[targetId] }));
      step += 1;
    }, 900);
    return () => clearInterval(interval);
  });

  const startingBal = binanceAccount?.startingBalance || 0;
  const currentEquity = binanceAccount?.isSynced
    ? binanceAccount.currentEquity
    : 0;
  const unrealizedPnl = binanceAccount?.unrealizedPnl || 0;
  const realizedPnl = binanceAccount?.isSynced
    ? binanceAccount.realizedPnl
    : totalPnl;
  const isRealizedPositive = realizedPnl >= 0;
  const platformFees = binanceAccount?.commissionFees || 0;
  const fundingFees = binanceAccount?.fundingFees || 0;
  const isFundingPositive = fundingFees >= 0;

  return (
    <div className="space-y-3.5 mb-6">
      {/* Motion Controls Strip for 3D Card Flip */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
          <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
          <span>Interactive 3D Telemetry Cards</span>
          <span className="text-slate-600">·</span>
          <span className="text-cyan-400/80">Click any card to 3D flip</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAutoWaveFlip(!autoWaveFlip)}
            className={`interactive-glow-btn px-2.5 py-1 rounded-lg text-[11px] font-mono flex items-center gap-1.5 border transition-all ${
              autoWaveFlip
                ? 'bg-cyan-950/90 text-cyan-300 border-cyan-500/60 shadow-[0_0_12px_rgba(0,240,255,0.35)]'
                : 'bg-slate-900/80 text-slate-400 hover:text-slate-200 border-slate-800'
            }`}
          >
            <RotateCw className={`w-3 h-3 ${autoWaveFlip ? 'animate-spin text-cyan-400' : ''}`} />
            {autoWaveFlip ? '3D Wave: ON' : '3D Wave Flip'}
          </button>

          <button
            type="button"
            onClick={handleFlipAll}
            className="interactive-glow-btn px-2.5 py-1 rounded-lg text-[11px] font-mono bg-slate-900/90 hover:bg-slate-800 text-cyan-300 border border-cyan-800/60 flex items-center gap-1.5 transition-all"
          >
            <RotateCw className="w-3 h-3 text-cyan-400" />
            {anyFlipped ? 'Reset Fronts' : 'Flip All Cards'}
          </button>
        </div>
      </div>

      {/* Row 1: Direct Binance Futures Auto-Sync Metrics Banner (4 3D Flip Cards) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Card 1: Starting Balance */}
        <FlipCardWrapper
          id="starting-bal"
          index={0}
          isFlipped={Boolean(flippedIds['starting-bal'])}
          onToggleFlip={toggleCardFlip}
          minHeightClass="min-h-[104px]"
          front={
            <>
              <div className="flex items-center justify-between gap-1 text-xs font-semibold text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Wallet className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  Starting Balance
                </span>
                <span className="text-[10px] uppercase tracking-wider text-cyan-400 bg-cyan-950/80 px-1.5 py-0.5 rounded border border-cyan-800 flex items-center gap-1">
                  Binance Synced
                  <RotateCw className="w-2.5 h-2.5 opacity-60 group-hover:opacity-100" />
                </span>
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-2">
                <div className="text-xl font-black font-mono tabular-nums text-slate-100">
                  ${startingBal.toFixed(2)}
                </div>
                <span className="text-[10px] text-slate-500 font-mono">Immutable</span>
              </div>
            </>
          }
          back={
            <>
              <div className="flex items-center justify-between text-[11px] font-mono text-cyan-300 font-bold border-b border-slate-800 pb-1">
                <span>CAPITAL BASELINE</span>
                <RotateCw className="w-3 h-3 text-cyan-400" />
              </div>
              <div className="space-y-1 text-[11px] font-mono pt-1">
                <div className="flex justify-between text-slate-400">
                  <span>Sync Status:</span>
                  <span className="text-emerald-400 font-semibold">
                    {binanceAccount?.isSynced ? 'LIVE LOCKED' : 'AWAITING KEY'}
                  </span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Base Trade Margin:</span>
                  <span className="text-slate-100 font-bold">
                    ${compoundingState.baseMargin.toFixed(2)} USDT
                  </span>
                </div>
              </div>
            </>
          }
        />

        {/* Card 2: Current Equity */}
        <FlipCardWrapper
          id="current-equity"
          index={1}
          isFlipped={Boolean(flippedIds['current-equity'])}
          onToggleFlip={toggleCardFlip}
          minHeightClass="min-h-[104px]"
          front={
            <>
              <div className="flex items-center justify-between gap-1 text-xs font-semibold text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  Current Equity
                </span>
                <span className="text-[10px] uppercase tracking-wider text-emerald-400 bg-emerald-950/80 px-1.5 py-0.5 rounded border border-emerald-800 flex items-center gap-1">
                  Live Margin
                  <RotateCw className="w-2.5 h-2.5 opacity-60 group-hover:opacity-100" />
                </span>
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-2">
                <div className="text-xl font-black font-mono tabular-nums text-emerald-400">
                  ${currentEquity.toFixed(2)}
                </div>
                <span className="text-[10px] text-slate-400 font-mono">
                  Avail: ${binanceAccount?.availableBalance.toFixed(2) || '0.00'}
                </span>
              </div>
            </>
          }
          back={
            <>
              <div className="flex items-center justify-between text-[11px] font-mono text-emerald-300 font-bold border-b border-slate-800 pb-1">
                <span>MARGIN TELEMETRY</span>
                <RotateCw className="w-3 h-3 text-emerald-400" />
              </div>
              <div className="space-y-1 text-[11px] font-mono pt-1">
                <div className="flex justify-between text-slate-400">
                  <span>Unrealized PnL:</span>
                  <span className={unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Free Collateral:</span>
                  <span className="text-slate-100">
                    ${binanceAccount?.availableBalance.toFixed(2) || '0.00'}
                  </span>
                </div>
              </div>
            </>
          }
        />

        {/* Card 3: Platform Fees */}
        <FlipCardWrapper
          id="platform-fees"
          index={2}
          isFlipped={Boolean(flippedIds['platform-fees'])}
          onToggleFlip={toggleCardFlip}
          minHeightClass="min-h-[104px]"
          front={
            <>
              <div className="flex items-center justify-between gap-1 text-xs font-semibold text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Receipt className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  Platform Fees
                </span>
                <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
                  Commission
                  <RotateCw className="w-2.5 h-2.5 opacity-60 group-hover:opacity-100 text-cyan-400" />
                </span>
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-2">
                <div className="text-xl font-black font-mono tabular-nums text-amber-400">
                  -${platformFees.toFixed(4)}
                </div>
                <span className="text-[10px] text-slate-500 font-mono">Binance cut</span>
              </div>
            </>
          }
          back={
            <>
              <div className="flex items-center justify-between text-[11px] font-mono text-amber-300 font-bold border-b border-slate-800 pb-1">
                <span>FEE SCHEDULE (USDT-M)</span>
                <RotateCw className="w-3 h-3 text-amber-400" />
              </div>
              <div className="space-y-1 text-[11px] font-mono pt-1">
                <div className="flex justify-between text-slate-400">
                  <span>Taker / Maker Rate:</span>
                  <span className="text-amber-300">0.05% / 0.02%</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Synced Fee Total:</span>
                  <span className="text-slate-200">-${platformFees.toFixed(4)}</span>
                </div>
              </div>
            </>
          }
        />

        {/* Card 4: Funding Fees */}
        <FlipCardWrapper
          id="funding-fees"
          index={3}
          isFlipped={Boolean(flippedIds['funding-fees'])}
          onToggleFlip={toggleCardFlip}
          minHeightClass="min-h-[104px]"
          front={
            <>
              <div className="flex items-center justify-between gap-1 text-xs font-semibold text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Percent className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  Funding Fees
                </span>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-bold flex items-center gap-1 ${
                    isFundingPositive
                      ? 'text-emerald-400 bg-emerald-950/70'
                      : 'text-rose-400 bg-rose-950/70'
                  }`}
                >
                  {isFundingPositive ? '+ CREDIT' : '- DEBIT'}
                  <RotateCw className="w-2.5 h-2.5 opacity-60 group-hover:opacity-100" />
                </span>
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-2">
                <div
                  className={`text-xl font-black font-mono tabular-nums ${
                    isFundingPositive ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {isFundingPositive ? '+' : ''}${fundingFees.toFixed(4)}
                </div>
                <span className="text-[10px] text-slate-500 font-mono">8h funding rate</span>
              </div>
            </>
          }
          back={
            <>
              <div className="flex items-center justify-between text-[11px] font-mono text-cyan-300 font-bold border-b border-slate-800 pb-1">
                <span>PERPETUAL FUNDING</span>
                <RotateCw className="w-3 h-3 text-cyan-400" />
              </div>
              <div className="space-y-1 text-[11px] font-mono pt-1">
                <div className="flex justify-between text-slate-400">
                  <span>Settlement Cycle:</span>
                  <span className="text-slate-200">Every 8 Hours</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Net Funding Impact:</span>
                  <span className={isFundingPositive ? 'text-emerald-400' : 'text-rose-400'}>
                    {isFundingPositive ? '+' : ''}${fundingFees.toFixed(4)}
                  </span>
                </div>
              </div>
            </>
          }
        />
      </div>

      {/* Row 2: Trading Engine Performance KPIs (6 3D Flip Cards) */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Card 5: Net Realized PnL */}
        <FlipCardWrapper
          id="realized-pnl"
          index={4}
          isFlipped={Boolean(flippedIds['realized-pnl'])}
          onToggleFlip={toggleCardFlip}
          front={
            <>
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
                  <span
                    className={`font-bold ${
                      isRealizedPositive ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {isRealizedPositive ? '+' : ''}
                    {startingBal > 0
                      ? ((realizedPnl / startingBal) * 100).toFixed(2)
                      : totalPnlPercent.toFixed(2)}
                    %
                  </span>
                  <span
                    className={`font-bold text-[10px] tracking-wide uppercase ${
                      isRealizedPositive ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
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
            </>
          }
          back={
            <>
              <div className="flex items-center justify-between text-[11px] font-mono text-emerald-300 font-bold border-b border-slate-800 pb-1">
                <span>PNL ANALYTICS</span>
                <RotateCw className="w-3 h-3 text-cyan-400" />
              </div>
              <div className="space-y-1 text-[11px] font-mono">
                <div className="flex justify-between text-slate-400">
                  <span>Last Win:</span>
                  <span className="text-emerald-400">+${compoundingState.lastProfit.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Bonus Pool:</span>
                  <span className="text-cyan-300">
                    ${compoundingState.totalCompoundedProfitPool.toFixed(2)}
                  </span>
                </div>
              </div>
            </>
          }
        />

        {/* Card 6: Win Rate */}
        <FlipCardWrapper
          id="win-rate"
          index={5}
          isFlipped={Boolean(flippedIds['win-rate'])}
          onToggleFlip={toggleCardFlip}
          front={
            <>
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
            </>
          }
          back={
            <>
              <div className="flex items-center justify-between text-[11px] font-mono text-cyan-300 font-bold border-b border-slate-800 pb-1">
                <span>WIN STREAK</span>
                <RotateCw className="w-3 h-3 text-cyan-400" />
              </div>
              <div className="space-y-1 text-[11px] font-mono">
                <div className="flex justify-between text-slate-400">
                  <span>Current Streak:</span>
                  <span className="text-emerald-400 font-bold">
                    {compoundingState.consecutiveWins} Wins
                  </span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Wins / Losses:</span>
                  <span className="text-slate-200">
                    {winningTrades} / {losingTrades}
                  </span>
                </div>
              </div>
            </>
          }
        />

        {/* Card 7: Open Positions Limit */}
        <FlipCardWrapper
          id="positions"
          index={6}
          isFlipped={Boolean(flippedIds['positions'])}
          onToggleFlip={toggleCardFlip}
          front={
            <>
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
                  <span>{Math.max(0, maxOpenPositions - openPositionsCount)} slots free</span>
                  <span className="text-slate-500 text-[10px]">Capacity</span>
                </div>
                <div className="w-full bg-slate-800/80 rounded-full h-1 mt-1.5 overflow-hidden">
                  <div
                    className="h-1 rounded-full bg-gradient-to-r from-cyan-600 to-cyan-400 shadow-[0_0_6px_#00f0ff] transition-all duration-1000 ease-linear"
                    style={{
                      width: `${Math.max(
                        15,
                        (openPositionsCount / Math.max(1, maxOpenPositions)) * 100
                      )}%`,
                    }}
                  />
                </div>
              </div>
            </>
          }
          back={
            <>
              <div className="flex items-center justify-between text-[11px] font-mono text-cyan-300 font-bold border-b border-slate-800 pb-1">
                <span>EXPOSURE GUARD</span>
                <RotateCw className="w-3 h-3 text-cyan-400" />
              </div>
              <div className="space-y-1 text-[11px] font-mono">
                <div className="flex justify-between text-slate-400">
                  <span>Margin Mode:</span>
                  <span className="text-cyan-300">10x–15x Isolated</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Max Concurrent:</span>
                  <span className="text-slate-200">{maxOpenPositions} Trades</span>
                </div>
              </div>
            </>
          }
        />

        {/* Card 8: Compounded Margin Rule */}
        <FlipCardWrapper
          id="next-margin"
          index={7}
          isFlipped={Boolean(flippedIds['next-margin'])}
          onToggleFlip={toggleCardFlip}
          front={
            <>
              <div className="flex items-center justify-between text-xs font-medium text-slate-400">
                <span>Next Margin</span>
                <Zap className="w-4 h-4 text-cyan-400" />
              </div>
              <div className="mt-2">
                <div className="text-xl font-bold font-mono tabular-nums text-cyan-300">
                  ${compoundingState.currentMargin.toFixed(2)}
                </div>
                <div className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5 flex items-center justify-between">
                  <span>+{compoundingState.compoundingPercent}% win comp.</span>
                  <span className="text-slate-500 text-[10px]">
                    Base ${compoundingState.baseMargin.toFixed(0)}
                  </span>
                </div>
                <div className="w-full bg-slate-800/80 rounded-full h-1 mt-1.5 overflow-hidden">
                  <div
                    className="h-1 rounded-full bg-gradient-to-r from-blue-600 to-cyan-400 shadow-[0_0_6px_#00f0ff]"
                    style={{
                      width: `${Math.min(100, (compoundingState.currentMargin / 5) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            </>
          }
          back={
            <>
              <div className="flex items-center justify-between text-[11px] font-mono text-cyan-300 font-bold border-b border-slate-800 pb-1">
                <span>COMPOUND ENGINE</span>
                <RotateCw className="w-3 h-3 text-cyan-400" />
              </div>
              <div className="space-y-1 text-[11px] font-mono">
                <div className="flex justify-between text-slate-400">
                  <span>Base Margin:</span>
                  <span className="text-slate-200">${compoundingState.baseMargin.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Loss Rule:</span>
                  <span className="text-amber-300">Reset to ${compoundingState.baseMargin.toFixed(2)}</span>
                </div>
              </div>
            </>
          }
        />

        {/* Card 9: Binance Rate Limit Shield */}
        <FlipCardWrapper
          id="api-weight"
          index={8}
          isFlipped={Boolean(flippedIds['api-weight'])}
          onToggleFlip={toggleCardFlip}
          front={
            <>
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
            </>
          }
          back={
            <>
              <div className="flex items-center justify-between text-[11px] font-mono text-cyan-300 font-bold border-b border-slate-800 pb-1">
                <span>RATE LIMIT SHIELD</span>
                <RotateCw className="w-3 h-3 text-cyan-400" />
              </div>
              <div className="space-y-1 text-[11px] font-mono">
                <div className="flex justify-between text-slate-400">
                  <span>Safety Cap:</span>
                  <span className="text-emerald-400">95% Auto-Pause</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Free Weight:</span>
                  <span className="text-slate-200">{rateLimitStatus.remainingWeight}</span>
                </div>
              </div>
            </>
          }
        />

        {/* Card 10: Live Time Countdown Scanner Ticker */}
        <FlipCardWrapper
          id="scan-cycle"
          index={9}
          isFlipped={Boolean(flippedIds['scan-cycle'])}
          onToggleFlip={toggleCardFlip}
          front={
            <>
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
                      <span className="text-xs font-normal text-cyan-400/80">
                        ({scanCountdown}s)
                      </span>
                    </span>
                  ) : (
                    <span className="text-slate-400 text-sm font-medium">
                      Ready ({scanIntervalSeconds}s)
                    </span>
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
                  <span className="text-slate-500 text-[10px]">{scanIntervalSeconds}s cycle</span>
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
                          : `${Math.max(
                              4,
                              Math.min(100, (scanCountdown / Math.max(1, scanIntervalSeconds)) * 100)
                            )}%`
                        : '100%',
                    }}
                  />
                </div>
              </div>
            </>
          }
          back={
            <>
              <div className="flex items-center justify-between text-[11px] font-mono text-cyan-300 font-bold border-b border-slate-800 pb-1">
                <span>3-INDICATOR ENGINE</span>
                <RotateCw className="w-3 h-3 text-cyan-400" />
              </div>
              <div className="space-y-1 text-[11px] font-mono">
                <div className="flex justify-between text-slate-400">
                  <span>Timeframe:</span>
                  <span className="text-cyan-300">5m Candles (Parallel)</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Indicators:</span>
                  <span className="text-emerald-400">HVN + Abs + 3:1 Imb</span>
                </div>
              </div>
            </>
          }
        />
      </div>
    </div>
  );
}
