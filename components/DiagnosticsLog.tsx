'use client';

import React, { useState } from 'react';
import { motion } from 'motion/react';
import {
  FileText,
  Search,
  Download,
  Trash2,
  AlertTriangle,
  Info,
  CheckCircle,
  Zap,
  Filter,
} from 'lucide-react';

export interface LogEntry {
  id: string;
  timestamp: string;
  category: 'SYSTEM' | 'SCAN' | 'SIGNAL' | 'ORDER' | 'ERROR' | 'COMPOUNDING' | 'RATE_LIMIT';
  severity: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';
  message: string;
  details?: Record<string, unknown> | string;
}

interface DiagnosticsLogProps {
  logs: LogEntry[];
  onClearLogs: () => void;
}

export function DiagnosticsLog({ logs, onClearLogs }: DiagnosticsLogProps) {
  const [filterCategory, setFilterCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const [confirmClear, setConfirmClear] = useState<boolean>(false);

  const filteredLogs = logs.filter((log) => {
    const matchesCategory =
      filterCategory === 'ALL' || log.category === filterCategory;
    const matchesSearch =
      searchQuery === '' ||
      log.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.category.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const exportToJson = () => {
    const dataStr =
      'data:text/json;charset=utf-8,' +
      encodeURIComponent(JSON.stringify(logs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute(
      'download',
      `trade_master_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const exportToCsv = () => {
    const headers = ['Timestamp', 'Category', 'Severity', 'Message'];
    const rows = logs.map((l) => [
      `"${l.timestamp}"`,
      `"${l.category}"`,
      `"${l.severity}"`,
      `"${l.message.replace(/"/g, '""')}"`,
    ]);

    const csvContent =
      'data:text/csv;charset=utf-8,' +
      [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');

    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', encodeURI(csvContent));
    downloadAnchor.setAttribute(
      'download',
      `trade_master_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
    );
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="neon-section"
    >
      <div className="neon-section-inner">
        {/* Header & Controls */}
        <div className="p-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <FileText className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-slate-100">
              Diagnostics Log
            </h2>
            <span className="text-xs font-mono text-cyan-400 font-semibold">
              {filteredLogs.length} / {logs.length}
            </span>
          </div>

        <div className="flex items-center gap-2">
          <button
            onClick={exportToJson}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded transition-colors border border-slate-700"
          >
            <Download className="w-3.5 h-3.5" />
            JSON
          </button>

          <button
            onClick={exportToCsv}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded transition-colors border border-slate-700"
          >
            <Download className="w-3.5 h-3.5" />
            CSV
          </button>

          {confirmClear ? (
            <div className="flex items-center gap-1.5 bg-rose-950/80 px-2 py-1 rounded border border-rose-700">
              <span className="text-[11px] text-rose-300 font-mono">Confirm Purge?</span>
              <button
                onClick={() => {
                  onClearLogs();
                  setConfirmClear(false);
                }}
                className="px-2 py-0.5 text-[10px] font-bold bg-rose-600 hover:bg-rose-500 text-white rounded transition-colors"
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="px-2 py-0.5 text-[10px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors"
              >
                No
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-rose-300 bg-rose-950/40 hover:bg-rose-900/60 rounded transition-colors border border-rose-800/60"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="p-3 bg-slate-950/50 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
        {/* Category Filters */}
        <div className="flex flex-wrap items-center gap-1">
          <Filter className="w-3.5 h-3.5 text-slate-500 mr-1" />
          {['ALL', 'SIGNAL', 'ORDER', 'COMPOUNDING', 'RATE_LIMIT', 'ERROR', 'SYSTEM'].map(
            (cat) => (
              <button
                key={cat}
                onClick={() => setFilterCategory(cat)}
                className={`px-2.5 py-1 rounded font-medium transition-colors ${
                  filterCategory === cat
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-[0_0_8px_rgba(0,240,255,0.4)]'
                    : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
                }`}
              >
                {cat}
              </button>
            )
          )}
        </div>

        {/* Search Input */}
        <div className="relative min-w-[220px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search log..."
            className="w-full bg-slate-900 border border-slate-700 rounded pl-8 pr-3 py-1 text-slate-200 placeholder:text-slate-500 text-xs focus:outline-none focus:border-cyan-400"
          />
        </div>
      </div>

      {/* Logs Table */}
      <div className="max-h-[500px] overflow-y-auto">
        {filteredLogs.length === 0 ? (
          <div className="p-12 text-center text-slate-500 text-xs font-mono">
            No diagnostic log entries match your filter.
          </div>
        ) : (
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 sticky top-0">
              <tr>
                <th className="py-2 px-4 w-32">Timestamp</th>
                <th className="py-2 px-3 w-28">Category</th>
                <th className="py-2 px-3 w-20">Severity</th>
                <th className="py-2 px-3">Event Log</th>
                <th className="py-2 px-4 w-20 text-right">Inspect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredLogs.map((log, idx) => {
                const isError = log.severity === 'ERROR';
                const isWarn = log.severity === 'WARN';
                const isSuccess = log.severity === 'SUCCESS';

                return (
                  <tr
                    key={`log-${log.id}-${idx}`}
                    onClick={() => setSelectedLog(log)}
                    className="hover:bg-slate-800/40 transition-colors cursor-pointer"
                  >
                    <td className="py-2.5 px-4 text-slate-400 whitespace-nowrap">
                      {log.timestamp}
                    </td>

                    <td className="py-2.5 px-3">
                      <span className="px-1.5 py-0.5 rounded text-[11px] bg-slate-800 text-slate-300 border border-slate-700">
                        {log.category}
                      </span>
                    </td>

                    <td className="py-2.5 px-3">
                      <span
                        className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                          isError
                            ? 'text-rose-400'
                            : isWarn
                            ? 'text-amber-400'
                            : isSuccess
                            ? 'text-emerald-400'
                            : 'text-sky-400'
                        }`}
                      >
                        {isError && <AlertTriangle className="w-3 h-3" />}
                        {isSuccess && <CheckCircle className="w-3 h-3" />}
                        {isWarn && <AlertTriangle className="w-3 h-3" />}
                        {!isError && !isSuccess && !isWarn && <Info className="w-3 h-3" />}
                        {log.severity}
                      </span>
                    </td>

                    <td className="py-2.5 px-3 text-slate-200 break-words font-sans">
                      {log.message}
                    </td>

                    <td className="py-2.5 px-4 text-right">
                      {log.details ? (
                        <span className="text-[11px] text-indigo-400 hover:underline">
                          View
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Inspect Modal */}
      {selectedLog && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-lg max-w-lg w-full p-5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-400" />
                Log Event Details
              </h3>
              <button
                onClick={() => setSelectedLog(null)}
                className="text-slate-400 hover:text-slate-200 text-sm font-mono px-2 py-1 rounded"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div className="flex justify-between text-slate-400">
                <span>Timestamp:</span>
                <span className="text-slate-200">{selectedLog.timestamp}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Category:</span>
                <span className="text-indigo-400">{selectedLog.category}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Severity:</span>
                <span className="text-amber-400">{selectedLog.severity}</span>
              </div>
              <div className="text-slate-400 pt-2 font-sans">
                <strong>Event Message:</strong>
                <p className="text-slate-200 mt-1">{selectedLog.message}</p>
              </div>

              {selectedLog.details && (
                <div className="pt-2">
                  <span className="text-slate-400 font-sans block mb-1">Raw Payload:</span>
                  <pre className="p-3 bg-slate-950 border border-slate-800 rounded text-slate-300 text-[11px] max-h-48 overflow-y-auto">
                    {typeof selectedLog.details === 'string'
                      ? selectedLog.details
                      : JSON.stringify(selectedLog.details, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-800 text-right">
              <button
                onClick={() => setSelectedLog(null)}
                className="px-4 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </motion.div>
  );
}
