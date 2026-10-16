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

  const iconDim = isSm ? 32 : isLg ? 48 : 40;

  return (
    <div className="flex items-center gap-3 select-none group cursor-pointer">
      {/* Google-Inspired Sharp Precision Multi-Color Orbital Glyph */}
      <div
        className="relative shrink-0 flex items-center justify-center rounded-2xl overflow-hidden"
        style={{
          width: iconDim,
          height: iconDim,
        }}
      >
        {/* Animated Chromatic Orbital Glow: Google Blue, Emerald Green, Golden Amber, Crimson Red */}
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
          className="absolute inset-[-4px] rounded-full opacity-90 blur-[3px]"
          style={{
            background: 'conic-gradient(from 0deg, #4285F4 0deg 90deg, #34A853 90deg 180deg, #FBBC05 180deg 270deg, #EA4335 270deg 360deg)',
          }}
        />

        {/* Sharp Deep Sapphire / Obsidian Core Plate */}
        <div className="absolute inset-[2px] bg-slate-950 rounded-[14px] flex items-center justify-center overflow-hidden border border-slate-800/80 shadow-inner">
          {/* Subtle Precision Grid Backdrop */}
          <div className="absolute inset-0 bg-[radial-gradient(#38bdf8_1px,transparent_1px)] [background-size:6px_6px] opacity-25" />

          {/* SVG Vector Motion Graphic */}
          <svg
            viewBox="0 0 48 48"
            className="w-full h-full p-1.5 relative z-10"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Google-Style 4-Quadrant Geometric Ring */}
            <path
              d="M 24 6 A 18 18 0 0 1 42 24"
              stroke="#34A853"
              strokeWidth="3.2"
              strokeLinecap="round"
              className="drop-shadow-[0_0_6px_rgba(52,168,83,0.8)]"
            />
            <path
              d="M 42 24 A 18 18 0 0 1 24 42"
              stroke="#FBBC05"
              strokeWidth="3.2"
              strokeLinecap="round"
              className="drop-shadow-[0_0_6px_rgba(251,188,5,0.8)]"
            />
            <path
              d="M 24 42 A 18 18 0 0 1 6 24"
              stroke="#EA4335"
              strokeWidth="3.2"
              strokeLinecap="round"
              className="drop-shadow-[0_0_6px_rgba(234,67,53,0.8)]"
            />
            <path
              d="M 6 24 A 18 18 0 0 1 24 6"
              stroke="#4285F4"
              strokeWidth="3.2"
              strokeLinecap="round"
              className="drop-shadow-[0_0_6px_rgba(66,133,244,0.8)]"
            />

            {/* Inner Futuristic Algorithmic Chevron / Monogram 'T' 'M' */}
            <path
              d="M 15 17 L 33 17 M 24 17 L 24 33"
              stroke="#FFFFFF"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="drop-shadow-[0_0_8px_rgba(255,255,255,0.9)]"
            />
            
            {/* High-Frequency Market Breakout Arrow (Sharp Cyan) */}
            <path
              d="M 27 27 L 33 21 M 33 21 L 28 21 M 33 21 L 33 26"
              stroke="#00F0FF"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="drop-shadow-[0_0_8px_#00F0FF]"
            />

            {/* Micro Orbit Pulse Point */}
            <circle cx="24" cy="6" r="2.2" fill="#FFFFFF" className="animate-ping" />
            <circle cx="24" cy="6" r="1.8" fill="#4285F4" />
          </svg>
        </div>
      </div>

      {/* Brand Typographic Identity: Sharp Google-Clean Grotesque Structure */}
      <div className="flex flex-col">
        <div className="flex items-center gap-2">
          <div className="flex items-baseline tracking-tight">
            <span
              className={`font-black tracking-wider uppercase font-sans ${
                isSm ? 'text-sm' : isLg ? 'text-2xl' : 'text-lg'
              } text-white drop-shadow-[0_0_12px_rgba(255,255,255,0.3)]`}
            >
              Trade
            </span>
            <span
              className={`font-black tracking-wider uppercase font-sans ml-1 ${
                isSm ? 'text-sm' : isLg ? 'text-2xl' : 'text-lg'
              } bg-gradient-to-r from-cyan-300 via-emerald-300 to-sky-400 bg-clip-text text-transparent drop-shadow-[0_0_14px_rgba(0,240,255,0.6)]`}
            >
              Master
            </span>
          </div>

          {/* Google 4-Color Micro Convergence Dots */}
          <div className="flex items-center gap-1 ml-1 bg-slate-900/90 px-1.5 py-0.5 rounded-full border border-slate-800 shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4285F4] animate-pulse" title="HVN Profile" />
            <span className="w-1.5 h-1.5 rounded-full bg-[#EA4335] animate-pulse [animation-delay:200ms]" title="Absorption" />
            <span className="w-1.5 h-1.5 rounded-full bg-[#FBBC05] animate-pulse [animation-delay:400ms]" title="Imbalance" />
            <span className="w-1.5 h-1.5 rounded-full bg-[#34A853] animate-pulse [animation-delay:600ms]" title="Execution" />
          </div>
        </div>

        {showSubtitle && (
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
            <span className="text-[10px] font-mono tracking-widest text-cyan-300/90 uppercase font-semibold">
              Binance Futures Algo Core · 10x Isolated
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
