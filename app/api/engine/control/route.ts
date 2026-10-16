import { NextRequest, NextResponse } from 'next/server';
import { engine } from '@/lib/engine';
import { checkRequestIntegrity } from '@/lib/trade-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Action = 'start' | 'stop' | 'halt-entries' | 'resume-entries' | 'flatten-all' | 'set-auto-entry';

/**
 * Operator controls for the server-side loop. Same origin/CSRF guard as trading, and the
 * destructive action additionally requires an exact confirmation string.
 */
export async function POST(req: NextRequest) {
  const integrity = checkRequestIntegrity(req);
  if (!integrity.ok) return NextResponse.json({ success: false, error: integrity.error, code: 'ORIGIN_REJECTED' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    confirm?: string;
    // unknown on purpose: every accepted shape is enumerated below, nothing is coerced.
    enabled?: unknown;
  };
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
    case 'set-auto-entry': {
      // Strict: an unrecognized value must be an error, not a silent "off" (a UI that sends 1 instead
      // of true would otherwise disable autopilot and report success).
      const raw = body.enabled;
      const enabled = raw === true || raw === 'true' || raw === 1 || raw === '1';
      if (raw === undefined || (!enabled && !(raw === false || raw === 'false' || raw === 0 || raw === '0'))) {
        return NextResponse.json(
          { success: false, code: 'ENABLE_REQUIRED', error: 'set-auto-entry needs a boolean "enabled" (true/false).' },
          { status: 400 }
        );
      }
      // The engine owns the decision (including which network this would trade on); the route only
      // translates it, so the confirmation rule cannot drift between the two.
      const r = engine.setAutoEntry(enabled, body.confirm);
      return NextResponse.json(
        { success: r.ok, ...r, ...(r.requiresConfirm ? { code: 'CONFIRM_REQUIRED' } : {}) },
        { status: r.ok ? 200 : r.requiresConfirm ? 428 : 409 }
      );
    }
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
        { success: false, code: 'UNKNOWN_ACTION', error: `action must be one of start|stop|halt-entries|resume-entries|flatten-all|set-auto-entry (got "${body.action ?? ''}")` },
        { status: 400 }
      );
  }
}
