'use client';

import React, { useState } from 'react';
import { Shield, KeyRound, AlertTriangle, Loader2 } from 'lucide-react';

/**
 * Sign-in wall in front of every trading endpoint.
 *
 * Why it exists: the CSRF header (`X-TM-Request`) is not authentication — any HTTP client can send
 * it. With server-side Binance keys configured, that made a public deployment an open order relay.
 * The token entered here is exchanged for a signed httpOnly 12h session cookie; the token itself is
 * never stored in the browser.
 */
export interface OperatorGateProps {
  /** False when the server has no TM_OPERATOR_TOKEN configured — signing in cannot succeed. */
  configured: boolean;
  onAuthenticated: () => void;
}

export function OperatorGate({ configured, onAuthenticated }: OperatorGateProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TM-Request': '1' },
        credentials: 'same-origin',
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (res.ok && data.success) {
        setToken('');
        onAuthenticated();
        return;
      }
      setError(data.error || `Sign-in failed (HTTP ${res.status}).`);
    } catch (err) {
      setError((err as Error).message || 'Network error reaching the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md neon-section">
        <div className="neon-section-inner p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-cyan-400" />
            <h1 className="text-base font-semibold">Trade Master · Operator sign-in</h1>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            This deployment trades with server-side Binance credentials, so order placement, account
            reads and engine controls require an operator session. Enter the value of
            <code className="mx-1 px-1 rounded bg-slate-900 text-cyan-300">TM_OPERATOR_TOKEN</code>
            to continue. The token stays out of browser storage — the server returns a signed
            httpOnly cookie valid for 12 hours.
          </p>

          {!configured && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-rose-800 bg-rose-950/40 text-[11px] text-rose-200">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                <strong>The server has no TM_OPERATOR_TOKEN set.</strong> Trading endpoints are locked
                until one is configured. Set a random value of 32+ characters and redeploy, or set
                <code className="mx-1 px-1 rounded bg-slate-900 text-rose-200">TM_OPERATOR_AUTH=off</code>
                only if this URL already sits behind an authenticating proxy.
              </span>
            </div>
          )}

          <form onSubmit={submit} className="space-y-3">
            <label className="block text-[11px] font-mono text-slate-400" htmlFor="tm-operator-token">
              OPERATOR TOKEN
            </label>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 focus-within:border-cyan-700">
              <KeyRound className="w-4 h-4 text-slate-500" />
              <input
                id="tm-operator-token"
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="paste operator token"
                className="flex-1 bg-transparent outline-none text-sm font-mono text-slate-100 placeholder:text-slate-600"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 text-[11px] text-rose-300">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy || !token.trim() || !configured}
              className="w-full py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
              {busy ? 'Verifying…' : 'Unlock trading terminal'}
            </button>
          </form>

          <p className="text-[10px] text-slate-500 leading-snug">
            Failed attempts are throttled. Signing out (Settings → Operator session) clears the
            cookie; rotating TM_OPERATOR_TOKEN on the server invalidates every existing session.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Shared sign-out call so Settings and any future caller behave identically.
 */
export async function signOutOperator(): Promise<boolean> {
  try {
    const res = await fetch('/api/operator/logout', {
      method: 'POST',
      headers: { 'X-TM-Request': '1' },
      credentials: 'same-origin',
    });
    return res.ok;
  } catch {
    return false;
  }
}
