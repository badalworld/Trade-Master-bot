'use client';

import React, { useRef, useEffect, useState, useMemo } from 'react';
import { Activity, Target, ShieldAlert, Radar, BarChart2 } from 'lucide-react';
import type { Candle, SignalEvaluation, TradePosition } from '@/lib/trading-engine';
import { formatCryptoPrice } from '@/lib/utils';

interface InteractiveChartProps {
  symbol: string;
  candles: Candle[];
  signal?: SignalEvaluation;
  activePosition?: TradePosition;
  availableSymbols?: string[];
  onSelectSymbol?: (symbol: string) => void;
  leverage?: number;
  scanIntervalSeconds?: number;
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function InteractiveChart({
  symbol,
  candles,
  signal,
  activePosition,
  availableSymbols = [],
  onSelectSymbol,
  leverage = 10,
  scanIntervalSeconds = 15,
}: InteractiveChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [chartType, setChartType] = useState<'candles' | 'morph'>('candles');
  const [morphTarget, setMorphTarget] = useState<'line' | 'radar'>('radar');
  const [morphT, setMorphT] = useState<number>(0);

  // Auto-morph cycle when in 'morph' view
  useEffect(() => {
    if (chartType !== 'morph') return;
    const interval = setInterval(() => {
      setMorphTarget((prev) => (prev === 'line' ? 'radar' : 'line'));
    }, 3000);
    return () => clearInterval(interval);
  }, [chartType]);

  useEffect(() => {
    if (chartType !== 'morph') return;
    const target = morphTarget === 'radar' ? 1 : 0;
    const startT = morphT;
    const diff = target - startT;
    if (Math.abs(diff) < 0.001) return;

    let rafId: number;
    const duration = 1000;
    const startTime = performance.now();

    const step = (now: number) => {
      const elapsed = Math.min(1, (now - startTime) / duration);
      setMorphT(startT + diff * easeInOutCubic(elapsed));
      if (elapsed < 1) {
        rafId = requestAnimationFrame(step);
      }
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [morphTarget, chartType]);

  useEffect(() => {
    if (chartType !== 'candles') return;
    const canvas = canvasRef.current;
    if (!canvas || candles.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width > 0 && canvas.width !== Math.floor(rect.width)) {
        canvas.width = Math.floor(rect.width);
        canvas.height = 340;
      }
    }

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const padding = { top: 25, right: 130, bottom: 36, left: 15 };
    const chartWidth = Math.max(100, width - padding.left - padding.right);
    const chartHeight = height - padding.top - padding.bottom;
    const priceChartHeight = chartHeight * 0.76;
    const volumeChartHeight = chartHeight * 0.2;
    const volumeTop = padding.top + priceChartHeight + chartHeight * 0.04;

    const tpPrice = activePosition ? activePosition.takeProfit : signal?.tpPrice;
    const slPrice = activePosition ? activePosition.stopLoss : signal?.slPrice;

    const candleHighs = candles.map((c) => c.high);
    const candleLows = candles.map((c) => c.low);
    if (tpPrice && tpPrice > 0) {
      candleHighs.push(tpPrice);
      candleLows.push(tpPrice);
    }
    if (slPrice && slPrice > 0) {
      candleHighs.push(slPrice);
      candleLows.push(slPrice);
    }

    const candleMin = Math.min(...candleLows);
    const candleMax = Math.max(...candleHighs);
    const spread = candleMax - candleMin || candleMax * 0.01 || 1e-6;

    const minPrice = Math.max(0, candleMin - spread * 0.1);
    const maxPrice = candleMax + spread * 0.1;
    const priceRange = maxPrice - minPrice || 1e-6;

    const maxVolume = Math.max(...candles.map((c) => c.volume)) || 1;

    const getY = (price: number) =>
      padding.top + priceChartHeight - ((price - minPrice) / priceRange) * priceChartHeight;

    const candleCount = candles.length;
    const candleWidth = Math.max(4, (chartWidth / candleCount) * 0.7);
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
      const profileMaxBarWidth = 65;

      signal.hvnProfile.nodes.forEach((node) => {
        const y = getY(node.priceLevel);
        const barW = (node.volume / profileMaxVol) * profileMaxBarWidth;
        const x = width - padding.right;

        ctx.fillStyle = node.isPOC
          ? 'rgba(245, 158, 11, 0.45)'
          : node.isHVN
          ? 'rgba(56, 189, 248, 0.35)'
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
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padding.left, pocY);
      ctx.lineTo(width - padding.right, pocY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(
        `POC: $${formatCryptoPrice(signal.hvnProfile.pocPrice)}`,
        width - padding.right + 6,
        pocY - 3
      );
    }

    // 3. Draw Indicator 3: Stacked Imbalance Levels Highlight
    if (signal && signal.imbalance && signal.imbalance.imbalancePriceLevels.length > 0) {
      const isBuyImb = signal.imbalance.type === 'BUY_IMBALANCE';
      ctx.fillStyle = isBuyImb ? 'rgba(16, 185, 129, 0.14)' : 'rgba(244, 63, 94, 0.14)';

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

      ctx.fillStyle = isUp ? 'rgba(16, 185, 129, 0.28)' : 'rgba(244, 63, 94, 0.28)';
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
      if (
        idx === candleCount - 1 &&
        signal &&
        signal.absorption &&
        signal.absorption.isAbsorptionDetected
      ) {
        const isBullAbs = signal.absorption.type === 'BULLISH_ABSORPTION';
        const badgeY = isBullAbs ? lowY + 12 : highY - 12;

        ctx.fillStyle = isBullAbs ? '#10b981' : '#f43f5e';
        ctx.beginPath();
        ctx.arc(x, badgeY, 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('A', x, badgeY + 3);
        ctx.textAlign = 'left';
      }
    });

    // 6. Draw Indicator-Driven Dynamic TP & SL targets
    if (tpPrice && tpPrice > 0) {
      const tpY = getY(tpPrice);
      ctx.strokeStyle = '#34d399';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(padding.left, tpY);
      ctx.lineTo(width - padding.right, tpY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#34d399';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(`TP: $${formatCryptoPrice(tpPrice)}`, width - padding.right + 6, tpY - 3);
    }

    if (slPrice && slPrice > 0) {
      const slY = getY(slPrice);
      ctx.strokeStyle = '#fb7185';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(padding.left, slY);
      ctx.lineTo(width - padding.right, slY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#fb7185';
      ctx.font = 'bold 10px monospace';
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
      ctx.font = 'bold 10px monospace';
      ctx.fillText(
        `Entry: $${formatCryptoPrice(activePosition.entryPrice)}`,
        width - padding.right + 6,
        entryY - 3
      );
    }
  }, [candles, signal, activePosition, chartType]);

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && canvasRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        canvasRef.current.width = Math.floor(rect.width);
        canvasRef.current.height = 340;
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Build 6-vertex Morph Line-to-Radar telemetry for the selected symbol
  const symbolMorphVertices = useMemo(() => {
    const w = 960;
    const h = 300;
    const cx = w / 2;
    const cy = h / 2 + 4;
    const maxR = 110;
    const left = 80;
    const right = w - 80;
    const top = 36;
    const bottom = h - 40;

    // 6 normalized candle closes for Line state
    let lineNorms = [0.45, 0.52, 0.48, 0.64, 0.59, 0.76];
    if (candles.length >= 6) {
      const recent6 = candles.slice(-6).map((c) => c.close);
      const minC = Math.min(...recent6);
      const maxC = Math.max(...recent6);
      const span = maxC - minC || 1;
      lineNorms = recent6.map((v) => Math.min(0.92, Math.max(0.2, (v - minC) / span)));
    }

    // 6 normalized Radar axes from SignalEvaluation
    const hvnVal =
      signal?.hvnProfile.priceRelation === 'ABOVE_POC' ||
      signal?.hvnProfile.priceRelation === 'BELOW_POC'
        ? 0.88
        : 0.65;
    const absVal = signal?.absorption.isAbsorptionDetected
      ? Math.max(0.6, (signal.absorption.absorptionScore || 75) / 100)
      : 0.55;
    const imbVal = signal?.imbalance.isImbalanceDetected
      ? Math.min(0.96, (signal.imbalance.maxImbalanceRatio || 3) / 4)
      : 0.58;
    const scoreVal = signal ? Math.max(0.45, signal.score / 100) : 0.72;
    const volVal = signal ? Math.min(0.95, Math.max(0.45, (signal.volatilityScore || 65) / 100)) : 0.7;
    const rrVal = signal ? Math.min(0.95, Math.max(0.5, (signal.riskRewardRatio || 1.67) / 2.2)) : 0.8;

    const radarNorms = [hvnVal, absVal, imbVal, scoreVal, volVal, rrVal];
    const labels = [
      'HVN POC',
      'ABSORPTION',
      '3:1 IMBALANCE',
      'SIGNAL SCORE',
      'VOLATILITY',
      'R:R TARGET',
    ];

    return Array.from({ length: 6 }, (_, i) => {
      const lx = left + (i / 5) * (right - left);
      const ly = bottom - lineNorms[i] * (bottom - top);
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 6;
      const r = radarNorms[i] * maxR;
      const rx = cx + Math.cos(angle) * r;
      const ry = cy + Math.sin(angle) * r;

      const outerRx = cx + Math.cos(angle) * maxR;
      const outerRy = cy + Math.sin(angle) * maxR;
      const labelRx = cx + Math.cos(angle) * (maxR + 26);
      const labelRy = cy + Math.sin(angle) * (maxR + 26);

      return {
        x: (1 - morphT) * lx + morphT * rx,
        y: (1 - morphT) * ly + morphT * ry,
        spokeX1: (1 - morphT) * lx + morphT * cx,
        spokeY1: (1 - morphT) * bottom + morphT * cy,
        spokeX2: (1 - morphT) * lx + morphT * outerRx,
        spokeY2: (1 - morphT) * top + morphT * outerRy,
        labelX: (1 - morphT) * lx + morphT * labelRx,
        labelY: (1 - morphT) * (bottom + 20) + morphT * labelRy,
        label: labels[i],
        pct: Math.round(((1 - morphT) * lineNorms[i] + morphT * radarNorms[i]) * 100),
      };
    });
  }, [candles, morphT, signal]);

  const latestCandle = candles[candles.length - 1];

  return (
    <div className="neon-section">
      <div className="neon-section-inner p-4 space-y-3">
        {/* Chart Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-400" />
              <span className="text-base font-bold text-slate-100 font-mono">{symbol}</span>
              <span className="px-2 py-0.5 text-[11px] font-mono font-medium rounded bg-cyan-950/70 text-cyan-300 border border-cyan-800/50">
                5m Order Flow + HVN Profile
              </span>
            </div>

            {latestCandle && (
              <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-slate-400">
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
                  C: <strong className="text-slate-100">${formatCryptoPrice(latestCandle.close)}</strong>
                </span>
              </div>
            )}
          </div>

          {/* Chart Mode Switcher (5m Candlesticks vs Line-to-Radar Morph) */}
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
            <div className="inline-flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800">
              <button
                type="button"
                onClick={() => setChartType('candles')}
                className={`interactive-glow-btn px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-all ${
                  chartType === 'candles'
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-[0_0_8px_rgba(0,240,255,0.4)]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <BarChart2 className="w-3 h-3" />
                5m Order Flow
              </button>
              <button
                type="button"
                onClick={() => setChartType('morph')}
                className={`interactive-glow-btn px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-all ${
                  chartType === 'morph'
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-[0_0_8px_rgba(0,240,255,0.4)]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Radar className="w-3 h-3" />
                Line ⇄ Radar Morph
              </button>
            </div>
          </div>
        </div>

        {/* Quick Pair Switcher Pills */}
        {availableSymbols.length > 0 && onSelectSymbol && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            {availableSymbols.map((sym) => (
              <button
                key={sym}
                type="button"
                onClick={() => onSelectSymbol(sym)}
                className={`interactive-glow-btn px-2.5 py-1 rounded text-[11px] font-mono font-medium transition-all shrink-0 ${
                  sym === symbol
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-[0_0_8px_rgba(0,240,255,0.4)]'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                {sym}
              </button>
            ))}
          </div>
        )}

        {/* Viewport: Either 5m Candlestick Canvas OR Morphing Line-to-Radar SVG */}
        <div
          ref={containerRef}
          className="w-full h-[340px] relative bg-slate-950/80 rounded-lg border border-slate-800/80 overflow-hidden flex items-center justify-center"
        >
          {chartType === 'morph' ? (
            <svg
              className="w-full h-full overflow-visible p-2"
              viewBox="0 0 960 300"
              preserveAspectRatio="xMidYMid meet"
            >
              <defs>
                <linearGradient id="symMorphGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#00f0ff" stopOpacity="0.32" />
                  <stop offset="100%" stopColor="#34d399" stopOpacity="0.08" />
                </linearGradient>
              </defs>

              {symbolMorphVertices.map((v, i) => (
                <line
                  key={i}
                  x1={v.spokeX1}
                  y1={v.spokeY1}
                  x2={v.spokeX2}
                  y2={v.spokeY2}
                  stroke="rgba(56, 189, 248, 0.25)"
                  strokeDasharray="3 3"
                />
              ))}

              <polygon
                points={symbolMorphVertices.map((v) => `${v.x},${v.y}`).join(' ')}
                fill="url(#symMorphGrad)"
              />

              <polyline
                fill="none"
                stroke="#00f0ff"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={[
                  ...symbolMorphVertices.map((v) => `${v.x},${v.y}`),
                  ...(morphT > 0.05
                    ? [`${symbolMorphVertices[0].x},${symbolMorphVertices[0].y}`]
                    : []),
                ].join(' ')}
              />

              {symbolMorphVertices.map((v, i) => (
                <g key={i}>
                  <circle cx={v.x} cy={v.y} r="5" fill="#00f0ff" />
                  <text
                    x={v.labelX}
                    y={v.labelY}
                    textAnchor="middle"
                    fill="#cbd5e1"
                    fontSize="11"
                    fontFamily="monospace"
                    fontWeight="bold"
                  >
                    {v.label} ({v.pct}%)
                  </text>
                </g>
              ))}
            </svg>
          ) : candles.length === 0 ? (
            <div className="w-full h-full flex flex-col items-center justify-center text-center p-6">
              <Activity className="w-6 h-6 text-cyan-400/60 mb-2 animate-pulse" />
              <p className="text-xs font-mono text-slate-400">
                Select a pair or start the scanner to stream live 5m Binance Futures klines & Volume Profile for{' '}
                <strong className="text-cyan-300">{symbol}</strong>, or switch to{' '}
                <button
                  type="button"
                  onClick={() => setChartType('morph')}
                  className="text-cyan-300 underline font-bold"
                >
                  Line ⇄ Radar Morph
                </button>{' '}
                above.
              </p>
            </div>
          ) : (
            <canvas ref={canvasRef} className="w-full h-full block" />
          )}
        </div>

        {/* Indicator Convergence Reasons & Target Breakdown */}
        {signal && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 pt-1 text-xs font-mono">
            <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-2.5 flex items-center justify-between">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5 text-emerald-400" />
                Indicator TP Target:
              </span>
              <span className="text-emerald-400 font-bold">${formatCryptoPrice(signal.tpPrice)}</span>
            </div>
            <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-2.5 flex items-center justify-between">
              <span className="text-slate-400 flex items-center gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                Indicator SL Support:
              </span>
              <span className="text-rose-400 font-bold">${formatCryptoPrice(signal.slPrice)}</span>
            </div>
            <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-2.5 flex items-center justify-between">
              <span className="text-slate-400">Value Area (VAL – VAH):</span>
              <span className="text-cyan-300 font-semibold">
                ${formatCryptoPrice(signal.hvnProfile.valueAreaLow)} – ${formatCryptoPrice(signal.hvnProfile.valueAreaHigh)}
              </span>
            </div>
          </div>
        )}

        {/* Legend & Indicator Guide */}
        <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-800 text-[11px] text-slate-400 font-mono">
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 bg-amber-500/80 inline-block rounded-xs" />
              HVN Point of Control (POC)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 bg-emerald-500 rounded-full inline-block" />
              Heavy Absorption (A)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 bg-emerald-500/40 inline-block rounded-xs" />
              3:1 Stacked Imbalance
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 border-t border-dashed border-emerald-400 inline-block" />
              Indicator Dynamic TP / SL
            </span>
          </div>
          <span className="text-slate-500">
            Scan interval: {scanIntervalSeconds}s · Leverage: {leverage}x Isolated
          </span>
        </div>
      </div>
    </div>
  );
}
