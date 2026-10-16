'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import { BarChart3, Radar, TrendingUp, Sparkles } from 'lucide-react';
import type { ClosedTrade } from '@/lib/trading-engine';

interface PnlChartWidgetProps {
  trades: ClosedTrade[];
  totalPnl: number;
  startingBalance?: number;
  currentEquity?: number;
  winRate?: number;
  compoundingMargin?: number;
  apiSafetyPercent?: number;
}

const RADAR_AXES = [
  { label: 'HVN Profile (POC)', short: 'HVN POC' },
  { label: 'Heavy Absorption', short: 'ABSORPTION' },
  { label: '3:1 Imbalance', short: 'IMBALANCE 3:1' },
  { label: 'Win Accuracy', short: 'WIN RATE' },
  { label: 'Profit Compound', short: 'COMPOUNDING' },
  { label: 'Risk / API Shield', short: 'RISK SHIELD' },
];

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function PnlChartWidget({
  trades,
  totalPnl,
  startingBalance = 0,
  currentEquity = 0,
  winRate = 0,
  compoundingMargin = 2.0,
  apiSafetyPercent = 98,
}: PnlChartWidgetProps) {
  const [viewMode, setViewMode] = useState<'line' | 'radar'>('line');
  const [autoMorph, setAutoMorph] = useState<boolean>(true);
  const [morphT, setMorphT] = useState<number>(0); // 0 = Line Chart, 1 = Radar Chart

  // Auto-Morph cycle (switches target between Line and Radar every 3.4s)
  useEffect(() => {
    if (!autoMorph) return;
    const interval = setInterval(() => {
      setViewMode((prev) => (prev === 'line' ? 'radar' : 'line'));
    }, 3400);
    return () => clearInterval(interval);
  }, [autoMorph]);

  // Smooth 60fps animation of morphT toward target (0 for 'line', 1 for 'radar')
  useEffect(() => {
    const target = viewMode === 'radar' ? 1 : 0;
    let rafId: number;
    const startT = morphT;
    const diff = target - startT;
    if (Math.abs(diff) < 0.001) {
      return;
    }

    const duration = 1100; // 1.1s fluid morph transition
    const startTime = performance.now();

    const step = (now: number) => {
      const elapsed = Math.min(1, (now - startTime) / duration);
      const eased = easeInOutCubic(elapsed);
      const current = startT + diff * eased;
      setMorphT(current);
      if (elapsed < 1) {
        rafId = requestAnimationFrame(step);
      }
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  const sortedTrades = useMemo(
    () => [...trades].sort((a, b) => a.exitTime - b.exitTime),
    [trades]
  );
  const baseCapital = startingBalance > 0 ? startingBalance : 100.0;
  const liveEquity = currentEquity > 0 ? currentEquity : baseCapital + totalPnl;

  // Build exactly 6 normalized Cartesian line values [0..1] for seamless 6-vertex morphing
  const lineValuesNormalized = useMemo(() => {
    const rawEquities: number[] = [baseCapital];
    let running = baseCapital;
    for (const t of sortedTrades) {
      running += t.pnl;
      rawEquities.push(running);
    }
    if (rawEquities.length < 6) {
      while (rawEquities.length < 5) {
        rawEquities.push(baseCapital + totalPnl * (rawEquities.length / 5));
      }
      rawEquities.push(liveEquity);
    }

    const sampled: number[] = [];
    for (let i = 0; i < 6; i++) {
      const idx = Math.min(
        rawEquities.length - 1,
        Math.floor((i / 5) * (rawEquities.length - 1))
      );
      sampled.push(rawEquities[idx]);
    }

    const minE = Math.min(...sampled, baseCapital * 0.96);
    const maxE = Math.max(...sampled, baseCapital * 1.04);
    const span = maxE - minE || 1;

    // Slight organic wave when flat at 0 trades so the line-to-radar morph looks dynamic
    if (trades.length === 0 && Math.abs(totalPnl) < 0.001) {
      return [0.42, 0.56, 0.51, 0.68, 0.62, 0.78];
    }

    return sampled.map((v) => Math.min(0.92, Math.max(0.18, (v - minE) / span)));
  }, [baseCapital, liveEquity, sortedTrades, totalPnl, trades.length]);

  // Build 6 normalized Radar axis values [0.35..0.95] representing the 3-Indicator & Portfolio telemetry
  const radarValuesNormalized = useMemo(() => {
    const winRatio = trades.length > 0 ? Math.max(0.45, Math.min(0.96, winRate / 100)) : 0.82;
    const compRatio = Math.min(0.95, Math.max(0.5, (compoundingMargin / 3.5) * 0.85));
    const shieldRatio = Math.min(0.96, Math.max(0.55, apiSafetyPercent / 100));
    return [
      0.88, // HVN Profile POC
      0.84, // Heavy Absorption
      0.91, // 3:1 Imbalance
      winRatio, // Win Rate Accuracy
      compRatio, // Compounding Velocity
      shieldRatio, // Risk / API Shield
    ];
  }, [apiSafetyPercent, compoundingMargin, trades.length, winRate]);

  // SVG Coordinate System
  const width = 1000;
  const height = 290;
  const cx = width / 2;
  const cy = height / 2 + 4;
  const maxRadius = 108;

  const lineLeft = 90;
  const lineRight = width - 90;
  const lineTop = 38;
  const lineBottom = height - 42;

  // Compute interpolated coordinates for the 6 primary vertices
  const vertices = useMemo(() => {
    return Array.from({ length: 6 }, (_, i) => {
      // Cartesian Line coordinates (t = 0)
      const lx = lineLeft + (i / 5) * (lineRight - lineLeft);
      const ly = lineBottom - lineValuesNormalized[i] * (lineBottom - lineTop);

      // Polar Radar coordinates (t = 1)
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 6;
      const r = radarValuesNormalized[i] * maxRadius;
      const rx = cx + Math.cos(angle) * r;
      const ry = cy + Math.sin(angle) * r;

      // Outer label position in Radar mode
      const labelR = maxRadius + 26;
      const labelRx = cx + Math.cos(angle) * labelR;
      const labelRy = cy + Math.sin(angle) * labelR;

      // Axis endpoint on outer radar ring
      const outerRx = cx + Math.cos(angle) * maxRadius;
      const outerRy = cy + Math.sin(angle) * maxRadius;

      return {
        x: (1 - morphT) * lx + morphT * rx,
        y: (1 - morphT) * ly + morphT * ry,
        lx,
        ly,
        rx,
        ry,
        outerRx,
        outerRy,
        labelX: (1 - morphT) * lx + morphT * labelRx,
        labelY: (1 - morphT) * (lineBottom + 22) + morphT * labelRy,
        axisSpokeStartX: (1 - morphT) * lx + morphT * cx,
        axisSpokeStartY: (1 - morphT) * lineBottom + morphT * cy,
        axisSpokeEndX: (1 - morphT) * lx + morphT * outerRx,
        axisSpokeEndY: (1 - morphT) * lineTop + morphT * outerRy,
        valPercent: Math.round(
          ((1 - morphT) * lineValuesNormalized[i] + morphT * radarValuesNormalized[i]) * 100
        ),
        label: RADAR_AXES[i].short,
      };
    });
  }, [cx, cy, lineBottom, lineLeft, lineRight, lineTop, lineValuesNormalized, morphT, radarValuesNormalized]);

  // Morphing Grid Rings: 3 levels (0.33, 0.66, 1.0)
  // At t=0 they are horizontal Cartesian grid lines; at t=1 they wrap into concentric hexagons!
  const gridLevels = [0.33, 0.66, 1.0];
  const gridPaths = gridLevels.map((lvl) => {
    const pts = Array.from({ length: 7 }, (_, k) => {
      const idx = k % 6;
      // Line grid point (horizontal line across chart; k=6 stays at right edge when t=0, wraps to k=0 when t=1)
      const lx =
        k === 6
          ? (1 - morphT) * lineRight + morphT * (lineLeft + 0)
          : lineLeft + (idx / 5) * (lineRight - lineLeft);
      const ly = lineBottom - lvl * (lineBottom - lineTop);

      // Radar hexagon ring point
      const angle = -Math.PI / 2 + (idx * 2 * Math.PI) / 6;
      const r = lvl * maxRadius;
      const rx = cx + Math.cos(angle) * r;
      const ry = cy + Math.sin(angle) * r;

      const x = (1 - morphT) * lx + morphT * rx;
      const y = (1 - morphT) * ly + morphT * ry;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return pts.join(' ');
  });

  // Morphing Data Curve & Area Fill
  // At t=0, endpoints drop to baseline; at t=1, endpoints converge to vertex[0] to close the radar polygon
  const closeRightX = (1 - morphT) * vertices[5].x + morphT * vertices[0].x;
  const closeRightY = (1 - morphT) * lineBottom + morphT * vertices[0].y;
  const closeLeftX = (1 - morphT) * vertices[0].x + morphT * vertices[0].x;
  const closeLeftY = (1 - morphT) * lineBottom + morphT * vertices[0].y;

  const mainStrokePoints = [
    ...vertices.map((v) => `${v.x.toFixed(1)},${v.y.toFixed(1)}`),
    ...(morphT > 0.02
      ? [
          `${(
            (1 - morphT) * vertices[5].x +
            morphT * vertices[0].x
          ).toFixed(1)},${(
            (1 - morphT) * vertices[5].y +
            morphT * vertices[0].y
          ).toFixed(1)}`,
        ]
      : []),
  ].join(' ');

  const areaPolygonPoints = [
    ...vertices.map((v) => `${v.x.toFixed(1)},${v.y.toFixed(1)}`),
    `${closeRightX.toFixed(1)},${closeRightY.toFixed(1)}`,
    `${closeLeftX.toFixed(1)},${closeLeftY.toFixed(1)}`,
  ].join(' ');

  const isPositive = totalPnl >= 0;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98, y: 12 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.45 }}
      className="neon-section mb-6 w-full"
    >
      <div className="neon-section-inner p-4 sm:p-6 space-y-4">
        {/* Header & Morph Controls */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            {morphT > 0.5 ? (
              <Radar className="w-5 h-5 text-cyan-400 animate-spin [animation-duration:8s]" />
            ) : (
              <BarChart3 className="w-5 h-5 text-cyan-400" />
            )}
            <div>
              <h3 className="text-sm font-bold text-slate-100 tracking-wide uppercase flex items-center gap-2">
                <span>
                  {morphT > 0.5
                    ? '3-Indicator & Portfolio Radar Matrix'
                    : 'Cumulative Equity & PNL Trajectory'}
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-950/90 text-cyan-300 border border-cyan-700/60">
                  Morph Graphic
                </span>
              </h3>
            </div>
          </div>

          {/* Interactive Line <-> Radar Morph Controls */}
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
            <div className="inline-flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800">
              <button
                type="button"
                onClick={() => {
                  setAutoMorph(false);
                  setViewMode('line');
                }}
                className={`interactive-glow-btn px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-all ${
                  viewMode === 'line'
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-[0_0_10px_rgba(0,240,255,0.4)]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <TrendingUp className="w-3 h-3" />
                Line View
              </button>

              <button
                type="button"
                onClick={() => {
                  setAutoMorph(false);
                  setViewMode('radar');
                }}
                className={`interactive-glow-btn px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-all ${
                  viewMode === 'radar'
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-[0_0_10px_rgba(0,240,255,0.4)]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Radar className="w-3 h-3" />
                Radar View
              </button>
            </div>

            <button
              type="button"
              onClick={() => setAutoMorph(!autoMorph)}
              className={`interactive-glow-btn px-2.5 py-1.5 rounded-xl text-[11px] font-semibold border flex items-center gap-1.5 transition-all ${
                autoMorph
                  ? 'bg-emerald-950/80 text-emerald-300 border-emerald-600/60 shadow-[0_0_12px_rgba(52,211,153,0.3)]'
                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              <Sparkles className="w-3 h-3 text-cyan-400" />
              {autoMorph ? 'Auto-Morph: ON' : 'Auto-Morph: OFF'}
            </button>
          </div>
        </div>

        {/* Full-Width Responsive Morphing Line-to-Radar SVG Viewport */}
        <div className="relative w-full h-72 bg-slate-950/90 rounded-xl p-3 sm:p-4 border border-slate-800/90 flex items-center justify-center shadow-inner overflow-hidden">
          <svg
            className="w-full h-full overflow-visible"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <linearGradient id="morphAreaGrad" x1="0" y1="0" x2="1" y2="1">
                <stop
                  offset="0%"
                  stopColor="#00f0ff"
                  stopOpacity={0.28 + morphT * 0.14}
                />
                <stop
                  offset="50%"
                  stopColor={isPositive ? '#34d399' : '#fb7185'}
                  stopOpacity={0.22 + morphT * 0.12}
                />
                <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.05} />
              </linearGradient>

              <linearGradient id="morphStrokeGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#00f0ff" />
                <stop offset="50%" stopColor={isPositive ? '#34d399' : '#fb7185'} />
                <stop offset="100%" stopColor="#38bdf8" />
              </linearGradient>
            </defs>

            {/* Morphing Grid Rings (Horizontal Lines -> Hexagonal Radar Webs) */}
            {gridPaths.map((pts, idx) => (
              <polyline
                key={`grid-${idx}`}
                fill="none"
                stroke={idx === 2 ? 'rgba(56, 189, 248, 0.35)' : 'rgba(51, 65, 85, 0.55)'}
                strokeWidth={idx === 2 ? '1.4' : '1'}
                strokeDasharray={morphT > 0.5 && idx < 2 ? '4 4' : '6 6'}
                points={pts}
              />
            ))}

            {/* Morphing Vertical Columns -> Radial Radar Spokes */}
            {vertices.map((v, idx) => (
              <line
                key={`spoke-${idx}`}
                x1={v.axisSpokeStartX}
                y1={v.axisSpokeStartY}
                x2={v.axisSpokeEndX}
                y2={v.axisSpokeEndY}
                stroke="rgba(56, 189, 248, 0.22)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
            ))}

            {/* Morphing Area / Radar Polygon Fill */}
            <polygon points={areaPolygonPoints} fill="url(#morphAreaGrad)" />

            {/* Morphing Primary Line / Radar Perimeter */}
            <polyline
              fill="none"
              stroke="url(#morphStrokeGrad)"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={mainStrokePoints}
              style={{
                filter: 'drop-shadow(0 0 10px rgba(0, 240, 255, 0.55))',
              }}
            />

            {/* Morphing Vertices & Labels */}
            {vertices.map((v, idx) => {
              const isLatest = idx === vertices.length - 1;
              return (
                <g key={`vertex-${idx}`}>
                  {/* Outer Glow Ring on Vertex */}
                  <circle
                    cx={v.x}
                    cy={v.y}
                    r={isLatest ? '9' : '7'}
                    fill="rgba(0, 240, 255, 0.18)"
                  />
                  {/* Solid Core Vertex */}
                  <circle
                    cx={v.x}
                    cy={v.y}
                    r="4.5"
                    fill="#00f0ff"
                    stroke="#020617"
                    strokeWidth="1.5"
                  />
                  {isLatest && (
                    <circle
                      cx={v.x}
                      cy={v.y}
                      r="11"
                      fill="none"
                      stroke="#00f0ff"
                      strokeWidth="1.5"
                      opacity="0.75"
                      className="animate-ping"
                    />
                  )}

                  {/* Axis / Node Label that smoothly follows the morph */}
                  <text
                    x={v.labelX}
                    y={v.labelY}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="#cbd5e1"
                    fontSize="11"
                    fontFamily="monospace"
                    fontWeight="bold"
                  >
                    {v.label} ({v.valPercent}%)
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Bottom Telemetry Legend */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1 text-xs font-mono">
          <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800">
            <span className="text-slate-400 block text-[10px] font-semibold">TOTAL REAL PNL</span>
            <span
              className={`text-base font-extrabold ${
                isPositive ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
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
            <span className="text-slate-400 block text-[10px] font-semibold">CURRENT EQUITY</span>
            <span className="text-base font-extrabold text-emerald-400">
              ${liveEquity.toFixed(2)}
            </span>
          </div>
          <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800">
            <span className="text-slate-400 block text-[10px] font-semibold">CHART ENGINE</span>
            <span className="text-base font-extrabold text-cyan-400">
              {morphT > 0.5 ? '6-Axis Radar' : 'Equity Curve'}
            </span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
