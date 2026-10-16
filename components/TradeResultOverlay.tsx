'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  TrendingUp,
  TrendingDown,
  ShieldAlert,
  Sparkles,
  Zap,
  CheckCircle2,
  X,
  Volume2,
  VolumeX,
} from 'lucide-react';

export interface TradeResultPayload {
  isOpen: boolean;
  isProfit: boolean;
  pnl: number;
  pnlPercent: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  reason?: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL_CLOSE';
  compoundingBonus?: number;
}

interface TradeResultOverlayProps {
  result: TradeResultPayload | null;
  onClose: () => void;
}

// Browser Web Audio chime synthesizer (zero external dependencies)
function playTradeSound(isProfit: boolean) {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    if (isProfit) {
      // Ascending major chord celebration chime
      const freqs = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.12);
        gain.gain.setValueAtTime(0.001, ctx.currentTime + idx * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + idx * 0.12 + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.12 + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.12);
        osc.stop(ctx.currentTime + idx * 0.12 + 0.5);
      });
    } else {
      // Somber soft descending tone
      const freqs = [293.66, 246.94, 220.0]; // D4, B3, A3
      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.18);
        gain.gain.setValueAtTime(0.001, ctx.currentTime + idx * 0.18);
        gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + idx * 0.18 + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.18 + 0.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.18);
        osc.stop(ctx.currentTime + idx * 0.18 + 0.6);
      });
    }
  } catch {
    // Audio context may be blocked by autoplay policies
  }
}

const CELEBRATION_PARTICLES = Array.from({ length: 24 }).map((_, i) => {
  const angle = (i / 24) * 2 * Math.PI;
  const dist = 120 + ((i * 37) % 240);
  return {
    id: i,
    x: Math.cos(angle) * dist,
    y: Math.sin(angle) * dist,
    scale: 0.4 + ((i * 13) % 60) / 100,
    rotation: (i * 45) % 360,
    delay: ((i * 7) % 30) / 100,
  };
});

