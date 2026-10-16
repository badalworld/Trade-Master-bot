/**
 * Pure guardian decisions, separated from I/O so the safety-critical logic is unit-testable.
 *
 * These answer the questions that matter when nobody is watching: does this position still have a
 * protective stop on the book, is its bracket breached, and how should a vanished position be
 * classified in the trade history.
 */

import type { ConditionalOrder } from './binance-client.ts';

export interface GuardedPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  stopLoss: number;
  takeProfit: number;
  markPrice: number;
  entryPrice: number;
  unprotectedCycles?: number;
}

export type GuardianAction =
  | { kind: 'NONE'; reason: 'already-protected' }
  | { kind: 'REARM_STOP'; note: string }
  | { kind: 'ADOPT_EXCHANGE_STOP'; stopPrice: number; orderId: number | string; note: string }
  | { kind: 'FLATTEN'; note: string }
  | { kind: 'SKIP'; reason: 'no-stop-level-known' | 'enforcement-disabled' | 'stop-state-unknown' };

export interface GuardianConfig {
  enforceBrackets: boolean;
  /** Cycles a stop may stay missing before the position is flattened. 0 = flatten immediately. */
  unprotectedTolerance: number;
  /** false => the open-order query failed, so absence of a stop is not evidence of anything. */
  stopStateKnown?: boolean;
}

/** Statuses that mean the order is no longer working on the book. */
const TERMINAL_STATUSES = new Set(['FILLED', 'CANCELED', 'CANCELLED', 'REJECTED', 'EXPIRED']);

/**
 * The live exit-side conditional order that would flatten this position.
 *
 * `/fapi/v1/openOrders` only returns working orders and reports them as `NEW` — filtering on a
 * status like `STOP` would match nothing and make the guardian re-arm an already-present stop every
 * cycle, spamming duplicate orders. So: correct type + correct side, and not terminal.
 */
export function findProtectiveStop(orders: ConditionalOrder[], side: 'LONG' | 'SHORT'): ConditionalOrder | undefined {
  // Closing a LONG means SELLing; a SHORT is closed by BUYing.
  const exitSide = side === 'LONG' ? 'SELL' : 'BUY';
  return orders.find(
    (o) => o.symbol && o.type === 'STOP_MARKET' && o.side === exitSide && !TERMINAL_STATUSES.has(String(o.status).toUpperCase())
  );
}

/**
 * Decide what the guardian should do about one position's stop.
 *
 * `tolerance` exists because a single failed re-arm is usually transient (rate limit, clock skew);
 * flattening on the first hiccup would turn a network blip into a realised loss. But "unprotected"
 * cannot be permanent either — after tolerance+1 failed cycles the position is closed.
 */
export function planBracketEnforcement(
  position: GuardedPosition,
  openOrders: ConditionalOrder[],
  config: GuardianConfig
): GuardianAction {
  if (!config.enforceBrackets) return { kind: 'SKIP', reason: 'enforcement-disabled' };
  // We asked for the open orders and the exchange did not answer. Placing a stop now risks a
  // duplicate; flattening risks destroying a protected position because our own query failed.
  if (config.stopStateKnown === false) return { kind: 'SKIP', reason: 'stop-state-unknown' };
  if (!(position.stopLoss > 0)) {
    // The engine never set a level for this position (e.g. adopted). Inventing one and acting on it
    // would be trading someone else's position on a guess.
    return { kind: 'SKIP', reason: 'no-stop-level-known' };
  }

  const stop = findProtectiveStop(openOrders, position.side);
  if (!stop) {
    const cycles = (position.unprotectedCycles ?? 0) + 1;
    if (cycles > config.unprotectedTolerance) {
      return {
        kind: 'FLATTEN',
        note: `${position.symbol} had no protective stop for ${cycles} cycles (tolerance ${config.unprotectedTolerance}) — closing to cap exposure.`,
      };
    }
    return {
      kind: 'REARM_STOP',
      note: `${position.symbol} has no STOP_MARKET on the book; re-arming at ${position.stopLoss} (attempt ${cycles}/${config.unprotectedTolerance + 1}).`,
    };
  }

  const drift = Math.abs(stop.stopPrice - position.stopLoss) / position.stopLoss;
  if (drift > 0.001) {
    return {
      kind: 'ADOPT_EXCHANGE_STOP',
      stopPrice: stop.stopPrice,
      orderId: stop.orderId,
      note: `${position.symbol} stop was moved on the exchange to ${stop.stopPrice} (ledger said ${position.stopLoss}); adopting the exchange value instead of fighting it.`,
    };
  }

  return { kind: 'NONE', reason: 'already-protected' };
}

