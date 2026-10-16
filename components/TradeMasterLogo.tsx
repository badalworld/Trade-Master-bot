'use client';

import React from 'react';
import { motion } from 'motion/react';

interface TradeMasterLogoProps {
  size?: 'sm' | 'md' | 'lg';
  showSubtitle?: boolean;
}

export function TradeMasterLogo({ size = 'md', showSubtitle = false }: TradeMasterLogoProps) {
  const isSm = size === 'sm';
  const isLg = size === 'lg';

  const iconDim = isSm ? 34 : isLg ? 48 : 40;

  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      className="flex items-center gap-2.5 sm:gap-3 select-none group cursor-pointer shrink-0"
    >
      {/* Jitter Round-Logo-Ripple Motion Graphic Emblem */}
      <div
        className="relative shrink-0 flex items-center justify-center rounded-full"
        style={{
          width: iconDim,
          height: iconDim,
        }}
      >
        {/* Concentric Expanding Ripple Wave 1 */}
        <motion.span
          animate={{
            scale: [0.85, 1.85],
            opacity: [0.75, 0],
          }}
          transition={{
            duration: 2.6,
            repeat: Infinity,
            ease: [0.16, 1, 0.3, 1],
            delay: 0,
          }}
          className="absolute inset-0 rounded-full border border-cyan-400/80 shadow-[0_0_12px_rgba(0,240,255,0.6)] pointer-events-none"
        />

        {/* Concentric Expanding Ripple Wave 2 */}
        <motion.span
          animate={{
            scale: [0.85, 1.85],
            opacity: [0.65, 0],
          }}
          transition={{
            duration: 2.6,
            repeat: Infinity,
            ease: [0.16, 1, 0.3, 1],
            delay: 0.85,
          }}
          className="absolute inset-0 rounded-full border border-emerald-400/70 shadow-[0_0_12px_rgba(52,211,153,0.5)] pointer-events-none"
        />

        {/* Concentric Expanding Ripple Wave 3 */}
        <motion.span
          animate={{
            scale: [0.85, 1.85],
            opacity: [0.55, 0],
          }}
          transition={{
            duration: 2.6,
            repeat: Infinity,
            ease: [0.16, 1, 0.3, 1],
            delay: 1.7,
          }}
          className="absolute inset-0 rounded-full border border-sky-400/70 shadow-[0_0_14px_rgba(56,189,248,0.5)] pointer-events-none"
        />

        {/* Ambient Rotating Conic Halo */}
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 7, repeat: Infinity, ease: 'linear' }}
          className="absolute inset-[-2px] rounded-full opacity-90 blur-[2px]"
          style={{
            background:
              'conic-gradient(from 0deg, #00f0ff 0deg 90deg, #34d399 90deg 180deg, #38bdf8 180deg 270deg, #6366f1 270deg 360deg)',
          }}
        />

        {/* Round Core Plate with Breathing Pulse */}
        <motion.div
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
          className="relative w-full h-full bg-slate-950 rounded-full flex items-center justify-center overflow-hidden border border-cyan-400/60 shadow-[inset_0_0_12px_rgba(0,240,255,0.35)] z-10"
        >
          {/* Subtle Radial Ripple Grid Inside Core */}
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(0,240,255,0.22)_0%,transparent_70%)]" />

          {/* SVG Vector Round Ripple Emblem */}
          <svg
            viewBox="0 0 48 48"
            className="w-full h-full p-1.5 relative z-10"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Outer Precision Segmented Ring */}
            <circle
              cx="24"
              cy="24"
              r="18"
              stroke="rgba(56, 189, 248, 0.28)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
            <path
              d="M 24 6 A 18 18 0 0 1 42 24"
              stroke="#00F0FF"
              strokeWidth="3"
              strokeLinecap="round"
              className="drop-shadow-[0_0_6px_#00F0FF]"
            />
            <path
              d="M 42 24 A 18 18 0 0 1 24 42"
              stroke="#34D399"
              strokeWidth="3"
              strokeLinecap="round"
              className="drop-shadow-[0_0_6px_#34D399]"
            />
            <path
              d="M 24 42 A 18 18 0 0 1 6 24"
              stroke="#38BDF8"
              strokeWidth="3"
              strokeLinecap="round"
              className="drop-shadow-[0_0_6px_#38BDF8]"
            />
            <path
              d="M 6 24 A 18 18 0 0 1 24 6"
              stroke="#818CF8"
              strokeWidth="3"
              strokeLinecap="round"
              className="drop-shadow-[0_0_6px_#818CF8]"
            />

            {/* Inner Ripple Ring */}
            <circle
              cx="24"
              cy="24"
              r="12"
              stroke="rgba(0, 240, 255, 0.35)"
              strokeWidth="1.2"
            />

            {/* Futuristic Algorithmic Monogram 'T' + Breakout Vector */}
            <path
              d="M 16 18 L 32 18 M 24 18 L 24 33"
              stroke="#FFFFFF"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="drop-shadow-[0_0_8px_rgba(255,255,255,0.9)]"
            />
            <path
              d="M 26.5 27.5 L 32.5 21.5 M 32.5 21.5 L 28 21.5 M 32.5 21.5 L 32.5 26"
              stroke="#00F0FF"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="drop-shadow-[0_0_8px_#00F0FF]"
            />

            {/* Top Apex Pulse Node */}
            <circle cx="24" cy="6" r="2.3" fill="#FFFFFF" />
            <circle cx="24" cy="6" r="1.5" fill="#00F0FF" />
          </svg>
        </motion.div>
      </div>

      {/* Brand Typographic Identity */}
      <div className="flex flex-col min-w-0">
        <div className="flex items-center gap-1.5">
          <div className="flex items-baseline tracking-tight whitespace-nowrap">
            <span
              className={`font-black tracking-wider uppercase font-sans ${
                isSm ? 'text-xs' : isLg ? 'text-xl' : 'text-sm sm:text-base'
              } text-white drop-shadow-[0_0_10px_rgba(255,255,255,0.25)]`}
            >
              Trade
            </span>
            <span
              className={`font-black tracking-wider uppercase font-sans ml-1 ${
                isSm ? 'text-xs' : isLg ? 'text-xl' : 'text-sm sm:text-base'
              } bg-gradient-to-r from-cyan-300 via-emerald-300 to-sky-400 bg-clip-text text-transparent drop-shadow-[0_0_12px_rgba(0,240,255,0.5)]`}
            >
              Master
            </span>
          </div>

          {/* 4-Color Micro Convergence Ripple Dots */}
          <div className="hidden sm:flex items-center gap-1 bg-slate-900/90 px-1.5 py-0.5 rounded-full border border-slate-800 shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" title="HVN Profile" />
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse [animation-delay:200ms]" title="Absorption" />
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse [animation-delay:400ms]" title="Imbalance" />
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse [animation-delay:600ms]" title="Execution" />
          </div>
        </div>

        {showSubtitle && (
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
            <span className="text-[10px] font-mono tracking-widest text-cyan-300/90 uppercase font-semibold">
              Binance Futures Algo Core · 10x–15x Isolated
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
}
