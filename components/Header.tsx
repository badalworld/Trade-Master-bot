'use client';

import React from 'react';
import { motion } from 'motion/react';
import { Play, Pause } from 'lucide-react';
import { TradeMasterLogo } from '@/components/TradeMasterLogo';

interface HeaderProps {
  activeTab: 'positions' | 'scanner' | 'history' | 'logs' | 'settings';
  setActiveTab: (tab: 'positions' | 'scanner' | 'history' | 'logs' | 'settings') => void;
  botActive: boolean;
  onToggleBot: () => void;
  openPositionsCount: number;
  maxOpenPositions?: number;
  hasApiKey?: boolean;
}

export function Header({
  activeTab,
  setActiveTab,
  botActive,
  onToggleBot,
  openPositionsCount,
  maxOpenPositions = 5,
  hasApiKey = false,
}: HeaderProps) {
  const navItems: {
    id: 'positions' | 'scanner' | 'history' | 'logs' | 'settings';
    label: string;
    shortLabel: string;
  }[] = [
    {
      id: 'positions',
      label: `Active Positions (${openPositionsCount}/${maxOpenPositions})`,
      shortLabel: `Positions (${openPositionsCount}/${maxOpenPositions})`,
    },
    {
      id: 'scanner',
      label: 'Market Scanner',
      shortLabel: 'Scanner',
    },
    {
      id: 'history',
      label: 'Trade History',
      shortLabel: 'History',
    },
    {
      id: 'logs',
      label: 'Diagnostics',
      shortLabel: 'Diagnostics',
    },
    {
      id: 'settings',
      label: 'Settings',
      shortLabel: 'Settings',
    },
  ];

  return (
    <header className="relative flex flex-col w-full max-w-full overflow-hidden bg-slate-950/95 backdrop-blur-xl sticky top-0 z-40">
      {/* Main Top Bar */}
      <div className="flex items-center justify-between gap-2 sm:gap-4 px-3 sm:px-6 py-3 max-w-7xl w-full mx-auto">
        {/* Zone 1: Round Logo Ripple Emblem */}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('positions');
          }}
          className="shrink-0 flex items-center pl-1"
        >
          <TradeMasterLogo size="md" />
        </a>

        {/* Zone 2: Desktop Navigation Tabs with Interactive Button Glow & Motion Indicator */}
        <nav className="hidden lg:flex items-center gap-1.5 xl:gap-3 text-xs font-medium bg-slate-900/70 p-1 rounded-xl border border-slate-800/80">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`interactive-glow-btn relative whitespace-nowrap shrink-0 px-3 py-1.5 rounded-lg transition-all ${
                  isActive
                    ? 'text-cyan-200 font-bold'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {isActive && (
                  <motion.span
                    layoutId="activeHeaderTabPill"
                    transition={{ type: 'spring', stiffness: 360, damping: 28 }}
                    className="absolute inset-0 rounded-lg bg-gradient-to-r from-cyan-500/25 via-sky-500/20 to-blue-600/25 border border-cyan-400/50 shadow-[0_0_14px_rgba(0,240,255,0.35)]"
                  />
                )}
                <span className="relative z-10">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Primary CTA with Interactive Button Glow */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onToggleBot}
            className={`interactive-glow-btn px-3.5 sm:px-4 py-2 text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-all whitespace-nowrap shrink-0 ${
              botActive
                ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-[0_0_18px_rgba(225,29,72,0.5)]'
                : !hasApiKey
                ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold shadow-[0_0_16px_rgba(245,158,11,0.45)]'
                : 'bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-bold shadow-[0_0_18px_rgba(0,240,255,0.5)]'
            }`}
            title={!hasApiKey ? 'Enter Binance API Key in Settings to Start Bot' : undefined}
          >
            {botActive ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span>{botActive ? 'Pause Bot' : !hasApiKey ? 'Set API Key to Start' : 'Start Bot'}</span>
          </button>
        </div>
      </div>

      {/* Compact / Tablet / Mobile Navigation Bar (below lg breakpoint, inside normal flow) */}
      <div className="flex lg:hidden w-full bg-slate-950/95 border-t border-slate-900 px-3 sm:px-6 py-2 overflow-x-auto gap-2 text-xs font-medium scrollbar-none">
        {navItems.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`interactive-glow-btn whitespace-nowrap shrink-0 px-3 py-1 rounded-lg transition-all ${
                isActive
                  ? 'bg-cyan-950/80 text-cyan-300 font-bold border border-cyan-500/60 shadow-[0_0_10px_rgba(0,240,255,0.3)]'
                  : 'text-slate-400 hover:text-slate-200 bg-slate-900/50 border border-slate-800/60'
              }`}
            >
              {item.shortLabel}
            </button>
          );
        })}
      </div>

      {/* Animated Moving Neon Blue Bottom Border */}
      <div className="h-[1.5px] w-full bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-[neonBorderMove_4s_ease_infinite] [background-size:200%_100%] opacity-90 shadow-[0_0_10px_#00f0ff]" />
    </header>
  );
}
