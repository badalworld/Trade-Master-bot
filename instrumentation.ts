/**
 * Boots the unattended guardian loop with the server process.
 *
 * This is the piece that makes risk management survive a closed browser tab. It only starts when
 * `TRADE_ENGINE_ENABLED=true` *and* server-side credentials exist, so a default deploy is inert —
 * an applet nobody configured must never begin trading on its own.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { engine, loadEngineConfig } = await import('@/lib/engine');
  const { ledger } = await import('@/lib/position-ledger');
  const config = loadEngineConfig();

  if (!config.enabled) {
    console.log('[engine] TRADE_ENGINE_ENABLED is not set — server-side guardian loop is OFF. Positions will only be monitored while a browser tab has the app open.');
    return;
  }

  // Next may load this module more than once in development; never run two loops.
  const globalRef = globalThis as unknown as { __tmEngineBooted?: boolean; __tmEngineSignals?: boolean };
  if (!globalRef.__tmEngineBooted) {
    globalRef.__tmEngineBooted = true;
    const result = engine.start();
    if (!result.ok) console.error(`[engine] ${result.message}`);
  }

  if (!globalRef.__tmEngineSignals) {
    globalRef.__tmEngineSignals = true;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        try {
          engine.stop(`received ${signal}`);
          ledger.flush();
        } catch (err) {
          console.error('[engine] shutdown flush failed:', (err as Error).message);
        }
      });
    }
  }
}
