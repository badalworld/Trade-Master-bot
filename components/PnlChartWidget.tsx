'use client';

import React from 'react';
import { motion } from 'motion/react';
import { BarChart3 } from 'lucide-react';
import type { ClosedTrade } from '@/lib/trading-engine';

interface PnlChartWidgetProps {
  trades: ClosedTrade[];
  totalPnl: number;
  startingBalance?: number;
  currentEquity?: number;
}

export function PnlChartWidget({
  trades,
  totalPnl,
  startingBalance = 0,
  currentEquity = 0,
}: PnlChartWidgetProps) {
  const sortedTrades = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const baseCapital = startingBalance > 0 ? startingBalance : 100.0;

  const chartPoints: {
    time: string;
    equity: number;
    pnl: number;
    symbol: string;
    isWin: boolean;
  }[] = [];

  let runningEquity = baseCapital;
  for (const t of sortedTrades) {
    runningEquity += t.pnl;
    chartPoints.push({
      time: new Date(t.exitTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      equity: runningEquity,
      pnl: t.pnl,
      symbol: t.symbol,
      isWin: t.isWin,
    });
  }

  const liveEquity = currentEquity > 0 ? currentEquity : baseCapital + totalPnl;

  if (chartPoints.length === 0) {
    chartPoints.push({ time: 'Start', equity: baseCapital, pnl: 0, symbol: 'BASE', isWin: true });
    chartPoints.push({
      time: 'Live',
      equity: liveEquity,
      pnl: totalPnl,
      symbol: 'LIVE',
      isWin: totalPnl >= 0,
    });
  }

  const minEquity = Math.min(...chartPoints.map((p) => p.equity), baseCapital * 0.95);
  const maxEquity = Math.max(...chartPoints.map((p) => p.equity), baseCapital * 1.05);
  const range = maxEquity - minEquity || 1;

  const width = 1200;
  const height = 220;
  const points = chartPoints
    .map((pt, idx) => {
      const x = (idx / (chartPoints.length - 1 || 1)) * (width - 40) + 20;
      const y = height - ((pt.equity - minEquity) / range) * (height - 40) - 20;
      return `${x},${y}`;
    })
    .join(' ');

  const isPositive = totalPnl >= 0;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4 }}
      className="neon-section mb-6 w-full"
    >
      <div className="neon-section-inner p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <BarChart3 className="w-5 h-5 text-cyan-400" />
            <h3 className="text-sm font-bold text-slate-100 tracking-wide uppercase">
              Cumulative Equity & PNL
            </h3>
          </div>
          <div className="flex items-center gap-6 text-xs font-mono">
            <span className="text-slate-400">
              Starting Balance:{' '}
              <strong className="text-slate-200">
                ${startingBalance > 0 ? startingBalance.toFixed(2) : '0.00'}
              </strong>
            </span>
            <span className="text-slate-400">
              Current Equity:{' '}
              <strong className={isPositive ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                ${liveEquity.toFixed(2)}
              </strong>
            </span>
          </div>
        </div>

        {/* Full-Width Responsive SVG Chart */}
        <div className="relative w-full h-64 bg-slate-950/90 rounded-xl p-4 border border-slate-800/90 flex items-center justify-center shadow-inner">
          <svg className="w-full h-full overflow-visible" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
            <defs>
              <linearGradient id="fullPnlGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={isPositive ? '#34d399' : '#fb7185'} stopOpacity="0.4" />
                <stop offset="100%" stopColor={isPositive ? '#34d399' : '#fb7185'} stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Background grid lines */}
            <line x1="20" y1="40" x2={width - 20} y2="40" stroke="#1e293b" strokeDasharray="6 6" strokeWidth="1" />
            <line x1="20" y1="110" x2={width - 20} y2="110" stroke="#1e293b" strokeDasharray="6 6" strokeWidth="1" />
            <line x1="20" y1="180" x2={width - 20} y2="180" stroke="#1e293b" strokeDasharray="6 6" strokeWidth="1" />

            {/* Area fill */}
            <polygon
              points={`20,${height - 20} ${points} ${width - 20},${height - 20}`}
              fill="url(#fullPnlGradient)"
            />

            {/* Polyline curve */}
            <polyline
              fill="none"
              stroke={isPositive ? '#34d399' : '#fb7185'}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={points}
            />

            {/* Data points with pulse */}
            {chartPoints.map((pt, idx) => {
              const x = (idx / (chartPoints.length - 1 || 1)) * (width - 40) + 20;
              const y = height - ((pt.equity - minEquity) / range) * (height - 40) - 20;
              return (
                <g key={idx}>
                  <circle
                    cx={x}
                    cy={y}
                    r="5.5"
                    className={pt.isWin ? 'fill-emerald-400' : 'fill-rose-400'}
                  />
                  <circle
                    cx={x}
                    cy={y}
                    r="10"
                    fill="none"
                    stroke={pt.isWin ? '#34d399' : '#fb7185'}
                    strokeWidth="1.5"
                    opacity="0.7"
                    className="animate-ping"
                  />
                </g>
              );
            })}
          </svg>
        </div>

        {/* Legend / Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-1 text-xs font-mono">
          <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800">
            <span className="text-slate-400 block text-[10px] font-semibold">TOTAL REAL PNL</span>
            <span className={`text-base font-extrabold ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
              {isPositive ? '+' : ''}${totalPnl.toFixed(2)}
            </span>
          </div>
          <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800">
            <span className="text-slate-400 block text-[10px] font-semibold">STARTING BALANCE</span>
            <span className="text-base font-extrabold text-cyan-300">
              ${startingBalance > 0 ? startingBalance.toFixed(2) : '0.00'}
            </span>
          </div>
          <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800">
            <span className="text-slate-400 block text-[10px] font-semibold">WIN RATE</span>
            <span className="text-base font-extrabold text-emerald-400">
              {trades.filter((t) => t.isWin).length} ({trades.length > 0 ? ((trades.filter((t) => t.isWin).length / trades.length) * 100).toFixed(0) : 0}%)
            </span>
          </div>
          <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800">
            <span className="text-slate-400 block text-[10px] font-semibold">API MODE</span>
            <span className="text-base font-extrabold text-cyan-400">Binance Futures Live</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
