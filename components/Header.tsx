'use client';

import React from 'react';
import { Play, Pause } from 'lucide-react';
import { TradeMasterLogo } from '@/components/TradeMasterLogo';

interface HeaderProps {
  activeTab: 'positions' | 'scanner' | 'history' | 'logs' | 'settings';
  setActiveTab: (tab: 'positions' | 'scanner' | 'history' | 'logs' | 'settings') => void;
  botActive: boolean;
  onToggleBot: () => void;
  openPositionsCount: number;
  hasApiKey?: boolean;
}

export function Header({
  activeTab,
  setActiveTab,
  botActive,
  onToggleBot,
  openPositionsCount,
  hasApiKey = false,
}: HeaderProps) {
  return (
    <header className="relative flex items-center justify-between gap-8 px-6 py-3.5 bg-slate-950/90 backdrop-blur sticky top-0 z-40">
      {/* Animated Moving Neon Blue Bottom Border */}
      <div className="absolute bottom-0 left-0 right-0 h-[1.5px] bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-[neonBorderMove_4s_ease_infinite] [background-size:200%_100%] opacity-90 shadow-[0_0_10px_#00f0ff]" />

      {/* Zone 1: Animated Trade Master Logo */}
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          setActiveTab('positions');
        }}
        className="shrink-0 flex items-center"
      >
        <TradeMasterLogo size="md" />
      </a>

      {/* Zone 2: Navigation tabs */}
      <nav className="hidden md:flex items-center gap-6 text-xs font-medium">
        <button
          onClick={() => setActiveTab('positions')}
          className={`whitespace-nowrap shrink-0 transition-all pb-1 ${
            activeTab === 'positions'
              ? 'text-cyan-300 border-b-2 border-cyan-400 font-bold drop-shadow-[0_0_8px_rgba(0,240,255,0.6)]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Active Positions ({openPositionsCount}/5)
        </button>

        <button
          onClick={() => setActiveTab('scanner')}
          className={`whitespace-nowrap shrink-0 transition-all pb-1 ${
            activeTab === 'scanner'
              ? 'text-cyan-300 border-b-2 border-cyan-400 font-bold drop-shadow-[0_0_8px_rgba(0,240,255,0.6)]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Market Scanner
        </button>

        <button
          onClick={() => setActiveTab('history')}
          className={`whitespace-nowrap shrink-0 transition-all pb-1 ${
            activeTab === 'history'
              ? 'text-cyan-300 border-b-2 border-cyan-400 font-bold drop-shadow-[0_0_8px_rgba(0,240,255,0.6)]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Trade History
        </button>

        <button
          onClick={() => setActiveTab('logs')}
          className={`whitespace-nowrap shrink-0 transition-all pb-1 ${
            activeTab === 'logs'
              ? 'text-cyan-300 border-b-2 border-cyan-400 font-bold drop-shadow-[0_0_8px_rgba(0,240,255,0.6)]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Diagnostics
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={`whitespace-nowrap shrink-0 transition-all pb-1 ${
            activeTab === 'settings'
              ? 'text-cyan-300 border-b-2 border-cyan-400 font-bold drop-shadow-[0_0_8px_rgba(0,240,255,0.6)]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Settings
        </button>
      </nav>

      {/* Zone 3: Actions */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Primary CTA: Start/Stop Bot */}
        <button
          onClick={onToggleBot}
          className={`px-4 py-2 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-all shadow-sm whitespace-nowrap shrink-0 ${
            botActive
              ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-950/40'
              : !hasApiKey
              ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold shadow-[0_0_12px_rgba(245,158,11,0.4)]'
              : 'bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold shadow-[0_0_12px_rgba(0,240,255,0.4)] animate-pulse'
          }`}
          title={!hasApiKey ? 'Enter Binance API Key in Settings to Start Bot' : undefined}
        >
          {botActive ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          {botActive ? 'Pause Bot' : !hasApiKey ? 'Set API Key to Start' : 'Start Bot'}
        </button>
      </div>

      {/* Mobile Navigation */}
      <div className="flex md:hidden absolute left-0 right-0 top-full bg-slate-950 border-b border-slate-800 px-4 py-2 overflow-x-auto gap-4 text-xs font-medium scrollbar-none z-30">
        <button
          onClick={() => setActiveTab('positions')}
          className={`whitespace-nowrap shrink-0 py-1 ${
            activeTab === 'positions'
              ? 'text-cyan-300 font-bold border-b-2 border-cyan-400'
              : 'text-slate-400'
          }`}
        >
          Positions ({openPositionsCount}/5)
        </button>
        <button
          onClick={() => setActiveTab('scanner')}
          className={`whitespace-nowrap shrink-0 py-1 ${
            activeTab === 'scanner'
              ? 'text-cyan-300 font-bold border-b-2 border-cyan-400'
              : 'text-slate-400'
          }`}
        >
          Scanner
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`whitespace-nowrap shrink-0 py-1 ${
            activeTab === 'history'
              ? 'text-cyan-300 font-bold border-b-2 border-cyan-400'
              : 'text-slate-400'
          }`}
        >
          History
        </button>
        <button
          onClick={() => setActiveTab('logs')}
          className={`whitespace-nowrap shrink-0 py-1 ${
            activeTab === 'logs'
              ? 'text-cyan-300 font-bold border-b-2 border-cyan-400'
              : 'text-slate-400'
          }`}
        >
          Diagnostics
        </button>
        <button
          onClick={() => setActiveTab('settings')}
          className={`whitespace-nowrap shrink-0 py-1 ${
            activeTab === 'settings'
              ? 'text-cyan-300 font-bold border-b-2 border-cyan-400'
              : 'text-slate-400'
          }`}
        >
          Settings
        </button>
      </div>
    </header>
  );
}
