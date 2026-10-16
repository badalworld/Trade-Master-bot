'use client';

import React from 'react';
import { motion } from 'motion/react';
import {
  TrendingUp,
  TrendingDown,
  XCircle,
  ArrowUpRight,
  ArrowDownRight,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import type { TradePosition } from '@/lib/trading-engine';
import { formatCryptoPrice } from '@/lib/utils';

interface ActivePositionsProps {
  positions: TradePosition[];
  onClosePosition: (positionId: string) => void;
  onSelectSymbol?: (symbol: string) => void;
  selectedSymbol?: string;
  maxOpenPositions?: number;
  leverage?: number;
  closingPositionId?: string | null;
}

export function ActivePositions({
  positions,
  onClosePosition,
  onSelectSymbol,
  selectedSymbol,
  maxOpenPositions = 5,
  leverage = 10,
  closingPositionId = null,
}: ActivePositionsProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="neon-section"
    >
      <div className="neon-section-inner">
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-slate-100">Active Futures Positions</h2>
            <span className="text-xs text-cyan-400 font-mono tabular-nums font-semibold">
              {positions.length} / {maxOpenPositions}
            </span>
          </div>
          <span className="text-xs text-slate-400 font-mono">{leverage}x Isolated</span>
        </div>

        {positions.length === 0 ? (
          <div className="p-8 text-center flex flex-col items-center justify-center">
            <div className="w-10 h-10 rounded-full bg-slate-800/80 flex items-center justify-center mb-2">
              <span className="text-slate-400 font-mono text-sm">
                0/{maxOpenPositions}
              </span>
            </div>
            <h3 className="text-sm font-medium text-slate-300">No Open Positions</h3>
            <p className="text-xs text-slate-500 mt-1">
              Bot will automatically open positions when 3-Indicator signals trigger ($2.00 Base Margin · {leverage}x Isolated).
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/60 text-slate-400 border-b border-slate-800 font-medium">
                <tr>
                  <th className="py-2.5 px-4">Symbol / Side</th>
                  <th className="py-2.5 px-3">Margin & Lev</th>
                  <th className="py-2.5 px-3">Entry Price</th>
                  <th className="py-2.5 px-3">Mark Price</th>
                  <th className="py-2.5 px-3">Unrealized PnL</th>
                  <th className="py-2.5 px-3">Indicator TP</th>
                  <th className="py-2.5 px-3">Indicator SL</th>
                  <th className="py-2.5 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {Array.from(new Map(positions.map((p) => [p.id, p])).values()).map((pos, idx) => {
                  const isProfit = pos.unrealizedPnl >= 0;
                  const isLong = pos.side === 'LONG';
                  const isSelected = selectedSymbol === pos.symbol;
                  const isClosing = closingPositionId === pos.id;

                  return (
                    <tr
                      key={`${pos.id}-${idx}`}
                      className={`transition-colors group cursor-pointer ${
                        isSelected
                          ? 'bg-cyan-950/30 border-l-2 border-l-cyan-400'
                          : 'hover:bg-slate-800/40'
                      }`}
                      onClick={() => onSelectSymbol && onSelectSymbol(pos.symbol)}
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-200">{pos.symbol}</span>
                          <span
                            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] font-medium ${
                              isLong
                                ? 'bg-emerald-950/70 text-emerald-400 border border-emerald-800/60'
                                : 'bg-rose-950/70 text-rose-400 border border-rose-800/60'
                            }`}
                          >
                            {isLong ? (
                              <ArrowUpRight className="w-3 h-3" />
                            ) : (
                              <ArrowDownRight className="w-3 h-3" />
                            )}
                            {pos.side}
                          </span>
                          {pos.adoptedFromExchange ? (
                            <span
                              title="Discovered on Binance; this browser did not open it. Its stop-loss/take-profit are whatever is configured on the exchange, not here."
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-950/70 text-amber-300 border border-amber-800/60"
                            >
                              <AlertTriangle className="w-3 h-3" />
                              FROM BINANCE
                            </span>
                          ) : !pos.slOrderId ? (
                            <span
                              title="No stop-loss order id was recorded for this position. Verify a protective stop exists on Binance, or close it."
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-rose-950/70 text-rose-300 border border-rose-800/70"
                            >
                              <AlertTriangle className="w-3 h-3" />
                              NO STOP RECORDED
                            </span>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-slate-500 font-sans mt-0.5">
                          Qty: {pos.quantity}
                        </div>
                      </td>

                      <td className="py-3 px-3 tabular-nums">
                        <div className="text-slate-200 font-medium">
                          ${Number.isFinite(pos.margin) ? pos.margin.toFixed(2) : '0.00'}
                        </div>
                        <div className="text-[11px] text-cyan-400">{pos.leverage}x</div>
                      </td>

                      <td className="py-3 px-3 tabular-nums text-slate-300">
                        ${formatCryptoPrice(pos.entryPrice)}
                      </td>

                      <td className="py-3 px-3 tabular-nums font-semibold text-slate-100">
                        ${formatCryptoPrice(pos.markPrice)}
                      </td>

                      <td className="py-3 px-3 tabular-nums">
                        <div
                          className={`font-semibold flex items-center gap-1 ${
                            isProfit ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {isProfit ? '+' : ''}${pos.unrealizedPnl.toFixed(2)}
                          {isProfit ? (
                            <TrendingUp className="w-3.5 h-3.5" />
                          ) : (
                            <TrendingDown className="w-3.5 h-3.5" />
                          )}
                        </div>
                        <div className="flex items-center justify-between text-[11px] mt-0.5">
                          <span
                            className={isProfit ? 'text-emerald-400/80' : 'text-rose-400/80'}
                          >
                            {isProfit ? '+' : ''}
                            {pos.unrealizedPnlPercent.toFixed(2)}%
                          </span>
                        </div>
                        <div className="w-full bg-slate-800/80 rounded-full h-1 mt-1 overflow-hidden">
                          <div
                            className={`h-1 rounded-full transition-all duration-1000 ease-linear ${
                              isProfit
                                ? 'bg-gradient-to-r from-emerald-600 to-emerald-400 shadow-[0_0_6px_#34d399]'
                                : 'bg-gradient-to-r from-rose-600 to-rose-400 shadow-[0_0_6px_#fb7185]'
                            }`}
                            style={{
                              width: `${Math.max(10, Math.min(100, Math.abs(pos.unrealizedPnlPercent) * 5))}%`,
                            }}
                          />
                        </div>
                      </td>

                      <td className="py-3 px-3 tabular-nums text-emerald-400">
                        ${formatCryptoPrice(pos.takeProfit)}
                      </td>

                      <td className="py-3 px-3 tabular-nums text-rose-400">
                        ${formatCryptoPrice(pos.stopLoss)}
                      </td>

                      <td className="py-3 px-3 text-right">
                        <button
                          disabled={isClosing}
                          onClick={(e) => {
                            e.stopPropagation();
                            onClosePosition(pos.id);
                          }}
                          className="interactive-glow-btn inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-sans font-medium text-slate-300 bg-slate-800 hover:bg-rose-900/60 hover:text-rose-200 border border-slate-700 hover:border-rose-700/80 rounded transition-colors disabled:opacity-50"
                          title="Close Position on Binance"
                        >
                          {isClosing ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5" />
                          )}
                          {isClosing ? 'Closing...' : 'Close'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </motion.div>
  );
}
