import { NextRequest, NextResponse } from 'next/server';
import { checkRequestIntegrity } from '@/lib/trade-guard';
import {
  clearOperatorLoginFailures,
  isSecureRequest,
  mintOperatorSession,
  operatorCookieHeader,
  operatorLoginLockRemainingMs,
  operatorStatusFromRequest,
  operatorToken,
  operatorTokenConfigured,
  operatorTokenMatches,
  recordOperatorLoginFailure,
} from '@/lib/operator-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Exchange the operator token for a signed httpOnly session cookie.
 *
 * The CSRF guard is on this route too: a cross-site page must not be able to drive a brute-force
 * attempt from a victim's browser, and the token itself is compared in constant time.
 */
export async function POST(req: NextRequest) {
  const integrity = checkRequestIntegrity(req);
  if (!integrity.ok) {
    return NextResponse.json({ success: false, error: integrity.error, code: 'ORIGIN_REJECTED' }, { status: 403 });
  }

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown-host';

  const lockedFor = operatorLoginLockRemainingMs(ip);
  if (lockedFor > 0) {
    return NextResponse.json(
      {
        success: false,
        code: 'LOGIN_LOCKED',
        error: `Too many failed operator sign-ins. Try again in ${Math.ceil(lockedFor / 1000)}s.`,
      },
      { status: 429 }
    );
  }

  const config = operatorStatusFromRequest(req);
  if (!config.required) {
    // Nothing to sign in to. Say so instead of minting a session that means nothing.
    return NextResponse.json(
      { success: true, authenticated: true, required: false, message: 'This deployment does not require operator sign-in.' },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
  if (!operatorTokenConfigured()) {
    return NextResponse.json(
      {
        success: false,
        code: 'OPERATOR_AUTH_NOT_CONFIGURED',
        error:
          'No TM_OPERATOR_TOKEN is configured on the server. Set it (32+ random characters) before trading endpoints can be used.',
      },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { token?: unknown };
  const provided = typeof body.token === 'string' ? body.token.trim() : '';

  if (!operatorTokenMatches(provided, operatorToken())) {
    recordOperatorLoginFailure(ip);
    return NextResponse.json(
      { success: false, code: 'INVALID_OPERATOR_TOKEN', error: 'That operator token is not valid.' },
      { status: 401 }
    );
  }

  clearOperatorLoginFailures(ip);
  const session = mintOperatorSession(operatorToken());

  return NextResponse.json(
    {
      success: true,
      authenticated: true,
      expiresAt: session.expiresAt,
      message: 'Operator session established (12h, httpOnly). Trading endpoints are unlocked for this browser.',
    },
    {
      status: 200,
      headers: {
        'Set-Cookie': operatorCookieHeader(session.value, session.maxAgeSeconds, isSecureRequest(req)),
        'Cache-Control': 'no-store',
      },
    }
  );
}
