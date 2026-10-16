import { NextRequest, NextResponse } from 'next/server';
import { baseUrlFor, getAccount, publicGet } from '@/lib/binance-client';
import { classifyError } from '@/lib/binance-errors';
import { loadRiskPolicy, policySummary } from '@/lib/risk-policy';
import { checkRequestIntegrity, envCredentials, resolveCredentials, sessionStatus } from '@/lib/trade-guard';
import { requireOperator } from '@/lib/operator-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Connectivity + credential preflight. Deliberately accepts no keys in the body; it reports on
 * whatever credential the server currently resolves (env or session).
 */
export async function POST(req: NextRequest) {
  try {
    const integrity = checkRequestIntegrity(req);
    if (!integrity.ok) return NextResponse.json({ success: false, error: integrity.error }, { status: 403 });

    const operator = requireOperator(req);
    if (!operator.ok) {
      return NextResponse.json({ success: false, code: operator.code, error: operator.error }, { status: operator.httpStatus });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.apiKey !== undefined || body.apiSecret !== undefined) {
      return NextResponse.json(
        {
          success: false,
          code: 'CREDENTIALS_IN_BODY',
          error: 'Keys are no longer passed per-request. Save them once via /api/binance/credentials (or server env).',
        },
        { status: 400 }
      );
    }

    const status = sessionStatus(req);
    const isTestnet = status.active ? status.isTestnet : envCredentials()?.isTestnet ?? true;
    const baseUrl = baseUrlFor(isTestnet);

    const started = Date.now();
    let pingOk = false;
    let pingError: string | null = null;
    let pingFailure: ReturnType<typeof classifyError> | null = null;
    try {
      await publicGet(isTestnet, '/fapi/v1/ping', '', 5000);
      pingOk = true;
    } catch (err) {
      pingError = (err as Error).message;
      pingFailure = classifyError(err, isTestnet);
    }
    const latencyMs = Date.now() - started;

    const resolution = resolveCredentials(req);
    const policy = loadRiskPolicy();

    let authValid = false;
    let balanceInfo = null;
    let errorMessage: string | null = resolution.ok ? null : resolution.error;
    let authFailure: ReturnType<typeof classifyError> | null = null;

    if (resolution.ok) {
      try {
        const account = await getAccount(resolution.creds);
        authValid = true;
        pingOk = true;
        balanceInfo = {
          totalWalletBalance: account.totalWalletBalance,
          availableBalance: account.availableBalance,
          totalUnrealizedProfit: account.totalUnrealizedProfit,
          canTrade: account.canTrade,
        };
      } catch (err) {
        // Name the real cause (wrong network / IP allowlist / geo-block / permissions) instead of
        // reporting every failure as a rejected credential.
        authFailure = classifyError(err, resolution.creds.isTestnet);
        errorMessage = authFailure.title;
      }
    }

    // A connection test must also say whether this deployment is *allowed* to send orders.
    const mainnetBlocked = !isTestnet && !policy.allowMainnet;

    return NextResponse.json({
      success: pingOk && authValid && !mainnetBlocked,
      endpoint: baseUrl,
      network: isTestnet ? 'testnet' : 'mainnet',
      credentialSource: resolution.ok ? resolution.creds.source : 'none',
      ping: { status: pingOk ? 'ONLINE' : 'UNREACHABLE', latencyMs, error: pingError, failure: pingFailure },
      auth: {
        provided: resolution.ok,
        valid: authValid,
        message: mainnetBlocked
          ? 'Credentials valid, but mainnet order placement is locked (set TRADE_ALLOW_MAINNET=true after a clean testnet run).'
          : authValid
            ? `Authenticated against ${isTestnet ? 'testnet' : 'MAINNET'} — trading enabled for this session`
            : errorMessage || 'No usable credentials resolved on the server.',
        failure: authFailure,
        balance: balanceInfo,
      },
      orderPlacementAllowed: !policy.halted && !mainnetBlocked,
      policy: policySummary(policy),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const e = err as Error;
    return NextResponse.json({ success: false, error: e.message || 'Invalid request' }, { status: 400 });
  }
}
