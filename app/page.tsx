'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from '@/components/Header';
import { KpiMetricsStrip, type BinanceAccountMetrics } from '@/components/KpiMetricsStrip';
import { ActivePositions } from '@/components/ActivePositions';
import { ScannerTable } from '@/components/ScannerTable';
import { InteractiveChart } from '@/components/InteractiveChart';
import { TradeHistory } from '@/components/TradeHistory';
import { DiagnosticsLog, type LogEntry } from '@/components/DiagnosticsLog';
import { SettingsView, type BotSettings } from '@/components/SettingsView';
import { PnlChartWidget } from '@/components/PnlChartWidget';
import { TradeResultOverlay, type TradeResultPayload } from '@/components/TradeResultOverlay';
import { generateUniqueId } from '@/lib/utils';
import {
  calculateNextTradeMargin,
  canOpenNewTrade,
  checkRateLimit,
  roundCryptoPrice,
  type SignalEvaluation,
  type TradePosition,
  type ClosedTrade,
  type CompoundingState,
  type RateLimitStatus,
  type Candle,
} from '@/lib/trading-engine';

// LocalStorage Keys for persistent state across app restarts
const STORAGE_KEYS = {
  SETTINGS: 'trade_master_settings_v1',
  STARTING_BALANCE: 'trade_master_starting_balance_v1',
  POSITIONS: 'trade_master_positions_v1',
  CLOSED_TRADES: 'trade_master_closed_trades_v1',
  COMPOUNDING: 'trade_master_compounding_v1',
  LOGS: 'trade_master_logs_v1',
  BINANCE_ACCOUNT: 'trade_master_binance_account_v1',
};

// Initial default settings matching user requirements ($2 Base Margin, 10x-15x Isolated Leverage)
const DEFAULT_SETTINGS: BotSettings = {
  apiKey: '',
  apiSecret: '',
  isTestnet: false,
  baseMargin: 2.0, // $2.00 base margin
  leverage: 10, // 10x isolated leverage (10x-15x supported)
  maxOpenTrades: 5, // max 5 concurrent trades
  compoundingPercent: 20, // 20% of profit amount
  scanIntervalSeconds: 15, // 15s scan
  rateLimitSafetyCap: 95, // 95% threshold
};

const INITIAL_POSITIONS: TradePosition[] = [];
const INITIAL_TRADES: ClosedTrade[] = [];

const INITIAL_LOGS: LogEntry[] = [
  {
    id: 'log-1',
    timestamp: new Date().toLocaleTimeString(),
    category: 'SYSTEM',
    severity: 'INFO',
    message: 'Trade Master terminal initialized ($2.00 Base Margin · 10x–15x Isolated · 3-Indicator TP/SL).',
  },
  {
    id: 'log-2',
    timestamp: new Date().toLocaleTimeString(),
    category: 'RATE_LIMIT',
    severity: 'SUCCESS',
    message: 'Binance API Shield active (95% safety cap).',
  },
];