/**
 * Is the bracket breached at this mark price? Deliberately conservative: an unknown bracket (a zero
 * level) never counts as breached, so an adopted position is left to whatever the exchange says.
 */
export function detectBreach(position: GuardedPosition, markPrice: number): 'TAKE_PROFIT' | 'STOP_LOSS' | null {
  if (!(position.stopLoss > 0) || !(position.takeProfit > 0)) return null;
  if (!Number.isFinite(markPrice) || markPrice <= 0) return null;

  if (position.side === 'LONG') {
    if (markPrice <= position.stopLoss) return 'STOP_LOSS';
    if (markPrice >= position.takeProfit) return 'TAKE_PROFIT';
    return null;
  }
  if (markPrice >= position.stopLoss) return 'STOP_LOSS';
  if (markPrice <= position.takeProfit) return 'TAKE_PROFIT';
  return null;
}

/** Label a position that disappeared from the exchange without a local close. */
export function classifyExit(
  position: Pick<GuardedPosition, 'side' | 'stopLoss' | 'takeProfit' | 'markPrice'>,
  lastKnownPrice?: number
): 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL_CLOSE' {
  if (!(position.takeProfit > 0) || !(position.stopLoss > 0)) return 'MANUAL_CLOSE';
  const price = lastKnownPrice && lastKnownPrice > 0 ? lastKnownPrice : position.markPrice;
  if (!Number.isFinite(price) || price <= 0) return 'MANUAL_CLOSE';

  if (position.side === 'LONG') return price >= position.takeProfit ? 'TAKE_PROFIT' : 'STOP_LOSS';
  return price <= position.takeProfit ? 'TAKE_PROFIT' : 'STOP_LOSS';
}

export interface EntryGateInput {
  autoEntry: boolean;
  haltedByOperator: boolean;
  haltedByPolicy: boolean;
  canTrade: boolean;
  dailyLossLocked: boolean;
  openOwned: number;
  maxOpenPositions: number;
  /**
   * Whether the trade ledger can be written. Without it, a restart forgets which positions are ours,
   * how much was lost today, and where the compounding ladder had got to — the daily-loss breaker
   * comes back at zero and the engine would happily keep trading a losing day. Automated entries
   * therefore fail closed, and `allowNonDurableLedger` is the operator's explicit override for
   * deployments that accept an ephemeral ledger (for example a Cloud Run instance with no volume).
   */
  ledgerDurable?: boolean;
  allowNonDurableLedger?: boolean;
}

/** Single place that decides whether the engine may open something new. */
export function evaluateEntryGate(input: EntryGateInput): { allowed: boolean; reason: string } {
  if (!input.autoEntry) return { allowed: false, reason: 'auto-entry disabled (guardian-only mode)' };
  if (input.haltedByOperator) return { allowed: false, reason: 'entries halted by operator' };
  if (input.haltedByPolicy) return { allowed: false, reason: 'TRADE_HALT is set on the server' };
  if (!input.canTrade) return { allowed: false, reason: 'Binance reports canTrade=false' };
  if (input.dailyLossLocked) return { allowed: false, reason: 'daily loss breaker tripped' };
  if (input.ledgerDurable === false && !input.allowNonDurableLedger) {
    return {
      allowed: false,
      reason:
        'the trade ledger is not writable, so positions, the daily-loss figure and compounding would be forgotten on restart ' +
        '(point TRADE_DATA_DIR at a writable volume, or set TRADE_ENGINE_ALLOW_NON_DURABLE_LEDGER=true to accept that)',
    };
  }
  if (input.openOwned >= input.maxOpenPositions) {
    return { allowed: false, reason: `position cap reached (${input.openOwned}/${input.maxOpenPositions})` };
  }
  return { allowed: true, reason: 'entry permitted' };
}
