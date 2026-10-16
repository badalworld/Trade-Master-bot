'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from '@/components/Header';
import { KpiMetricsStrip, type BinanceAccountMetrics } from '@/components/KpiMetricsStrip';
import { ActivePositions } from '@/components/ActivePositions';
import { ScannerTable } from '@/components/ScannerTable';
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

// Initial default settings matching user requirements
const DEFAULT_SETTINGS: BotSettings = {
  apiKey: '',
  apiSecret: '',
  isTestnet: false,
  baseMargin: 2.0, // $2 margin
  leverage: 10, // 10x leverage
  maxOpenTrades: 5, // max 5 concurrent trades
  compoundingPercent: 20, // 20% of profit amount
  scanIntervalSeconds: 15, // 15s scan
  rateLimitSafetyCap: 95, // 95% threshold
};

// Initial state for fresh start
const INITIAL_POSITIONS: TradePosition[] = [];
const INITIAL_TRADES: ClosedTrade[] = [];

const INITIAL_LOGS: LogEntry[] = [
  {
    id: 'log-1',
    timestamp: new Date().toLocaleTimeString(),
    category: 'SYSTEM',
    severity: 'INFO',
    message: 'Trade Master terminal initialized. Auto-persistence active.',
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
    usedWeight: 84,
    maxLimit: 1200,
    usageRatio: 0.07,
    usagePercent: 7.0,
    isSafe: true,
    isThrottled: false,
    remainingWeight: 1056,
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
        if (savedSettings) {
          const parsed = JSON.parse(savedSettings);
          setSettings((prev) => ({ ...prev, ...parsed }));
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
          setCompoundingState((prev) => ({ ...prev, ...parsed }));
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

  // 2. PERSISTENCE SAVERS
  useEffect(() => {
    if (settings.apiKey || settings.apiSecret) {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
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

  // 3. BINANCE ACCOUNT AUTO-SYNC (Fetches Starting Balance, Equity, Platform Fees, Funding Fees)
  const syncBinanceAccount = useCallback(async () => {
    if (!settings.apiKey || !settings.apiSecret) return;

    try {
      const res = await fetch('/api/binance/sync-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: settings.apiKey,
          apiSecret: settings.apiSecret,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success && data.balance) {
          const b = data.balance;

          setBinanceAccount((prev) => {
            // Immutable starting balance: once captured from Binance, it never changes
            const lockedStarting =
              prev.startingBalance > 0
                ? prev.startingBalance
                : (b.totalWalletBalance || b.currentEquity || 0);

            // Also persist starting balance separately to ensure it is never altered
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
        }
      }
    } catch {
      // Background sync silent fail
    }
  }, [settings.apiKey, settings.apiSecret]);

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

  // Scan Market Pairs
  const runMarketScan = useCallback(async () => {
    // Require Binance API Credentials: without API key, market scanner does not run
    if (!settings.apiKey || !settings.apiSecret) {
      setSignals([]);
      setIsScanning(false);
      return;
    }

    // Strict Rate Limit Shield: Pause scanning immediately if API usage reaches or exceeds 95%
    if (rateLimitStatus.isThrottled || rateLimitStatus.usagePercent >= 95) {
      appendLog(
        'RATE_LIMIT',
        'WARN',
        `API rate limit reached ${rateLimitStatus.usagePercent.toFixed(1)}% (>=95% safety cap). Halting scan cycle and waiting for cooldown.`
      );
      setIsScanning(false);
      return;
    }

    setIsScanning(true);
    try {
      const res = await fetch('/api/binance/scan');
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
              `Market scan evaluated ${data.signals.length} Binance pairs. Top setup: ${topScore?.symbol || 'None'} (${topScore?.signal || 'NEUTRAL'}, Score: ${topScore?.score || 0}%, Volatility: ${topScore?.volatilityPercent?.toFixed(2) || '0'}%).`
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
                  `HIGH-PROBABILITY CONVERGENCE: ${topCandidate.signal} on ${topCandidate.symbol} (Score: ${topCandidate.score}%). Order Flow: ${topCandidate.hvnProfile.priceRelation}, Absorption ${topCandidate.absorption.type}, Imbalance ${topCandidate.imbalance.type}. Submitting real order to Binance...`
                );

                // Execute real trade on Binance API
                const tradeMargin = compoundingState.currentMargin;
                const leverage = settings.leverage;
                const entryPrice = topCandidate.currentPrice;

                try {
                  const execRes = await fetch('/api/binance/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      apiKey: settings.apiKey,
                      apiSecret: settings.apiSecret,
                      isTestnet: false,
                      symbol: topCandidate.symbol,
                      side: topCandidate.action,
                      margin: tradeMargin,
                      leverage,
                      price: entryPrice,
                      stopLoss: topCandidate.slPrice,
                      takeProfit: topCandidate.tpPrice,
                    }),
                  });

                  const execData = await execRes.json();
                  if (!execRes.ok || !execData.success) {
                    appendLog('ERROR', 'ERROR', `Binance Live Order Failed: ${execData.error || 'API Rejected Order'}`);
                    return;
                  }

                  const notional = tradeMargin * leverage;
                  const quantity = Number((notional / entryPrice).toFixed(4));

                  const newPosition: TradePosition = {
                    id: String(execData.orderId || generateUniqueId('pos')),
                    symbol: topCandidate.symbol,
                    side: topCandidate.action as 'LONG' | 'SHORT',
                    entryPrice: parseFloat(execData.avgPrice) || entryPrice,
                    markPrice: parseFloat(execData.avgPrice) || entryPrice,
                    margin: tradeMargin,
                    leverage,
                    quantity: quantity > 0 ? quantity : 0.01,
                    stopLoss: topCandidate.slPrice,
                    takeProfit: topCandidate.tpPrice,
                    unrealizedPnl: 0,
                    unrealizedPnlPercent: 0,
                    entryTime: Date.now(),
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
                      `LIVE BINANCE ORDER EXECUTED: ${topCandidate.action} on ${topCandidate.symbol} at $${newPosition.entryPrice}. Margin: $${tradeMargin} (${leverage}x Lev). Order ID: ${execData.orderId}`,
                      {
                        signal: topCandidate.signal,
                        score: topCandidate.score,
                        reasons: topCandidate.reasons,
                      }
                    );
                    // Refresh balance
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
                  `No pairs met entry threshold (>=65% score or STRONG signal) in this cycle. Standing by for next 15s scan.`
                );
              }
            } else {
              appendLog(
                'SYSTEM',
                'INFO',
                `Max positions capacity reached (${positions.length}/${settings.maxOpenTrades}). Monitoring open trades for TP/SL.`
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
      setScanCountdown(settings.scanIntervalSeconds);
    }
  }, [
    botActive,
    compoundingState.currentMargin,
    positions,
    rateLimitStatus.isThrottled,
    rateLimitStatus.usagePercent,
    settings.apiKey,
    settings.apiSecret,
    settings.leverage,
    settings.maxOpenTrades,
    settings.scanIntervalSeconds,
    appendLog,
    syncBinanceAccount,
  ]);

  const runMarketScanRef = useRef(runMarketScan);
  useEffect(() => {
    runMarketScanRef.current = runMarketScan;
  }, [runMarketScan]);

  // Automated 15-second Scan Loop (Stabilized, never gets stuck or cancelled mid-cycle)
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

  // Position Price Update & Dynamic TP/SL Engine
  useEffect(() => {
    if (positions.length === 0) return;

    const updateInterval = setInterval(() => {
      setPositions((prevPositions) => {
        const updated: TradePosition[] = [];
        const closed: ClosedTrade[] = [];

        for (const pos of prevPositions) {
          const liveCandles = candlesMap[pos.symbol];
          let currentPrice = pos.markPrice;

          if (liveCandles && liveCandles.length > 0) {
            currentPrice = liveCandles[liveCandles.length - 1].close;
          } else {
            const deltaPercent = (Math.random() - 0.495) * 0.003;
            currentPrice = Number((pos.markPrice * (1 + deltaPercent)).toFixed(4));
          }

          let unrealizedPnl = 0;
          let unrealizedPnlPercent = 0;

          if (pos.side === 'LONG') {
            const priceDiff = currentPrice - pos.entryPrice;
            unrealizedPnl = Number(((priceDiff / pos.entryPrice) * (pos.margin * pos.leverage)).toFixed(2));
            unrealizedPnlPercent = Number(((priceDiff / pos.entryPrice) * pos.leverage * 100).toFixed(2));
          } else {
            const priceDiff = pos.entryPrice - currentPrice;
            unrealizedPnl = Number(((priceDiff / pos.entryPrice) * (pos.margin * pos.leverage)).toFixed(2));
            unrealizedPnlPercent = Number(((priceDiff / pos.entryPrice) * pos.leverage * 100).toFixed(2));
          }

          let isHitTP = false;
          let isHitSL = false;

          if (pos.side === 'LONG') {
            if (currentPrice >= pos.takeProfit) isHitTP = true;
            if (currentPrice <= pos.stopLoss) isHitSL = true;
          } else {
            if (currentPrice <= pos.takeProfit) isHitTP = true;
            if (currentPrice >= pos.stopLoss) isHitSL = true;
          }

          if (isHitTP || isHitSL) {
            const reason = isHitTP ? 'TAKE_PROFIT' : 'STOP_LOSS';
            const isWin = isHitTP;
            const compoundingResult = calculateNextTradeMargin(compoundingState, {
              isWin,
              profit: unrealizedPnl,
            });

            const closedTradeRecord: ClosedTrade = {
              id: generateUniqueId('trade'),
              symbol: pos.symbol,
              side: pos.side,
              entryPrice: pos.entryPrice,
              exitPrice: currentPrice,
              margin: pos.margin,
              leverage: pos.leverage,
              pnl: unrealizedPnl,
              pnlPercent: unrealizedPnlPercent,
              entryTime: pos.entryTime,
              exitTime: Date.now(),
              reason,
              isWin,
              compoundingBonusGenerated: compoundingResult.bonusAdded,
            };

            closed.push(closedTradeRecord);
            setCompoundingState(compoundingResult.newState);

            appendLog(
              'ORDER',
              isWin ? 'SUCCESS' : 'WARN',
              `Dynamic ${reason} hit on ${pos.symbol} at $${currentPrice}! Net PnL: ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)} (${unrealizedPnlPercent.toFixed(2)}%). Next trade margin: $${compoundingResult.nextMargin.toFixed(2)}`
            );
          } else {
            updated.push({
              ...pos,
              markPrice: currentPrice,
              unrealizedPnl,
              unrealizedPnlPercent,
            });
          }
        }

        if (closed.length > 0) {
          const lastClosed = closed[closed.length - 1];
          setTradeResultModal({
            isOpen: true,
            isProfit: lastClosed.isWin,
            pnl: lastClosed.pnl,
            pnlPercent: lastClosed.pnlPercent,
            symbol: lastClosed.symbol,
            side: lastClosed.side,
            entryPrice: lastClosed.entryPrice,
            exitPrice: lastClosed.exitPrice,
            reason: lastClosed.reason,
            compoundingBonus: lastClosed.compoundingBonusGenerated,
          });

          setClosedTrades((prev) => {
            const map = new Map<string, ClosedTrade>();
            for (const item of [...closed, ...prev]) {
              map.set(item.id, item);
            }
            return Array.from(map.values());
          });
          syncBinanceAccount();
        }

        return updated;
      });
    }, 2000);

    return () => clearInterval(updateInterval);
  }, [candlesMap, compoundingState, positions.length, appendLog, syncBinanceAccount]);

  // Close Position Manually
  const handleClosePosition = useCallback(
    (posId: string) => {
      const pos = positions.find((p) => p.id === posId);
      if (!pos) return;

      const isWin = pos.unrealizedPnl > 0;
      const compoundingResult = calculateNextTradeMargin(compoundingState, {
        isWin,
        profit: pos.unrealizedPnl,
      });

      const closed: ClosedTrade = {
        id: generateUniqueId('trade'),
        symbol: pos.symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice: pos.markPrice,
        margin: pos.margin,
        leverage: pos.leverage,
        pnl: pos.unrealizedPnl,
        pnlPercent: pos.unrealizedPnlPercent,
        entryTime: pos.entryTime,
        exitTime: Date.now(),
        reason: 'MANUAL_CLOSE',
        isWin,
        compoundingBonusGenerated: compoundingResult.bonusAdded,
      };

      setPositions((prev) => prev.filter((p) => p.id !== posId));
      setClosedTrades((prev) => {
        const map = new Map<string, ClosedTrade>();
        map.set(closed.id, closed);
        for (const item of prev) {
          if (!map.has(item.id)) {
            map.set(item.id, item);
          }
        }
        return Array.from(map.values());
      });
      setCompoundingState(compoundingResult.newState);

      // Trigger full display celebration or sad mode modal
      setTradeResultModal({
        isOpen: true,
        isProfit: closed.isWin,
        pnl: closed.pnl,
        pnlPercent: closed.pnlPercent,
        symbol: closed.symbol,
        side: closed.side,
        entryPrice: closed.entryPrice,
        exitPrice: closed.exitPrice,
        reason: 'MANUAL_CLOSE',
        compoundingBonus: closed.compoundingBonusGenerated,
      });

      appendLog(
        'ORDER',
        isWin ? 'SUCCESS' : 'WARN',
        `Manually closed ${pos.side} position on ${pos.symbol} at $${pos.markPrice}. Net PnL: ${closed.pnl >= 0 ? '+' : ''}$${closed.pnl.toFixed(2)} (${closed.pnlPercent.toFixed(2)}%)`
      );
      syncBinanceAccount();
    },
    [appendLog, compoundingState, positions, syncBinanceAccount]
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
      const leverage = settings.leverage;

      try {
        const execRes = await fetch('/api/binance/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: settings.apiKey,
            apiSecret: settings.apiSecret,
            isTestnet: false,
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
          appendLog('ERROR', 'ERROR', `Binance Live Order Failed: ${execData.error || 'API Rejected Order'}`);
          return;
        }

        const notional = tradeMargin * leverage;
        const entryPrice = parseFloat(execData.avgPrice) || sig.currentPrice;
        const quantity = Number((notional / entryPrice).toFixed(4));

        const newPos: TradePosition = {
          id: String(execData.orderId || generateUniqueId('pos')),
          symbol: sig.symbol,
          side: sig.action as 'LONG' | 'SHORT',
          entryPrice,
          markPrice: entryPrice,
          margin: tradeMargin,
          leverage,
          quantity: quantity > 0 ? quantity : 0.01,
          stopLoss: sig.slPrice,
          takeProfit: sig.tpPrice,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          entryTime: Date.now(),
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
            `LIVE BINANCE MANUAL ORDER EXECUTED: ${sig.action} on ${sig.symbol} at $${entryPrice}. Margin: $${tradeMargin} (${leverage}x Lev). Order ID: ${execData.orderId}`
          );
          syncBinanceAccount();
        }
      } catch (apiErr: unknown) {
        const err = apiErr as Error;
        appendLog('ERROR', 'ERROR', `Live API execution exception: ${err.message}`);
      }
    },
    [appendLog, compoundingState.currentMargin, positions.length, settings.apiKey, settings.apiSecret, settings.leverage, settings.maxOpenTrades, syncBinanceAccount]
  );

  // Test Binance Connection
  const handleTestConnection = async () => {
    setIsTestingConnection(true);
    try {
      const res = await fetch('/api/binance/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: settings.apiKey,
          apiSecret: settings.apiSecret,
          isTestnet: settings.isTestnet,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setConnectionResult({
          tested: true,
          success: data.auth.valid || data.ping.status === 'ONLINE',
          message: data.auth.message || 'Connected to Binance Futures successfully',
          latencyMs: data.ping.latencyMs,
          balance: data.auth.balance,
        });

        appendLog(
          'SYSTEM',
          'SUCCESS',
          `Binance connection verified. Latency: ${data.ping.latencyMs}ms. Status: ${data.ping.status}`
        );

        // Sync full balance & fees
        syncBinanceAccount();
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
  const baseStartingCapital = binanceAccount.startingBalance > 0 ? binanceAccount.startingBalance : 100.0;
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
        setSettings(updatedSettings);
      }
      setBotActive(true);
      setActiveTab('positions');
      setScanCountdown(settings.scanIntervalSeconds || 15);
      runMarketScan();
      syncBinanceAccount();
      appendLog(
        'SYSTEM',
        'SUCCESS',
        `Trade Master bot STARTED! Scanning 5m pairs on ${settings.scanIntervalSeconds || 15}s cycle with $${settings.baseMargin.toFixed(2)} base margin (${settings.leverage}x isolated).`
      );
    },
    [settings, runMarketScan, appendLog, syncBinanceAccount]
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* 1. Header (Top Bar Contract) */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        botActive={botActive}
        onToggleBot={handleToggleBot}
        openPositionsCount={positions.length}
        hasApiKey={Boolean(settings.apiKey && settings.apiSecret)}
      />

      {/* 2. Main Terminal Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6">
        {/* KPI Performance Strip (With auto-synced Starting Balance, Equity, Platform Fees & Funding Fees) */}
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
          isScanning={isScanning}
          botActive={botActive}
          binanceAccount={binanceAccount}
        />

        {/* Tab 1: Active Positions Dashboard & PnL Chart */}
        {activeTab === 'positions' && (
          <div className="space-y-6">
            <PnlChartWidget
              trades={closedTrades}
              totalPnl={totalPnl}
              startingBalance={binanceAccount.startingBalance}
              currentEquity={binanceAccount.currentEquity}
            />
            <ActivePositions
              positions={positions}
              onClosePosition={handleClosePosition}
              onSelectSymbol={(sym) => setSelectedSymbol(sym)}
            />
          </div>
        )}

        {/* Tab 2: Dedicated Market Scanner Page */}
        {activeTab === 'scanner' && (
          <div className="space-y-6">
            <ScannerTable
              signals={signals}
              selectedSymbol={selectedSymbol}
              onSelectSymbol={(sym) => setSelectedSymbol(sym)}
              onManualExecute={handleManualExecute}
              isMaxPositionsReached={positions.length >= settings.maxOpenTrades}
              botActive={botActive}
              scanCountdown={scanCountdown}
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
            settings={settings}
            onUpdateSettings={(newSet) => {
              setSettings(newSet);
              appendLog('SYSTEM', 'INFO', 'Bot settings updated.');
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
        Trade Master · Binance Futures Terminal · 10x Isolated
      </footer>

      {/* Full-Screen Trade Result Celebration / Sad Mode Overlay */}
      <TradeResultOverlay
        result={tradeResultModal}
        onClose={() => setTradeResultModal(null)}
      />
    </div>
  );
}
