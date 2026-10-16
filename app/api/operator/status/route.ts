import { NextRequest, NextResponse } from 'next/server';
import { operatorStatusFromRequest } from '@/lib/operator-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public by design: the UI has to know whether to render the sign-in gate before it can present
 * anything. Reveals only whether a session is required, never the token or any part of it.
 */
export async function GET(req: NextRequest) {
  const status = operatorStatusFromRequest(req);
  return NextResponse.json(
    {
      success: true,
      required: status.required,
      configured: status.configured,
      mode: status.mode,
      authenticated: status.authenticated,
      timestamp: Date.now(),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
