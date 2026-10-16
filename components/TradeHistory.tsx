'use client';

import React from 'react';
import { motion } from 'motion/react';
import { TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight, Zap } from 'lucide-react';
import type { ClosedTrade, CompoundingState } from '@/lib/trading-engine';
import { formatCryptoPrice } from '@/lib/utils';

interface TradeHistoryProps {
  trades: ClosedTrade[];
  compoundingState: CompoundingState;
}

export function TradeHistory({ trades, compoundingState }: TradeHistoryProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="space-y-6"
    >
      {/* Closed Trades Table */}
      <div className="neon-section">
        <div className="neon-section-inner">
          <div className="px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-slate-100">Closed Futures Trade Log</h2>
              <span className="text-xs text-cyan-400 font-mono font-semibold">
                {trades.length} trades
              </span>
            </div>
            <div className="flex items-center gap-4 text-xs font-mono">
              <span className="text-slate-400">
                Bonus Pool:{' '}
                <span className="text-cyan-300 font-bold">
                  ${compoundingState.totalCompoundedProfitPool.toFixed(2)}
                </span>
              </span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">10x Leverage</span>
            </div>
          </div>

          {trades.length === 0 ? (
            <div className="p-12 text-center flex flex-col items-center justify-center">
              <div className="w-10 h-10 rounded-full bg-slate-800/80 flex items-center justify-center mb-3">
                <Zap className="w-4 h-4 text-slate-500" />
              </div>
              <h3 className="text-sm font-medium text-slate-300">No Closed Trades Yet</h3>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/60 text-slate-400 border-b border-slate-800 font-medium">
                  <tr>
                    <th className="py-2.5 px-4">Close Time</th>
                    <th className="py-2.5 px-3">Symbol / Side</th>
                    <th className="py-2.5 px-3">Margin & Lev</th>
                    <th className="py-2.5 px-3">Entry Price</th>
                    <th className="py-2.5 px-3">Exit Price</th>
                    <th className="py-2.5 px-3">Realized PnL</th>
                    <th className="py-2.5 px-3">Exit Reason</th>
                    <th className="py-2.5 px-4 text-right">Compounding</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {Array.from(new Map(trades.map((t) => [t.id, t])).values()).map((trade, idx) => {
                    const isProfit = trade.pnl >= 0;
                    const isLong = trade.side === 'LONG';

                    return (
                      <tr
                        key={`${trade.id}-${idx}`}
                        className="hover:bg-slate-800/40 transition-colors"
                      >
                        <td className="py-3 px-4 text-slate-400 whitespace-nowrap">
                          {new Date(trade.exitTime).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </td>

                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-200">{trade.symbol}</span>
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
                              {trade.side}
                            </span>
                          </div>
                        </td>

                        <td className="py-3 px-3 tabular-nums text-slate-300">
                          ${trade.margin.toFixed(2)} · {trade.leverage}x
                        </td>

                        <td className="py-3 px-3 tabular-nums text-slate-400">
                          ${formatCryptoPrice(trade.entryPrice)}
                        </td>

                        <td className="py-3 px-3 tabular-nums text-slate-200">
                          ${formatCryptoPrice(trade.exitPrice)}
                        </td>

                        <td className="py-3 px-3 tabular-nums font-semibold">
                          <div
                            className={`flex items-center gap-1 ${
                              isProfit ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {isProfit ? '+' : ''}${trade.pnl.toFixed(2)}
                            {isProfit ? (
                              <TrendingUp className="w-3.5 h-3.5" />
                            ) : (
                              <TrendingDown className="w-3.5 h-3.5" />
                            )}
                          </div>
                          <div
                            className={`text-[11px] ${
                              isProfit ? 'text-emerald-400/80' : 'text-rose-400/80'
                            }`}
                          >
                            {isProfit ? '+' : ''}
                            {trade.pnlPercent.toFixed(2)}%
                          </div>
                        </td>

                        <td className="py-3 px-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-sans font-medium ${
                              trade.reason === 'TAKE_PROFIT'
                                ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                : trade.reason === 'STOP_LOSS'
                                ? 'bg-rose-950 text-rose-300 border border-rose-800'
                                : 'bg-slate-800 text-slate-300'
                            }`}
                          >
                            {trade.reason.replace('_', ' ')}
                          </span>
                        </td>

                        <td className="py-3 px-4 text-right tabular-nums">
                          {trade.isWin ? (
                            <div className="text-emerald-400 text-xs font-semibold">
                              +${trade.compoundingBonusGenerated.toFixed(2)}
                            </div>
                          ) : (
                            <div className="text-slate-400 text-xs">
                              Base reset ($2.00)
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
