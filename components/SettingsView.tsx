'use client';

import React, { useState } from 'react';
import { motion } from 'motion/react';
import {
  Key,
  Sliders,
  Play,
  Pause,
  RefreshCw,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
} from 'lucide-react';

export interface BotSettings {
  apiKey: string;
  apiSecret: string;
  isTestnet: boolean;
  baseMargin: number; // default $2.00
  leverage: number; // default 10x
  maxOpenTrades: number; // default 5
  compoundingPercent: number; // default 20%
  scanIntervalSeconds: number; // default 15s
  rateLimitSafetyCap: number; // default 95%
}

interface SettingsViewProps {
  settings: BotSettings;
  onUpdateSettings: (newSettings: BotSettings) => void;
  onTestConnection: () => Promise<void>;
  isTestingConnection: boolean;
  connectionResult: {
    tested: boolean;
    success: boolean;
    message: string;
    latencyMs?: number;
    balance?: {
      totalWalletBalance: number;
      availableBalance: number;
    } | null;
  } | null;
  botActive: boolean;
  onStartBot: (updatedSettings?: BotSettings) => void;
  onPauseBot: () => void;
}

export function SettingsView({
  settings,
  onUpdateSettings,
  onTestConnection,
  isTestingConnection,
  connectionResult,
  botActive,
  onStartBot,
  onPauseBot,
}: SettingsViewProps) {
  const [localSettings, setLocalSettings] = useState<BotSettings>(settings);
  const [showSecret, setShowSecret] = useState<boolean>(false);
  const [isSaved, setIsSaved] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateSettings(localSettings);
    setIsSaved(true);
    setValidationError(null);
    setTimeout(() => setIsSaved(false), 2500);
  };

  const handleSaveAndStart = () => {
    if (!localSettings.apiKey.trim() || !localSettings.apiSecret.trim()) {
      setValidationError('Please input your Binance API Key and Secret Key before starting the bot.');
      return;
    }
    setValidationError(null);
    onUpdateSettings(localSettings);
    setIsSaved(true);
    onStartBot(localSettings);
  };

  const hasCredentials = Boolean(localSettings.apiKey.trim() && localSettings.apiSecret.trim());

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="space-y-6"
    >
      {/* Bot Setup & Run Controller Banner */}
      <div className="neon-section">
        <div className="neon-section-inner p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex items-center gap-2 px-3.5 py-1 rounded-full text-xs font-bold font-mono ${
                  botActive
                    ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800'
                    : 'bg-cyan-950/80 text-cyan-400 border border-cyan-800'
                }`}
              >
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    botActive ? 'bg-emerald-400 animate-pulse' : 'bg-cyan-400 animate-ping'
                  }`}
                />
                {botActive ? 'BOT RUNNING (LIVE BINANCE FUTURES)' : 'READY FOR LIVE PRODUCTION'}
              </span>
            </div>
            {validationError && (
              <div className="text-xs text-rose-400 flex items-center gap-1.5 font-sans font-medium bg-rose-950/60 border border-rose-800/80 px-3 py-1.5 rounded-lg">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {validationError}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {botActive ? (
              <button
                type="button"
                onClick={onPauseBot}
                title="Pause Bot"
                className="w-16 h-16 rounded-2xl flex items-center justify-center text-white bg-rose-600 hover:bg-rose-500 shadow-[0_0_24px_rgba(225,29,72,0.6)] animate-pulse transition-all"
              >
                <Pause className="w-8 h-8 fill-white" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSaveAndStart}
                title="Start Real Live Bot Execution"
                className={`w-20 h-20 rounded-2xl flex items-center justify-center transition-all ${
                  hasCredentials
                    ? 'text-slate-950 bg-cyan-400 hover:bg-cyan-300 shadow-[0_0_35px_rgba(0,240,255,0.8)] animate-bounce hover:scale-105'
                    : 'text-slate-400 bg-slate-800 border border-slate-700 hover:bg-slate-750'
                }`}
              >
                <Play className={`w-9 h-9 ml-1 ${hasCredentials ? 'fill-slate-950' : 'fill-slate-400'}`} />
              </button>
            )}
          </div>
        </div>
      </div>

      <form onSubmit={handleSave} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Section A: Binance API Credentials */}
        <div className="neon-section">
          <div className="neon-section-inner p-5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-cyan-400" />
                <h4 className="text-sm font-semibold text-slate-100">
                  Binance Futures API
                </h4>
              </div>
              <div className="text-xs font-mono font-bold text-emerald-400 px-2.5 py-1 rounded bg-emerald-950/60 border border-emerald-800 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                REAL LIVE PRODUCTION (0% SIMULATION)
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                API Key <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                value={localSettings.apiKey}
                onChange={(e) => {
                  setLocalSettings({ ...localSettings, apiKey: e.target.value.trim() });
                  setValidationError(null);
                }}
                placeholder="Paste your Binance Futures API Key"
                className="w-full bg-slate-950 border border-slate-700/80 rounded-md px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-400"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-300">
                  Secret Key <span className="text-rose-400">*</span>
                </label>
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                >
                  {showSecret ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  {showSecret ? 'Hide' : 'Reveal'}
                </button>
              </div>
              <div className="relative">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={localSettings.apiSecret}
                  onChange={(e) => {
                    setLocalSettings({ ...localSettings, apiSecret: e.target.value.trim() });
                    setValidationError(null);
                  }}
                  placeholder="Paste your Binance Futures Secret Key"
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-md px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-400"
                />
              </div>
            </div>

            {/* Connection Test Action */}
            <div className="pt-2">
              <button
                type="button"
                onClick={onTestConnection}
                disabled={isTestingConnection || !hasCredentials}
                className="w-full py-2 px-3 text-xs font-medium text-slate-100 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${isTestingConnection ? 'animate-spin' : ''}`}
                />
                {isTestingConnection ? 'Testing Connection...' : 'Test Connection'}
              </button>

              {connectionResult && connectionResult.tested && (
                <div
                  className={`mt-3 p-3 rounded-md border text-xs font-mono ${
                    connectionResult.success
                      ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
                      : 'bg-rose-950/40 border-rose-800 text-rose-300'
                  }`}
                >
                  <div className="font-semibold flex items-center justify-between">
                    <span>{connectionResult.message}</span>
                    {connectionResult.latencyMs && (
                      <span className="text-[11px] text-slate-400">
                        {connectionResult.latencyMs}ms
                      </span>
                    )}
                  </div>
                  {connectionResult.balance && (
                    <div className="mt-1 pt-1 border-t border-emerald-800/40 text-[11px] text-emerald-400 flex justify-between">
                      <span>Futures Wallet:</span>
                      <span className="font-bold">
                        ${connectionResult.balance.totalWalletBalance.toFixed(2)} USDT
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Section B: Trading Parameters */}
        <div className="neon-section">
          <div className="neon-section-inner p-5 space-y-4">
            <div className="flex items-center gap-2 pb-3 border-b border-slate-800">
              <Sliders className="w-4 h-4 text-cyan-400" />
              <h4 className="text-sm font-semibold text-slate-100">
                Bot Parameters
              </h4>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Base Margin ($)
                </label>
                <input
                  type="number"
                  step="0.1"
                  min="1"
                  value={localSettings.baseMargin}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      baseMargin: parseFloat(e.target.value) || 2.0,
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-md px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-400"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Leverage (Isolated)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={localSettings.leverage}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        leverage: parseInt(e.target.value, 10) || 10,
                      })
                    }
                    className="w-full bg-slate-950 border border-slate-700/80 rounded-md px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-400"
                  />
                  <span className="text-xs font-mono text-slate-400">x</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Max Open Trades
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={localSettings.maxOpenTrades}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      maxOpenTrades: parseInt(e.target.value, 10) || 5,
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-md px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-400"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Compounding %
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={localSettings.compoundingPercent}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        compoundingPercent: parseInt(e.target.value, 10) || 20,
                      })
                    }
                    className="w-full bg-slate-950 border border-slate-700/80 rounded-md px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-400"
                  />
                  <span className="text-xs font-mono text-slate-400">%</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Scan Interval (s)
                </label>
                <input
                  type="number"
                  min="5"
                  max="60"
                  value={localSettings.scanIntervalSeconds}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      scanIntervalSeconds: parseInt(e.target.value, 10) || 15,
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-md px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-400"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Rate Limit Cap (%)
                </label>
                <input
                  type="number"
                  step="1"
                  min="50"
                  max="98"
                  value={localSettings.rateLimitSafetyCap}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      rateLimitSafetyCap: parseInt(e.target.value, 10) || 95,
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-md px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-400"
                />
              </div>
            </div>

            <div className="pt-3 flex items-center justify-between gap-3 border-t border-slate-800">
              <div>
                {isSaved && (
                  <span className="text-xs text-emerald-400 font-medium flex items-center gap-1">
                    <Check className="w-3.5 h-3.5" /> Settings Saved
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-all"
                >
                  Save Settings
                </button>

                {!botActive && (
                  <button
                    type="button"
                    onClick={handleSaveAndStart}
                    className="px-5 py-2 text-xs font-bold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-md transition-all shadow-[0_0_12px_rgba(0,240,255,0.4)] flex items-center gap-1.5"
                  >
                    <Play className="w-3.5 h-3.5 fill-slate-950" />
                    Start Bot
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </form>
    </motion.div>
  );
}
