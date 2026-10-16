import { NextRequest, NextResponse } from 'next/server';
import { getAccount, publicGet, TESTNET_BASE, MAINNET_BASE } from '@/lib/binance-client';
import { loadRiskPolicy, policySummary } from '@/lib/risk-policy';
import { requireOperator } from '@/lib/operator-auth';
import {
  checkRequestIntegrity,
  envCredentials,
  issueSession,
  readSessionToken,
  revokeSession,
  sessionStatus,
} from '@/lib/trade-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Exchange a pair of Binance keys for a short-lived httpOnly session.
 *
 * Replaces the old flow where keys were pasted into a form, written to `localStorage`, and
 * re-sent in the body of every trading call. Keys entered here are held in server memory only,
 * never returned to the client, and never persisted to disk or to the browser.
 */
export async function POST(req: NextRequest) {
  try {
    const integrity = checkRequestIntegrity(req);
    if (!integrity.ok) return NextResponse.json({ success: false, error: integrity.error }, { status: 403 });

    // Minting a credential session is an operator action: gate it exactly like an order.
    const operator = requireOperator(req);
    if (!operator.ok) {
      return NextResponse.json({ success: false, code: operator.code, error: operator.error }, { status: operator.httpStatus });
    }

    if (envCredentials()) {
      return NextResponse.json(
        {
          success: false,
          code: 'ENV_CREDENTIALS_ACTIVE',
          error: 'This deployment has BINANCE_API_KEY/BINANCE_API_SECRET configured on the server. Remove them to use browser-supplied credentials.',
        },
        { status: 400 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const apiKey = String(body.apiKey ?? '').trim();
    const apiSecret = String(body.apiSecret ?? '').trim();
    const isTestnet = body.isTestnet !== false;

    if (apiKey.length < 8 || apiSecret.length < 8) {
      return NextResponse.json(
        { success: false, error: 'API key and secret both look too short — paste the full values from Binance.' },
        { status: 400 }
      );
    }

    // Verify against the chosen network *before* minting a session, so a typo can never become a
    // live-money credential.
    try {
      const account = await getAccount({ apiKey, apiSecret, isTestnet });
      const { cookie } = issueSession({ apiKey, apiSecret, isTestnet });
      return NextResponse.json(
        {
          success: true,
          verified: true,
          network: isTestnet ? 'testnet' : 'mainnet',
          endpoint: isTestnet ? TESTNET_BASE : MAINNET_BASE,
          keyHint: `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`,
          canTrade: account.canTrade,
          balance: {
            totalWalletBalance: account.totalWalletBalance,
            availableBalance: account.availableBalance,
            totalUnrealizedProfit: account.totalUnrealizedProfit,
          },
          message: isTestnet
            ? 'Testnet credentials verified. Session cookie issued (8h, httpOnly).'
            : 'MAINNET credentials verified — real funds. Session cookie issued (8h, httpOnly).',
        },
        {
          status: 200,
          headers: { 'Set-Cookie': cookie },
        }
      );
    } catch (err) {
      const e = err as Error & { code?: number };
      return NextResponse.json(
        {
          success: false,
          verified: false,
          network: isTestnet ? 'testnet' : 'mainnet',
          error: `Binance rejected these credentials: ${e.message}`,
          binanceCode: e.code ?? null,
          hint: isTestnet
            ? 'Create a key at the Binance Futures Testnet API management page — mainnet keys do not work on testnet.'
            : 'Check the key has "Enable Futures" permission and that no IP restriction blocks this server.',
        },
        { status: 401 }
      );
    }
  } catch (err) {
    const e = err as Error;
    return NextResponse.json({ success: false, error: e.message || 'Credential session error' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  // Reading session state leaks the key hint and the live policy, so it is operator-gated too.
  // (No-op when this deployment needs no operator session — see `requireOperator`.)
  const operator = requireOperator(req);
  if (!operator.ok) {
    return NextResponse.json({ success: false, code: operator.code, error: operator.error }, { status: operator.httpStatus });
  }

  const status = sessionStatus(req);
  const policy = loadRiskPolicy();
  const ping = await publicGet(req.nextUrl.searchParams.get('testnet') === 'false' ? false : status.isTestnet, '/fapi/v1/ping', '', 4000)
    .then(() => ({ reachable: true }))
    .catch((err: Error) => ({ reachable: false, error: err.message }));

  return NextResponse.json({
    active: status.active,
    source: status.source,
    isTestnet: status.isTestnet,
    keyHint: status.keyHint ?? null,
    expiresInMs: status.expiresInMs ?? null,
    policy: policySummary(policy),
    exchangeReachable: ping,
    timestamp: Date.now(),
  });
}

export async function DELETE(req: NextRequest) {
  const integrity = checkRequestIntegrity(req);
  if (!integrity.ok) return NextResponse.json({ success: false, error: integrity.error }, { status: 403 });

  const operator = requireOperator(req);
  if (!operator.ok) {
    return NextResponse.json({ success: false, code: operator.code, error: operator.error }, { status: operator.httpStatus });
  }

  const token = readSessionToken(req);
  const had = Boolean(token);
  revokeSession(token);
  return NextResponse.json(
    { success: true, revoked: had, message: 'Credential session cleared from server memory.' },
    {
      status: 200,
      headers: { 'Set-Cookie': `tm_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
    }
  );
}
