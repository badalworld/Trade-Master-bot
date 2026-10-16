import { NextRequest, NextResponse } from 'next/server';
import { checkRequestIntegrity } from '@/lib/trade-guard';
import { clearOperatorCookieHeader, isSecureRequest } from '@/lib/operator-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Drops the signed operator cookie. The token itself is unchanged on the server. */
export async function POST(req: NextRequest) {
  const integrity = checkRequestIntegrity(req);
  if (!integrity.ok) {
    return NextResponse.json({ success: false, error: integrity.error, code: 'ORIGIN_REJECTED' }, { status: 403 });
  }

  return NextResponse.json(
    { success: true, message: 'Operator session signed out on this browser.' },
    {
      status: 200,
      headers: {
        'Set-Cookie': clearOperatorCookieHeader(isSecureRequest(req)),
        'Cache-Control': 'no-store',
      },
    }
  );
}
