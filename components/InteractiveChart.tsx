'use client';

import React, { useRef, useEffect } from 'react';
import type { Candle, SignalEvaluation, TradePosition } from '@/lib/trading-engine';
import { formatCryptoPrice } from '@/lib/utils';

interface InteractiveChartProps {
  symbol: string;
  candles: Candle[];
  signal?: SignalEvaluation;
  activePosition?: TradePosition;
}

export function InteractiveChart({
  symbol,
  candles,
  signal,
  activePosition,
}: InteractiveChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || candles.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const padding = { top: 25, right: 120, bottom: 40, left: 15 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const priceChartHeight = chartHeight * 0.76;
    const volumeChartHeight = chartHeight * 0.20;
    const volumeTop = padding.top + priceChartHeight + chartHeight * 0.04;

    const candleHighs = candles.map((c) => c.high);
    const candleLows = candles.map((c) => c.low);
    const candleMin = Math.min(...candleLows);
    const candleMax = Math.max(...candleHighs);
    const spread = candleMax - candleMin || candleMax * 0.01;

    const minPrice = candleMin - spread * 0.12;
    const maxPrice = candleMax + spread * 0.12;
    const priceRange = maxPrice - minPrice;

    const maxVolume = Math.max(...candles.map((c) => c.volume)) || 1;

    const getY = (price: number) =>
      padding.top + priceChartHeight - ((price - minPrice) / priceRange) * priceChartHeight;

    const candleCount = candles.length;
    const candleWidth = Math.max(4, (chartWidth / candleCount) * 0.72);
    const step = chartWidth / candleCount;

    // 1. Draw Grid & Horizontal Price Axis
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.35)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';

    const gridSteps = 5;
    for (let i = 0; i <= gridSteps; i++) {
      const p = minPrice + (priceRange / gridSteps) * i;
      const y = getY(p);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      ctx.fillText(`$${formatCryptoPrice(p)}`, width - padding.right + 6, y + 3);
    }

    // 2. Draw Indicator 1: HVN Volume Profile Histogram on Right Margin
    if (signal && signal.hvnProfile && signal.hvnProfile.nodes.length > 0) {
      const profileMaxVol = Math.max(...signal.hvnProfile.nodes.map((n) => n.volume)) || 1;
      const profileMaxBarWidth = 65; // px

      signal.hvnProfile.nodes.forEach((node) => {
        const y = getY(node.priceLevel);
        const barW = (node.volume / profileMaxVol) * profileMaxBarWidth;
        const x = width - padding.right;

        ctx.fillStyle = node.isPOC
          ? 'rgba(245, 158, 11, 0.45)' // POC highlighted in Gold
          : node.isHVN
          ? 'rgba(99, 102, 241, 0.35)' // HVN highlighted in Indigo
          : 'rgba(51, 65, 85, 0.25)';

        ctx.fillRect(x - barW, y - 4, barW, 8);

        if (node.isPOC) {
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 1.2;
          ctx.strokeRect(x - barW, y - 4, barW, 8);
        }
      });

      // POC Line across chart
      const pocY = getY(signal.hvnProfile.pocPrice);
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padding.left, pocY);
      ctx.lineTo(width - padding.right, pocY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(`POC: $${formatCryptoPrice(signal.hvnProfile.pocPrice)}`, width - padding.right + 6, pocY - 2);
    }

    // 3. Draw Indicator 3: Stacked Imbalance Levels Highlight
    if (signal && signal.imbalance && signal.imbalance.isImbalanceDetected) {
      const isBuyImb = signal.imbalance.type === 'BUY_IMBALANCE';
      ctx.fillStyle = isBuyImb ? 'rgba(16, 185, 129, 0.15)' : 'rgba(244, 63, 94, 0.15)';

      signal.imbalance.imbalancePriceLevels.forEach((priceLvl) => {
        const imbY = getY(priceLvl);
        ctx.fillRect(padding.left, imbY - 3, chartWidth, 6);
      });
    }

    // 4. Draw Volume Bars at bottom
    candles.forEach((c, idx) => {
      const x = padding.left + idx * step + step / 2;
      const vHeight = (c.volume / maxVolume) * volumeChartHeight;
      const y = volumeTop + volumeChartHeight - vHeight;
      const isUp = c.close >= c.open;

      ctx.fillStyle = isUp ? 'rgba(16, 185, 129, 0.25)' : 'rgba(244, 63, 94, 0.25)';
      ctx.fillRect(x - candleWidth / 2, y, candleWidth, vHeight);
    });

    // 5. Draw 5m Candlesticks
    candles.forEach((c, idx) => {
      const x = padding.left + idx * step + step / 2;
      const openY = getY(c.open);
      const closeY = getY(c.close);
      const highY = getY(c.high);
      const lowY = getY(c.low);
      const isUp = c.close >= c.open;

      const color = isUp ? '#10b981' : '#f43f5e';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;

      // Wick
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, highY);
      ctx.lineTo(x, lowY);
      ctx.stroke();

      // Body
      const top = Math.min(openY, closeY);
      const bodyHeight = Math.max(2, Math.abs(openY - closeY));
      ctx.fillRect(x - candleWidth / 2, top, candleWidth, bodyHeight);

      // Indicator 2: Heavy Absorption Overlay Badge on latest candle
      if (idx === candleCount - 1 && signal && signal.absorption && signal.absorption.isAbsorptionDetected) {
        const isBullAbs = signal.absorption.type === 'BULLISH_ABSORPTION';
        const badgeY = isBullAbs ? lowY + 12 : highY - 12;

        ctx.fillStyle = isBullAbs ? '#10b981' : '#f43f5e';
        ctx.beginPath();
        ctx.arc(x, badgeY, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('A', x, badgeY + 3);
        ctx.textAlign = 'left';
      }
    });

    // 6. Draw Dynamic TP & SL targets
    const tpPrice = activePosition ? activePosition.takeProfit : signal?.tpPrice;
    const slPrice = activePosition ? activePosition.stopLoss : signal?.slPrice;

    if (tpPrice) {
      const tpY = getY(tpPrice);
      ctx.strokeStyle = '#34d399';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(padding.left, tpY);
      ctx.lineTo(width - padding.right, tpY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#34d399';
      ctx.fillText(`TP: $${formatCryptoPrice(tpPrice)}`, width - padding.right + 6, tpY - 2);
    }

    if (slPrice) {
      const slY = getY(slPrice);
      ctx.strokeStyle = '#fb7185';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(padding.left, slY);
      ctx.lineTo(width - padding.right, slY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#fb7185';
      ctx.fillText(`SL: $${formatCryptoPrice(slPrice)}`, width - padding.right + 6, slY + 11);
    }

    // Entry Price line if position is active
    if (activePosition) {
      const entryY = getY(activePosition.entryPrice);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padding.left, entryY);
      ctx.lineTo(width - padding.right, entryY);
      ctx.stroke();

      ctx.fillStyle = '#38bdf8';
      ctx.fillText(`Entry: $${formatCryptoPrice(activePosition.entryPrice)}`, width - padding.right + 6, entryY - 2);
    }
  }, [candles, signal, activePosition]);

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && canvasRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        canvasRef.current.width = rect.width;
        canvasRef.current.height = 340;
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const latestCandle = candles[candles.length - 1];

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-4">
      {/* Chart Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold text-slate-100">{symbol}</span>
            <span className="px-2 py-0.5 text-[11px] font-mono font-medium rounded bg-indigo-950/70 text-indigo-300 border border-indigo-800/50">
              5m Candle Order Flow
            </span>
          </div>

          {latestCandle && (
            <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
              <span>
                O: <strong className="text-slate-200">${formatCryptoPrice(latestCandle.open)}</strong>
              </span>
              <span>
                H: <strong className="text-emerald-400">${formatCryptoPrice(latestCandle.high)}</strong>
              </span>
              <span>
                L: <strong className="text-rose-400">${formatCryptoPrice(latestCandle.low)}</strong>
              </span>
              <span>
                C: <strong className="text-slate-200">${formatCryptoPrice(latestCandle.close)}</strong>
              </span>
            </div>
          )}
        </div>

        {/* 3 Indicators Pill Bar */}
        <div className="flex items-center gap-2 text-xs font-mono">
          {signal && (
            <>
              <span className="px-2 py-0.5 rounded text-[11px] font-semibold text-amber-300 bg-amber-950/60 border border-amber-800/50">
                POC: ${formatCryptoPrice(signal.hvnProfile.pocPrice)}
              </span>

              <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                signal.absorption.isAbsorptionDetected
                  ? 'text-emerald-300 bg-emerald-950/80 border border-emerald-700/60'
                  : 'text-slate-400 bg-slate-800'
              }`}>
                Absorption: {signal.absorption.isAbsorptionDetected ? `${signal.absorption.absorptionScore}%` : 'None'}
              </span>

              <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                signal.imbalance.isImbalanceDetected
                  ? 'text-indigo-300 bg-indigo-950/80 border border-indigo-700/60'
                  : 'text-slate-400 bg-slate-800'
              }`}>
                Imbalance: {signal.imbalance.isImbalanceDetected ? `${signal.imbalance.maxImbalanceRatio}x` : 'Balanced'}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Canvas Viewport */}
      <div ref={containerRef} className="w-full h-[340px] relative mt-2">
        <canvas ref={canvasRef} className="w-full h-full block" />
      </div>

      {/* Legend & Indicator Guide */}
      <div className="flex flex-wrap items-center justify-between gap-4 pt-3 border-t border-slate-800 text-[11px] text-slate-400 font-mono">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-2 bg-amber-500/80 inline-block rounded-xs" />
            HVN Point of Control (POC)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 bg-emerald-500 rounded-full inline-block" />
            Heavy Absorption
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-2 bg-indigo-500/50 inline-block rounded-xs" />
            3:1 Imbalance Zone
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 border-t border-dashed border-emerald-400 inline-block" />
            Dynamic TP
          </span>
        </div>
        <span className="text-slate-500">Scan interval: 15s · Leverage: 10x</span>
      </div>
    </div>
  );
}
