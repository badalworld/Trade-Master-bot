import { NextRequest, NextResponse } from 'next/server';
import { engine } from '@/lib/engine';
import { checkRequestIntegrity } from '@/lib/trade-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Action = 'start' | 'stop' | 'halt-entries' | 'resume-entries' | 'flatten-all';

/**
 * Operator controls for the server-side loop. Same origin/CSRF guard as trading, and the
 * destructive action additionally requires an exact confirmation string.
 */
export async function POST(req: NextRequest) {
  const integrity = checkRequestIntegrity(req);
  if (!integrity.ok) return NextResponse.json({ success: false, error: integrity.error, code: 'ORIGIN_REJECTED' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { action?: string; confirm?: string };
  const action = String(body.action ?? '') as Action;

  switch (action) {
    case 'start': {
      const r = engine.start();
      return NextResponse.json({ success: r.ok, ...r }, { status: r.ok ? 200 : 409 });
    }
    case 'stop':
      return NextResponse.json({ success: true, ...engine.stop('stopped via control API') });
    case 'halt-entries':
      return NextResponse.json({ success: true, ...engine.setHaltEntries(true) });
    case 'resume-entries':
      return NextResponse.json({ success: true, ...engine.setHaltEntries(false) });
    case 'flatten-all': {
      if (String(body.confirm ?? '').trim().toUpperCase() !== 'FLATTEN') {
        return NextResponse.json(
          { success: false, code: 'CONFIRM_REQUIRED', error: 'flatten-all closes real positions; send confirm:"FLATTEN" to proceed.' },
          { status: 400 }
        );
      }
      const r = await engine.flattenAll();
      return NextResponse.json({ success: r.ok, ...r }, { status: r.ok ? 200 : 409 });
    }
    default:
      return NextResponse.json(
        { success: false, code: 'UNKNOWN_ACTION', error: `action must be one of start|stop|halt-entries|resume-entries|flatten-all (got "${body.action ?? ''}")` },
        { status: 400 }
      );
  }
}