export function TradeResultOverlay({ result, onClose }: TradeResultOverlayProps) {
  const [soundEnabled, setSoundEnabled] = useState(true);

  useEffect(() => {
    if (result && result.isOpen) {
      if (soundEnabled) {
        playTradeSound(result.isProfit);
      }
      const timer = setTimeout(() => {
        onClose();
      }, 7000);
      return () => clearTimeout(timer);
    }
  }, [result, soundEnabled, onClose]);

  if (!result || !result.isOpen) return null;

  const isProfit = result.isProfit;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 select-none overflow-hidden"
      >
        {/* Full-Screen Backdrop Atmosphere */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className={`absolute inset-0 backdrop-blur-md transition-colors duration-700 ${
            isProfit
              ? 'bg-slate-950/85 [background:radial-gradient(circle_at_center,rgba(16,185,129,0.22)_0%,rgba(2,6,23,0.92)_80%)]'
              : 'bg-slate-950/90 [background:radial-gradient(circle_at_center,rgba(225,29,72,0.18)_0%,rgba(15,23,42,0.95)_80%)]'
          }`}
          onClick={onClose}
        />

        {/* Celebratory Particles / Raindrops */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {CELEBRATION_PARTICLES.map((p) => (
            <motion.div
              key={p.id}
              initial={{
                x: 0,
                y: isProfit ? 0 : -200,
                opacity: 0,
                scale: 0,
                rotate: 0,
              }}
              animate={{
                x: p.x,
                y: isProfit ? p.y : p.y + 400,
                opacity: [0, 0.9, 0],
                scale: [0, p.scale, 0],
                rotate: p.rotation,
              }}
              transition={{
                duration: isProfit ? 2.8 : 3.2,
                repeat: Infinity,
                delay: p.delay,
                ease: 'easeOut',
              }}
              className={`absolute top-1/2 left-1/2 w-3 h-3 rounded-full ${
                isProfit
                  ? p.id % 3 === 0
                    ? 'bg-emerald-400 shadow-[0_0_12px_#34d399]'
                    : p.id % 3 === 1
                    ? 'bg-cyan-400 shadow-[0_0_12px_#00f0ff]'
                    : 'bg-amber-300 shadow-[0_0_12px_#fcd34d]'
                  : 'bg-slate-400/50 shadow-[0_0_8px_#94a3b8]'
              }`}
            />
          ))}
        </div>

        {/* Central Celebratory / Somber Modal Card */}
        <motion.div
          initial={{ scale: 0.75, opacity: 0, y: 30 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.8, opacity: 0, y: 20 }}
          transition={{ type: 'spring', damping: 20, stiffness: 260 }}
          className="relative max-w-lg w-full rounded-2xl p-6 md:p-8 z-10 border shadow-2xl backdrop-blur-xl overflow-hidden"
          style={{
            background: isProfit
              ? 'linear-gradient(145deg, rgba(6, 78, 59, 0.9) 0%, rgba(2, 44, 34, 0.95) 50%, rgba(15, 23, 42, 0.98) 100%)'
              : 'linear-gradient(145deg, rgba(69, 10, 10, 0.9) 0%, rgba(30, 27, 75, 0.95) 50%, rgba(15, 23, 42, 0.98) 100%)',
            borderColor: isProfit ? 'rgba(52, 211, 153, 0.5)' : 'rgba(244, 63, 94, 0.4)',
            boxShadow: isProfit
              ? '0 0 60px -10px rgba(16, 185, 129, 0.45)'
              : '0 0 60px -10px rgba(225, 29, 72, 0.35)',
          }}
        >
          {/* Top Controls: Sound & Close */}
          <div className="flex items-center justify-between mb-4">
            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              className="text-xs font-mono text-slate-400 hover:text-slate-200 flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900/60 border border-slate-700/60 transition-colors"
            >
              {soundEnabled ? <Volume2 className="w-3.5 h-3.5 text-cyan-400" /> : <VolumeX className="w-3.5 h-3.5 text-slate-500" />}
              {soundEnabled ? 'Audio On' : 'Muted'}
            </button>

            <button
              onClick={onClose}
              className="p-1 rounded-full text-slate-400 hover:text-white hover:bg-slate-800/60 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Icon & Title Banner */}
          <div className="text-center flex flex-col items-center">
            {isProfit ? (
              <motion.div
                animate={{ scale: [1, 1.15, 1], rotate: [0, 5, -5, 0] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                className="w-20 h-20 rounded-2xl bg-gradient-to-tr from-emerald-600 to-cyan-400 p-[2px] shadow-[0_0_30px_rgba(16,185,129,0.7)] flex items-center justify-center mb-4"
              >
                <div className="w-full h-full bg-slate-950 rounded-[14px] flex items-center justify-center">
                  <Sparkles className="w-10 h-10 text-emerald-400 drop-shadow-[0_0_10px_#34d399]" />
                </div>
              </motion.div>
            ) : (
              <motion.div
                animate={{ y: [0, 4, 0] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                className="w-20 h-20 rounded-2xl bg-gradient-to-tr from-rose-600 to-indigo-600 p-[2px] shadow-[0_0_30px_rgba(225,29,72,0.6)] flex items-center justify-center mb-4"
              >
                <div className="w-full h-full bg-slate-950 rounded-[14px] flex items-center justify-center">
                  <ShieldAlert className="w-10 h-10 text-rose-400 drop-shadow-[0_0_10px_#fb7185]" />
                </div>
              </motion.div>
            )}

            <motion.div
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.15 }}
            >
              <span className={`text-xs font-mono font-bold uppercase tracking-widest px-3 py-1 rounded-full border ${
                isProfit
                  ? 'bg-emerald-950/80 text-emerald-300 border-emerald-700/80 shadow-[0_0_10px_rgba(16,185,129,0.3)]'
                  : 'bg-rose-950/80 text-rose-300 border-rose-700/80 shadow-[0_0_10px_rgba(225,29,72,0.3)]'
              }`}>
                {isProfit ? '🎉 WINNING TRADE CELEBRATION' : '💔 DISCIPLINED DRAWDOWN NOTICE'}
              </span>

              <h2 className={`text-3xl md:text-4xl font-black font-mono tracking-tight mt-3 mb-1 tabular-nums ${
                isProfit
                  ? 'text-emerald-300 drop-shadow-[0_0_18px_rgba(52,211,153,0.8)]'
                  : 'text-rose-400 drop-shadow-[0_0_18px_rgba(251,113,133,0.8)]'
              }`}>
                {isProfit ? '+' : ''}${result.pnl.toFixed(2)}
              </h2>

              <p className="text-xs font-mono text-slate-300">
                {isProfit ? '+' : ''}{result.pnlPercent.toFixed(2)}% Return on Position
              </p>
            </motion.div>
          </div>

          {/* Trade Details Grid */}
          <div className="mt-6 bg-slate-950/70 border border-slate-800/80 rounded-xl p-3.5 space-y-2 text-xs font-mono">
            <div className="flex items-center justify-between text-slate-400">
              <span>Instrument</span>
              <span className="font-bold text-white flex items-center gap-1.5">
                {result.symbol}
                <span className={`px-1.5 py-0.2 rounded text-[10px] ${
                  result.side === 'LONG' ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'
                }`}>
                  {result.side}
                </span>
              </span>
            </div>

            <div className="flex items-center justify-between text-slate-400">
              <span>Exit Reason</span>
              <span className="font-semibold text-cyan-300">
                {result.reason?.replace('_', ' ') || 'CLOSED'}
              </span>
            </div>

            <div className="flex items-center justify-between text-slate-400">
              <span>Entry / Exit Price</span>
              <span className="text-slate-200">
                ${result.entryPrice.toFixed(2)} → ${result.exitPrice.toFixed(2)}
              </span>
            </div>

            {isProfit && (result.compoundingBonus || 0) > 0 && (
              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-emerald-400 font-bold">
                <span className="flex items-center gap-1">
                  <Zap className="w-3.5 h-3.5" /> Compounding Bonus
                </span>
                <span>+${result.compoundingBonus?.toFixed(2)} Added to Pool</span>
              </div>
            )}
          </div>

          {/* Bottom Philosophy Message */}
          <div className="mt-4 text-center">
            <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
              {isProfit
                ? 'High-probability execution achieved via Order Flow & Volume Profile convergence.'
                : 'Capital preserved. Strict stop loss prevented deeper drawdown, resetting margin for the next optimal setup.'}
            </p>
          </div>

          {/* Action CTA & Auto-Dismiss Progress Bar */}
          <div className="mt-5 space-y-2">
            <button
              onClick={onClose}
              className={`w-full py-2.5 px-4 rounded-xl font-bold text-xs uppercase tracking-wider transition-all shadow-lg flex items-center justify-center gap-2 ${
                isProfit
                  ? 'bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-[0_0_20px_rgba(52,211,153,0.5)]'
                  : 'bg-rose-500 hover:bg-rose-400 text-white shadow-[0_0_20px_rgba(244,63,94,0.4)]'
              }`}
            >
              {isProfit ? <CheckCircle2 className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              {isProfit ? 'Celebrate & Continue Trading' : 'Acknowledge & Maintain Discipline'}
            </button>

            {/* Countdown Shrinking Bar */}
            <div className="w-full bg-slate-900/90 rounded-full h-1 overflow-hidden">
              <motion.div
                initial={{ width: '100%' }}
                animate={{ width: '0%' }}
                transition={{ duration: 7, ease: 'linear' }}
                className={`h-full ${isProfit ? 'bg-emerald-400' : 'bg-rose-500'}`}
              />
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