export default function HomePage() {
  // Navigation
  const [activeTab, setActiveTab] = useState<'positions' | 'scanner' | 'history' | 'logs' | 'settings'>('settings');

  // Bot Core State
  const [botActive, setBotActive] = useState<boolean>(false);
  const [settings, setSettings] = useState<BotSettings>(DEFAULT_SETTINGS);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('BTCUSDT');

  // Binance Account Auto-Sync State (Starting Balance, Current Equity, Fees, Funding)
  const [binanceAccount, setBinanceAccount] = useState<BinanceAccountMetrics>({
    startingBalance: 0,
    currentEquity: 0,
    availableBalance: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    commissionFees: 0,
    fundingFees: 0,
    isSynced: false,
  });

  // Market & Signals
  const [signals, setSignals] = useState<SignalEvaluation[]>([]);
  const [candlesMap, setCandlesMap] = useState<Record<string, Candle[]>>({});
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanCountdown, setScanCountdown] = useState<number>(15);

  // Positions & Compounding
  const [positions, setPositions] = useState<TradePosition[]>(INITIAL_POSITIONS);
  const [closingPositionId, setClosingPositionId] = useState<string | null>(null);
  const [closedTrades, setClosedTrades] = useState<ClosedTrade[]>(INITIAL_TRADES);
  const [compoundingState, setCompoundingState] = useState<CompoundingState>({
    baseMargin: 2.0,
    currentMargin: 2.0,
    lastProfit: 0,
    compoundingPercent: 20,
    consecutiveWins: 0,
    totalCompoundedProfitPool: 0,
  });

  // Rate Limiting & Logs
  const [rateLimitStatus, setRateLimitStatus] = useState<RateLimitStatus>({
    usedWeight: 24,
    maxLimit: 1200,
    usageRatio: 0.02,
    usagePercent: 2.0,
    isSafe: true,
    isThrottled: false,
    remainingWeight: 1116,
  });
  const [logs, setLogs] = useState<LogEntry[]>(INITIAL_LOGS);

  // Connection Test
  const [isTestingConnection, setIsTestingConnection] = useState<boolean>(false);
  const [connectionResult, setConnectionResult] = useState<{
    tested: boolean;
    success: boolean;
    message: string;
    latencyMs?: number;
    balance?: {
      totalWalletBalance: number;
      availableBalance: number;
    } | null;
  } | null>(null);

  // Full Screen Celebration / Sad Mode Modal on Trade Close
  const [tradeResultModal, setTradeResultModal] = useState<TradeResultPayload | null>(null);

  // Track in-flight automated closes so a single position isn't closed twice concurrently
  const closingIdsRef = useRef<Set<string>>(new Set());

  // Global Interactive Mouse-Move Spotlight & Button Glow Tracker (Jitter Interactive-Button-Glow)
  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const hoveredEls = document.querySelectorAll<HTMLElement>(
        '.neon-section:hover, .neon-card:hover, .interactive-glow-btn:hover'
      );
      hoveredEls.forEach((el) => {
        const rect = el.getBoundingClientRect();
        el.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
        el.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
        el.style.setProperty('--spotlight-opacity', '1');
      });
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', handlePointerMove);
  }, []);

  // Helper to append logs (instantly persists up to 500 entries so logs are never lost on restart)
  const appendLog = useCallback(
    (
      category: LogEntry['category'],
      severity: LogEntry['severity'],
      message: string,
      details?: Record<string, unknown> | string
    ) => {
      const newEntry: LogEntry = {
        id: generateUniqueId('log'),
        timestamp: new Date().toLocaleTimeString(),
        category,
        severity,
        message,
        details,
      };
      setLogs((prev) => {
        const updated = [newEntry, ...prev].slice(0, 500);
        try {
          localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(updated));
        } catch {
          // ignore
        }
        return updated;
      });
    },
    []
  );

  // 1. PERSISTENCE RESTORATION (On Mount)
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const savedSettings = localStorage.getItem(STORAGE_KEYS.SETTINGS);
        let parsedSettings: Partial<BotSettings> | null = null;
        if (savedSettings) {
          parsedSettings = JSON.parse(savedSettings);
          setSettings((prev) => ({
            ...prev,
            ...parsedSettings,
            baseMargin: Number(parsedSettings?.baseMargin) || 2.0,
            leverage: Math.min(15, Math.max(10, Number(parsedSettings?.leverage) || 10)),
          }));
        }

        const savedAccount = localStorage.getItem(STORAGE_KEYS.BINANCE_ACCOUNT);
        if (savedAccount) {
          const parsed = JSON.parse(savedAccount);
          setBinanceAccount((prev) => ({ ...prev, ...parsed }));
        }

        const savedPositions = localStorage.getItem(STORAGE_KEYS.POSITIONS);
        if (savedPositions) {
          const parsed = JSON.parse(savedPositions);
          if (Array.isArray(parsed)) setPositions(parsed);
        }

        const savedTrades = localStorage.getItem(STORAGE_KEYS.CLOSED_TRADES);
        if (savedTrades) {
          const parsed = JSON.parse(savedTrades);
          if (Array.isArray(parsed)) setClosedTrades(parsed);
        }

        const savedCompounding = localStorage.getItem(STORAGE_KEYS.COMPOUNDING);
        if (savedCompounding) {
          const parsed = JSON.parse(savedCompounding);
          const restoredBase = Number(parsedSettings?.baseMargin ?? parsed.baseMargin) || 2.0;
          const restoredCompPct = Number(parsedSettings?.compoundingPercent ?? parsed.compoundingPercent) || 20;
          setCompoundingState((prev) => ({
            ...prev,
            ...parsed,
            baseMargin: restoredBase,
            compoundingPercent: restoredCompPct,
            currentMargin:
              (parsed.consecutiveWins || 0) === 0
                ? restoredBase
                : Math.max(restoredBase, Number(parsed.currentMargin) || restoredBase),
          }));
        } else if (parsedSettings) {
          const restoredBase = Number(parsedSettings.baseMargin) || 2.0;
          const restoredCompPct = Number(parsedSettings.compoundingPercent) || 20;
          setCompoundingState((prev) => ({
            ...prev,
            baseMargin: restoredBase,
            currentMargin: restoredBase,
            compoundingPercent: restoredCompPct,
          }));
        }

        const savedLogs = localStorage.getItem(STORAGE_KEYS.LOGS);
        if (savedLogs) {
          const parsed = JSON.parse(savedLogs);
          if (Array.isArray(parsed) && parsed.length > 0) setLogs(parsed);
        }
      } catch {
        // ignore JSON parse errors
      }
    }, 0);

    return () => clearTimeout(timer);
  }, []);

  // Helper to apply updated settings and sync CompoundingState
  const applyUpdatedSettings = useCallback((newSet: BotSettings) => {
    setSettings(newSet);
    const newBase = Number(newSet.baseMargin) || 2.0;
    const newCompPct = Number(newSet.compoundingPercent) || 20;
    setCompoundingState((prev) => ({
      ...prev,
      baseMargin: newBase,
      compoundingPercent: newCompPct,
      currentMargin: prev.consecutiveWins === 0 ? newBase : Math.max(newBase, prev.currentMargin),
    }));
  }, []);

  // 2. PERSISTENCE SAVERS
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    } catch {
      // ignore
    }
  }, [settings]);

  useEffect(() => {
    if (binanceAccount.isSynced) {
      localStorage.setItem(STORAGE_KEYS.BINANCE_ACCOUNT, JSON.stringify(binanceAccount));
    }
  }, [binanceAccount]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.POSITIONS, JSON.stringify(positions));
  }, [positions]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.CLOSED_TRADES, JSON.stringify(closedTrades));
  }, [closedTrades]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.COMPOUNDING, JSON.stringify(compoundingState));
  }, [compoundingState]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(logs.slice(0, 500)));
  }, [logs]);

  // 3. BINANCE ACCOUNT AUTO-SYNC (Fetches Starting Balance, Equity, Platform Fees, Funding Fees & Live Positions)
  const syncBinanceAccount = useCallback(async () => {
    if (!settings.apiKey || !settings.apiSecret) return;

    try {
      const res = await fetch('/api/binance/sync-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: settings.apiKey,
          apiSecret: settings.apiSecret,
          isTestnet: settings.isTestnet,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (typeof data.usedWeight === 'number') {
          setRateLimitStatus(
            checkRateLimit(data.usedWeight, 1200, (settings.rateLimitSafetyCap || 95) / 100)
          );
        }

        if (data.success && data.balance) {
          const b = data.balance;

          setBinanceAccount((prev) => {
            const lockedStarting =
              prev.startingBalance > 0
                ? prev.startingBalance
                : b.totalWalletBalance || b.currentEquity || 0;

            localStorage.setItem(STORAGE_KEYS.STARTING_BALANCE, String(lockedStarting));

            return {
              startingBalance: lockedStarting,
              currentEquity: b.currentEquity || b.totalWalletBalance,
              availableBalance: b.availableBalance,
              realizedPnl: b.totalRealizedPnl,
              unrealizedPnl: b.totalUnrealizedProfit,
              commissionFees: b.totalCommissionFees,
              fundingFees: b.totalFundingFees,
              isSynced: true,
            };
          });

          // Reconcile open positions markPrice & unrealizedPnl with live Binance positions
          if (Array.isArray(data.positions) && data.positions.length > 0) {
            setPositions((prevPositions) => {
              const liveBySymbol = new Map<
                string,
                {
                  symbol: string;
                  side: 'LONG' | 'SHORT';
                  quantity: number;
                  entryPrice: number;
                  markPrice: number;
                  unrealizedProfit: number;
                  leverage: number;
                  margin: number;
                }
              >();
              for (const lp of data.positions) {
                liveBySymbol.set(lp.symbol, lp);
              }

              return prevPositions.map((pos) => {
                const liveMatch = liveBySymbol.get(pos.symbol);
                if (!liveMatch) return pos;
                const markPrice = liveMatch.markPrice > 0 ? liveMatch.markPrice : pos.markPrice;
                const entryPrice = liveMatch.entryPrice > 0 ? liveMatch.entryPrice : pos.entryPrice;
                const margin = liveMatch.margin > 0 ? liveMatch.margin : pos.margin;
                const leverage = liveMatch.leverage > 0 ? liveMatch.leverage : pos.leverage;
                const unrealizedPnl = Number(liveMatch.unrealizedProfit.toFixed(2));
                const unrealizedPnlPercent =
                  margin > 0 ? Number(((unrealizedPnl / margin) * 100).toFixed(2)) : pos.unrealizedPnlPercent;

                return {
                  ...pos,
                  entryPrice,
                  markPrice,
                  margin,
                  leverage,
                  quantity: liveMatch.quantity > 0 ? liveMatch.quantity : pos.quantity,
                  unrealizedPnl,
                  unrealizedPnlPercent,
                };
              });
            });
          }
        }
      }
    } catch {
      // Background sync silent fail
    }
  }, [settings.apiKey, settings.apiSecret, settings.isTestnet, settings.rateLimitSafetyCap]);

  // Auto-sync account immediately on valid credentials and every 30s
  useEffect(() => {
    if (settings.apiKey && settings.apiSecret) {
      const initialTimer = setTimeout(() => {
        syncBinanceAccount();
      }, 0);
      const interval = setInterval(syncBinanceAccount, 30000);
      return () => {
        clearTimeout(initialTimer);
        clearInterval(interval);
      };
    }
  }, [settings.apiKey, settings.apiSecret, syncBinanceAccount]);

  // Execute a position close on Binance and record trade history + compounding
  const finalizePositionClose = useCallback(
    async (
      pos: TradePosition,
      exitPrice: number,
      reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL_CLOSE'
    ) => {
      if (closingIdsRef.current.has(pos.id)) return;
      closingIdsRef.current.add(pos.id);
      setClosingPositionId(pos.id);

      let finalExitPrice = exitPrice;

      // Submit real close order to Binance Futures API if credentials are set
      if (settings.apiKey && settings.apiSecret) {
        try {
          const closeRes = await fetch('/api/binance/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              apiKey: settings.apiKey,
              apiSecret: settings.apiSecret,
              isTestnet: settings.isTestnet,
              action: 'CLOSE',
              symbol: pos.symbol,
              side: pos.side,
              quantity: pos.quantity,
              price: exitPrice,
            }),
          });
          if (closeRes.ok) {
            const closeData = await closeRes.json();
            if (closeData.avgPrice && Number(closeData.avgPrice) > 0) {
              finalExitPrice = Number(closeData.avgPrice);
            }
          }
        } catch {
          // Proceed with local close state update if exchange already closed via TP/SL order
        }
      }

      const priceDiff =
        pos.side === 'LONG' ? finalExitPrice - pos.entryPrice : pos.entryPrice - finalExitPrice;
      const notional = pos.margin * pos.leverage;
      const grossPnl = pos.entryPrice > 0 ? (priceDiff / pos.entryPrice) * notional : 0;
      // Deduct Binance Futures round-trip taker commission (0.05% per side = 0.10% of notional)
      const roundTripFee = notional * 0.001;
      const realizedPnl = Number((grossPnl - roundTripFee).toFixed(2));
      const realizedPnlPercent =
        pos.margin > 0 ? Number(((realizedPnl / pos.margin) * 100).toFixed(2)) : 0;

      const isWin = realizedPnl > 0;

      setCompoundingState((prevComp) => {
        const compoundingResult = calculateNextTradeMargin(prevComp, {
          isWin,
          profit: realizedPnl,
        });

        const closedTradeRecord: ClosedTrade = {
          id: generateUniqueId('trade'),
          symbol: pos.symbol,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice: roundCryptoPrice(finalExitPrice),
          margin: pos.margin,
          leverage: pos.leverage,
          pnl: realizedPnl,
          pnlPercent: realizedPnlPercent,
          entryTime: pos.entryTime,
          exitTime: Date.now(),
          reason,
          isWin,
          compoundingBonusGenerated: compoundingResult.bonusAdded,
        };

        setClosedTrades((prev) => {
          const map = new Map<string, ClosedTrade>();
          map.set(closedTradeRecord.id, closedTradeRecord);
          for (const item of prev) {
            if (!map.has(item.id)) {
              map.set(item.id, item);
            }
          }
          return Array.from(map.values());
        });

        setTradeResultModal({
          isOpen: true,
          isProfit: closedTradeRecord.isWin,
          pnl: closedTradeRecord.pnl,
          pnlPercent: closedTradeRecord.pnlPercent,
          symbol: closedTradeRecord.symbol,
          side: closedTradeRecord.side,
          entryPrice: closedTradeRecord.entryPrice,
          exitPrice: closedTradeRecord.exitPrice,
          reason: closedTradeRecord.reason,
          compoundingBonus: closedTradeRecord.compoundingBonusGenerated,
        });

        appendLog(
          'ORDER',
          isWin ? 'SUCCESS' : 'WARN',
          `${reason.replace('_', ' ')} executed on ${pos.symbol} at $${roundCryptoPrice(finalExitPrice)}. Net PnL (after fees): ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)} (${realizedPnlPercent.toFixed(2)}%). Next trade margin: $${compoundingResult.nextMargin.toFixed(2)}`
        );

        return compoundingResult.newState;
      });

      setPositions((prev) => prev.filter((p) => p.id !== pos.id));
      closingIdsRef.current.delete(pos.id);
      setClosingPositionId(null);
      syncBinanceAccount();
    },
    [appendLog, settings.apiKey, settings.apiSecret, settings.isTestnet, syncBinanceAccount]
  );

  // Scan Market Pairs
  const runMarketScan = useCallback(async () => {
    if (!settings.apiKey || !settings.apiSecret) {
      setSignals([]);
      setIsScanning(false);
      return;
    }

    const safetyCap = settings.rateLimitSafetyCap || 95;
    if (rateLimitStatus.isThrottled || rateLimitStatus.usagePercent >= safetyCap) {
      appendLog(
        'RATE_LIMIT',
        'WARN',
        `API rate limit reached ${rateLimitStatus.usagePercent.toFixed(1)}% (>=${safetyCap}% safety cap). Halting scan cycle and waiting for cooldown.`
      );
      setIsScanning(false);
      return;
    }

    setIsScanning(true);
    try {
      const res = await fetch(
        `/api/binance/scan?testnet=${settings.isTestnet}&safetyCap=${safetyCap}`
      );
      if (res.ok) {
        const data = await res.json();
        if (data.signals && Array.isArray(data.signals)) {
          setSignals(data.signals);
          if (data.candles) {
            setCandlesMap(data.candles);
          }
          if (data.rateLimitStatus) {
            setRateLimitStatus(data.rateLimitStatus);
          }

          // Evaluate Auto-Trade Opportunity
          if (botActive) {
            const topScore = data.signals[0];
            appendLog(
              'SCAN',
              'INFO',
              `Market scan evaluated ${data.signals.length} Binance 5m pairs. Top setup: ${topScore?.symbol || 'None'} (${topScore?.signal || 'NEUTRAL'}, Score: ${topScore?.score || 0}%, Volatility: ${topScore?.volatilityPercent?.toFixed(2) || '0'}%).`
            );

            const openLimit = canOpenNewTrade(positions.length, settings.maxOpenTrades);
            if (openLimit.allowed) {
              const openSymbols = new Set(positions.map((p) => p.symbol));
              const topCandidate = data.signals.find(
                (s: SignalEvaluation) =>
                  !openSymbols.has(s.symbol) &&
                  (s.signal === 'STRONG_BUY' ||
                    s.signal === 'STRONG_SELL' ||
                    (s.signal === 'BUY' && s.score >= 65) ||
                    (s.signal === 'SELL' && s.score >= 65))
              );

              if (topCandidate) {
                appendLog(
                  'SIGNAL',
                  'SUCCESS',
                  `HIGH-PROBABILITY 3-INDICATOR CONVERGENCE: ${topCandidate.signal} on ${topCandidate.symbol} (Score: ${topCandidate.score}%). HVN: ${topCandidate.hvnProfile.priceRelation} (POC $${topCandidate.hvnProfile.pocPrice}), Absorption: ${topCandidate.absorption.type}, Imbalance: ${topCandidate.imbalance.type}. Submitting order to Binance...`
                );

                const tradeMargin = compoundingState.currentMargin;
                const leverage = Math.min(15, Math.max(10, settings.leverage || 10));
                const entryPrice = topCandidate.currentPrice;

                try {
                  const execRes = await fetch('/api/binance/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      apiKey: settings.apiKey,
                      apiSecret: settings.apiSecret,
                      isTestnet: settings.isTestnet,
                      action: 'OPEN',
                      symbol: topCandidate.symbol,
                      side: topCandidate.action, // mapped to BUY/SELL in execute route
                      margin: tradeMargin,
                      leverage,
                      price: entryPrice,
                      stopLoss: topCandidate.slPrice,
                      takeProfit: topCandidate.tpPrice,
                    }),
                  });

                  const execData = await execRes.json();
                  if (!execRes.ok || !execData.success) {
                    appendLog(
                      'ERROR',
                      'ERROR',
                      `Binance Live Order Failed: ${execData.error || 'API Rejected Order'}`
                    );
                    return;
                  }

                  const fillPrice = parseFloat(execData.avgPrice) || entryPrice;
                  const notional = tradeMargin * leverage;
                  const quantity =
                    parseFloat(execData.executedQty) ||
                    Number((notional / fillPrice).toFixed(4));

                  const newPosition: TradePosition = {
                    id: String(execData.orderId || generateUniqueId('pos')),
                    symbol: topCandidate.symbol,
                    side: topCandidate.action as 'LONG' | 'SHORT',
                    entryPrice: fillPrice,
                    markPrice: fillPrice,
                    margin: tradeMargin,
                    leverage,
                    quantity: quantity > 0 ? quantity : 0.001,
                    stopLoss: topCandidate.slPrice,
                    takeProfit: topCandidate.tpPrice,
                    unrealizedPnl: 0,
                    unrealizedPnlPercent: 0,
                    entryTime: Date.now(),
                    slOrderId: execData.slOrderId,
                    tpOrderId: execData.tpOrderId,
                  };

                  let didAdd = false;
                  setPositions((prev) => {
                    if (prev.length >= settings.maxOpenTrades) return prev;
                    if (prev.some((p) => p.symbol === topCandidate.symbol)) return prev;
                    didAdd = true;
                    return [...prev, newPosition];
                  });

                  if (didAdd) {
                    appendLog(
                      'ORDER',
                      'SUCCESS',
                      `LIVE BINANCE ORDER EXECUTED: ${topCandidate.action} (${execData.orderSide || (topCandidate.action === 'LONG' ? 'BUY' : 'SELL')}) on ${topCandidate.symbol} at $${newPosition.entryPrice}. Margin: $${tradeMargin.toFixed(2)} (${leverage}x Isolated). Indicator TP: $${topCandidate.tpPrice} / SL: $${topCandidate.slPrice}. Order ID: ${execData.orderId}`,
                      {
                        signal: topCandidate.signal,
                        score: topCandidate.score,
                        reasons: topCandidate.reasons,
                      }
                    );
                    syncBinanceAccount();
                  }
                } catch (apiErr: unknown) {
                  const err = apiErr as Error;
                  appendLog('ERROR', 'ERROR', `Live API execution exception: ${err.message}`);
                }
              } else {
                appendLog(
                  'SCAN',
                  'INFO',
                  `No pairs met entry threshold (>=65% score or STRONG signal) in this cycle. Standing by for next ${settings.scanIntervalSeconds || 15}s scan.`
                );
              }
            } else {
              appendLog(
                'SYSTEM',
                'INFO',
                `Max positions capacity reached (${positions.length}/${settings.maxOpenTrades}). Monitoring open trades for Indicator TP/SL.`
              );
            }
          }
        }
      }
    } catch (err: unknown) {
      const error = err as Error;
      appendLog('ERROR', 'ERROR', `Scan error: ${error.message}`);
    } finally {
      setIsScanning(false);
      setScanCountdown(settings.scanIntervalSeconds || 15);
    }
  }, [
    botActive,
    compoundingState.currentMargin,
    positions,
    rateLimitStatus.isThrottled,
    rateLimitStatus.usagePercent,
    settings.apiKey,
    settings.apiSecret,
    settings.isTestnet,
    settings.leverage,
    settings.maxOpenTrades,
    settings.rateLimitSafetyCap,
    settings.scanIntervalSeconds,
    appendLog,
    syncBinanceAccount,
  ]);

  const runMarketScanRef = useRef(runMarketScan);
  useEffect(() => {
    runMarketScanRef.current = runMarketScan;
  }, [runMarketScan]);

  // Automated Scan Loop
  useEffect(() => {
    if (!botActive) return;

    const cycleTime = settings.scanIntervalSeconds || 15;
    const timer = setInterval(() => {
      setScanCountdown((prev) => {
        if (prev <= 1) {
          setTimeout(() => {
            runMarketScanRef.current();
          }, 0);
          return cycleTime;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [botActive, settings.scanIntervalSeconds]);

  // Position Real-Price Update & Indicator-Driven Dynamic TP/SL Engine (0% Simulation)
  useEffect(() => {
    if (positions.length === 0) return;

    const updateInterval = setInterval(() => {
      const toClose: {
        pos: TradePosition;
        exitPrice: number;
        reason: 'TAKE_PROFIT' | 'STOP_LOSS';
      }[] = [];

      setPositions((prevPositions) =>
        prevPositions.map((pos) => {
          const liveCandles = candlesMap[pos.symbol];
          // Use real Binance kline close or keep synced Binance markPrice (no Math.random() simulation)
          const currentPrice =
            liveCandles && liveCandles.length > 0
              ? roundCryptoPrice(liveCandles[liveCandles.length - 1].close)
              : pos.markPrice;

          const priceDiff =
            pos.side === 'LONG' ? currentPrice - pos.entryPrice : pos.entryPrice - currentPrice;
          const notional = pos.margin * pos.leverage;
          const grossPnl = pos.entryPrice > 0 ? (priceDiff / pos.entryPrice) * notional : 0;
          const unrealizedPnl = Number(grossPnl.toFixed(2));
          const unrealizedPnlPercent =
            pos.margin > 0 ? Number(((unrealizedPnl / pos.margin) * 100).toFixed(2)) : 0;

          let isHitTP = false;
          let isHitSL = false;

          if (pos.takeProfit > 0 && pos.stopLoss > 0) {
            if (pos.side === 'LONG') {
              if (currentPrice >= pos.takeProfit) isHitTP = true;
              if (currentPrice <= pos.stopLoss) isHitSL = true;
            } else {
              if (currentPrice <= pos.takeProfit) isHitTP = true;
              if (currentPrice >= pos.stopLoss) isHitSL = true;
            }
          }

          if ((isHitTP || isHitSL) && !closingIdsRef.current.has(pos.id)) {
            toClose.push({
              pos: { ...pos, markPrice: currentPrice, unrealizedPnl, unrealizedPnlPercent },
              exitPrice: currentPrice,
              reason: isHitTP ? 'TAKE_PROFIT' : 'STOP_LOSS',
            });
          }

          return {
            ...pos,
            markPrice: currentPrice,
            unrealizedPnl,
            unrealizedPnlPercent,
          };
        })
      );

      for (const item of toClose) {
        finalizePositionClose(item.pos, item.exitPrice, item.reason);
      }
    }, 2000);

    return () => clearInterval(updateInterval);
  }, [candlesMap, positions.length, finalizePositionClose]);

  // Close Position Manually on Binance & Local State
  const handleClosePosition = useCallback(
    (posId: string) => {
      const pos = positions.find((p) => p.id === posId);
      if (!pos) return;
      finalizePositionClose(pos, pos.markPrice, 'MANUAL_CLOSE');
    },
    [positions, finalizePositionClose]
  );

  // Manual Trade Execution from Scanner
  const handleManualExecute = useCallback(
    async (sig: SignalEvaluation) => {
      const check = canOpenNewTrade(positions.length, settings.maxOpenTrades);
      if (!check.allowed) {
        appendLog('ORDER', 'WARN', `Cannot open trade: ${check.reason}`);
        return;
      }

      const tradeMargin = compoundingState.currentMargin;
      const leverage = Math.min(15, Math.max(10, settings.leverage || 10));

      try {
        const execRes = await fetch('/api/binance/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: settings.apiKey,
            apiSecret: settings.apiSecret,
            isTestnet: settings.isTestnet,
            action: 'OPEN',
            symbol: sig.symbol,
            side: sig.action,
            margin: tradeMargin,
            leverage,
            price: sig.currentPrice,
            stopLoss: sig.slPrice,
            takeProfit: sig.tpPrice,
          }),
        });

        const execData = await execRes.json();
        if (!execRes.ok || !execData.success) {
          appendLog(
            'ERROR',
            'ERROR',
            `Binance Live Order Failed: ${execData.error || 'API Rejected Order'}`
          );
          return;
        }

        const entryPrice = parseFloat(execData.avgPrice) || sig.currentPrice;
        const notional = tradeMargin * leverage;
        const quantity =
          parseFloat(execData.executedQty) || Number((notional / entryPrice).toFixed(4));

        const newPos: TradePosition = {
          id: String(execData.orderId || generateUniqueId('pos')),
          symbol: sig.symbol,
          side: sig.action as 'LONG' | 'SHORT',
          entryPrice,
          markPrice: entryPrice,
          margin: tradeMargin,
          leverage,
          quantity: quantity > 0 ? quantity : 0.001,
          stopLoss: sig.slPrice,
          takeProfit: sig.tpPrice,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          entryTime: Date.now(),
          slOrderId: execData.slOrderId,
          tpOrderId: execData.tpOrderId,
        };

        let didAdd = false;
        setPositions((prev) => {
          if (prev.length >= settings.maxOpenTrades) return prev;
          if (prev.some((p) => p.symbol === sig.symbol)) return prev;
          didAdd = true;
          return [...prev, newPos];
        });

        if (didAdd) {
          appendLog(
            'ORDER',
            'SUCCESS',
            `LIVE BINANCE MANUAL ORDER EXECUTED: ${sig.action} on ${sig.symbol} at $${entryPrice}. Margin: $${tradeMargin.toFixed(2)} (${leverage}x Isolated). Indicator TP: $${sig.tpPrice} / SL: $${sig.slPrice}. Order ID: ${execData.orderId}`
          );
          syncBinanceAccount();
        }
      } catch (apiErr: unknown) {
        const err = apiErr as Error;
        appendLog('ERROR', 'ERROR', `Live API execution exception: ${err.message}`);
      }
    },
    [
      appendLog,
      compoundingState.currentMargin,
      positions.length,
      settings.apiKey,
      settings.apiSecret,
      settings.isTestnet,
      settings.leverage,
      settings.maxOpenTrades,
      syncBinanceAccount,
    ]
  );

  // Test Binance Connection
  const handleTestConnection = async (overrideSettings?: BotSettings) => {
    const active = overrideSettings || settings;
    setIsTestingConnection(true);
    try {
      const res = await fetch('/api/binance/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: active.apiKey,
          apiSecret: active.apiSecret,
          isTestnet: active.isTestnet,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        const isOk = Boolean(data.auth?.valid);
        setConnectionResult({
          tested: true,
          success: isOk,
          message:
            data.auth?.message ||
            (isOk
              ? 'Connected to Binance Futures successfully'
              : 'Binance ping succeeded, but API key authentication failed'),
          latencyMs: data.ping?.latencyMs,
          balance: data.auth?.balance,
        });

        appendLog(
          'SYSTEM',
          isOk ? 'SUCCESS' : 'WARN',
          `Binance connection test: ${data.auth?.message || data.ping?.status}. Latency: ${data.ping?.latencyMs ?? 0}ms.`
        );

        if (isOk) {
          syncBinanceAccount();
        }
      } else {
        setConnectionResult({
          tested: true,
          success: false,
          message: data.error || 'Connection verification failed',
        });
        appendLog('ERROR', 'ERROR', `Binance connection test failed: ${data.error}`);
      }
    } catch (err: unknown) {
      const error = err as Error;
      setConnectionResult({
        tested: true,
        success: false,
        message: error.message || 'Network error reaching test endpoint',
      });
      appendLog('ERROR', 'ERROR', `Network error during Binance test: ${error.message}`);
    } finally {
      setIsTestingConnection(false);
    }
  };

  // Performance calculations
  const totalPnl = closedTrades.reduce((acc, t) => acc + t.pnl, 0);
  const winningTrades = closedTrades.filter((t) => t.isWin).length;
  const losingTrades = closedTrades.length - winningTrades;
  const winRate = closedTrades.length > 0 ? (winningTrades / closedTrades.length) * 100 : 0;
  const baseStartingCapital =
    binanceAccount.startingBalance > 0 ? binanceAccount.startingBalance : 100.0;
  const totalPnlPercent = (totalPnl / baseStartingCapital) * 100;

  // Bot Start/Pause handlers
  const handleStartBot = useCallback(
    (updatedSettings?: BotSettings) => {
      const activeSettings = updatedSettings || settings;
      if (!activeSettings.apiKey || !activeSettings.apiSecret) {
        appendLog(
          'SYSTEM',
          'WARN',
          'Cannot start bot: Please enter your Binance Futures API Key and Secret in Settings first.'
        );
        setActiveTab('settings');
        return;
      }

      if (updatedSettings) {
        applyUpdatedSettings(updatedSettings);
      }
      setBotActive(true);
      setActiveTab('positions');
      setScanCountdown(activeSettings.scanIntervalSeconds || 15);
      runMarketScan();
      syncBinanceAccount();
      appendLog(
        'SYSTEM',
        'SUCCESS',
        `Trade Master bot STARTED! Scanning 5m pairs on ${activeSettings.scanIntervalSeconds || 15}s cycle with $${activeSettings.baseMargin.toFixed(2)} base margin (${activeSettings.leverage}x isolated).`
      );
    },
    [settings, runMarketScan, appendLog, syncBinanceAccount, applyUpdatedSettings]
  );

  const handlePauseBot = useCallback(() => {
    setBotActive(false);
    setScanCountdown(settings.scanIntervalSeconds || 15);
    appendLog('SYSTEM', 'WARN', 'Trade Master bot PAUSED by user. Automated scanning halted.');
  }, [settings.scanIntervalSeconds, appendLog]);

  const handleToggleBot = useCallback(() => {
    if (botActive) {
      handlePauseBot();
    } else {
      if (!settings.apiKey || !settings.apiSecret) {
        appendLog(
          'SYSTEM',
          'WARN',
          'Cannot start bot: Binance Futures API Key & Secret are required. Please configure them in Settings.'
        );
        setActiveTab('settings');
        return;
      }
      handleStartBot();
    }
  }, [botActive, handlePauseBot, handleStartBot, settings.apiKey, settings.apiSecret, appendLog]);

  const selectedSignal = signals.find((s) => s.symbol === selectedSymbol) || signals[0];
  const activeSymbolForChart = selectedSignal?.symbol || selectedSymbol;
  const selectedCandles = candlesMap[activeSymbolForChart] || [];
  const selectedActivePosition = positions.find((p) => p.symbol === activeSymbolForChart);
  const availableSymbols = signals.map((s) => s.symbol);

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* 1. Header (Top Bar Contract) */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        botActive={botActive}
        onToggleBot={handleToggleBot}
        openPositionsCount={positions.length}
        maxOpenPositions={settings.maxOpenTrades}
        hasApiKey={Boolean(settings.apiKey && settings.apiSecret)}
      />

      {/* 2. Main Terminal Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6">
        {/* KPI Performance Strip */}
        <KpiMetricsStrip
          totalPnl={totalPnl}
          totalPnlPercent={totalPnlPercent}
          winRate={winRate}
          totalTrades={closedTrades.length}
          winningTrades={winningTrades}
          losingTrades={losingTrades}
          openPositionsCount={positions.length}
          maxOpenPositions={settings.maxOpenTrades}
          compoundingState={compoundingState}
          rateLimitStatus={rateLimitStatus}
          scanCountdown={scanCountdown}
          scanIntervalSeconds={settings.scanIntervalSeconds}
          isScanning={isScanning}
          botActive={botActive}
          binanceAccount={binanceAccount}
        />

        {/* Tab 1: Active Positions Dashboard, PnL Chart & Selected Symbol Order Flow Chart */}
        {activeTab === 'positions' && (
          <div className="space-y-6">
            <PnlChartWidget
              trades={closedTrades}
              totalPnl={totalPnl}
              startingBalance={binanceAccount.startingBalance}
              currentEquity={binanceAccount.currentEquity}
              winRate={winRate}
              compoundingMargin={compoundingState.currentMargin}
              apiSafetyPercent={Math.max(0, 100 - rateLimitStatus.usagePercent)}
            />
            <ActivePositions
              positions={positions}
              onClosePosition={handleClosePosition}
              onSelectSymbol={(sym) => setSelectedSymbol(sym)}
              selectedSymbol={activeSymbolForChart}
              maxOpenPositions={settings.maxOpenTrades}
              leverage={settings.leverage}
              closingPositionId={closingPositionId}
            />
            {selectedCandles.length > 0 && (
              <InteractiveChart
                symbol={activeSymbolForChart}
                candles={selectedCandles}
                signal={selectedSignal}
                activePosition={selectedActivePosition}
                availableSymbols={availableSymbols}
                onSelectSymbol={(sym) => setSelectedSymbol(sym)}
                leverage={settings.leverage}
                scanIntervalSeconds={settings.scanIntervalSeconds}
              />
            )}
          </div>
        )}

        {/* Tab 2: Dedicated Market Scanner Page + Interactive 5m Order Flow Chart */}
        {activeTab === 'scanner' && (
          <div className="space-y-6">
            {Boolean(settings.apiKey && settings.apiSecret) && (
              <InteractiveChart
                symbol={activeSymbolForChart}
                candles={selectedCandles}
                signal={selectedSignal}
                activePosition={selectedActivePosition}
                availableSymbols={availableSymbols}
                onSelectSymbol={(sym) => setSelectedSymbol(sym)}
                leverage={settings.leverage}
                scanIntervalSeconds={settings.scanIntervalSeconds}
              />
            )}
            <ScannerTable
              signals={signals}
              selectedSymbol={activeSymbolForChart}
              onSelectSymbol={(sym) => setSelectedSymbol(sym)}
              onManualExecute={handleManualExecute}
              isMaxPositionsReached={positions.length >= settings.maxOpenTrades}
              botActive={botActive}
              scanCountdown={scanCountdown}
              scanIntervalSeconds={settings.scanIntervalSeconds}
              leverage={settings.leverage}
              isScanning={isScanning}
              hasApiKey={Boolean(settings.apiKey && settings.apiSecret)}
              onGoToSettings={() => setActiveTab('settings')}
            />
          </div>
        )}

        {/* Tab 3: Trade History & Compounding Pool */}
        {activeTab === 'history' && (
          <TradeHistory trades={closedTrades} compoundingState={compoundingState} />
        )}

        {/* Tab 4: Diagnostics Log */}
        {activeTab === 'logs' && (
          <DiagnosticsLog logs={logs} onClearLogs={() => setLogs([])} />
        )}

        {/* Tab 5: Settings */}
        {activeTab === 'settings' && (
          <SettingsView
            key={`${settings.apiKey}-${settings.baseMargin}-${settings.leverage}-${settings.compoundingPercent}`}
            settings={settings}
            onUpdateSettings={(newSet) => {
              applyUpdatedSettings(newSet);
              appendLog(
                'SYSTEM',
                'INFO',
                `Bot settings updated ($${newSet.baseMargin.toFixed(2)} Base Margin · ${newSet.leverage}x Isolated · ${newSet.compoundingPercent}% Compounding).`
              );
              syncBinanceAccount();
            }}
            onTestConnection={handleTestConnection}
            isTestingConnection={isTestingConnection}
            connectionResult={connectionResult}
            botActive={botActive}
            onStartBot={handleStartBot}
            onPauseBot={handlePauseBot}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-4 px-6 text-center text-xs text-slate-500 font-mono">
        Trade Master · Binance Futures Terminal · ${settings.baseMargin.toFixed(2)} Base Margin · {settings.leverage}x Isolated (10x–15x)
      </footer>

      {/* Full-Screen Trade Result Celebration / Sad Mode Overlay */}
      <TradeResultOverlay
        result={tradeResultModal}
        onClose={() => setTradeResultModal(null)}
      />
    </div>
  );
}
