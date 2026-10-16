/**
 * Persistence for the opportunity list.
 *
 * The pure planner in `lib/opportunity-list.ts` decides what the list should be; this module knows
 * where it lives between cycles. Both the engine loop and the browser's scan route call it, so the
 * browser and the server maintain **one** list rather than two that drift apart.
 *
 * The file sits next to the trade ledger under `TRADE_DATA_DIR` and is written atomically
 * (tmp + rename), so a crash mid-write cannot leave half a list behind. It is deliberately treated as
 * a cache: a missing, unreadable or corrupt file simply means "no list yet", and the next market scan
 * rebuilds one from the exchange. Losing it costs one discovery cycle, never a position.
 *
 * Server-only: it touches the filesystem, so nothing that runs in the browser may import it. The
 * client bundle imports `lib/opportunity-list.ts` (types + pure helpers) only.
 */

import fs from 'fs';
import path from 'path';
import { emptyOpportunityList, type OpportunityListState } from './opportunity-list.ts';

const FILE_NAME = 'opportunity-list.json';

function dataDir(): string {
  const configured = (process.env.TRADE_DATA_DIR || '').trim();
  return configured || path.join(process.cwd(), '.data');
}

export function opportunityListPath(): string {
  return path.join(dataDir(), FILE_NAME);
}

let cache: { state: OpportunityListState | null; readAt: number } | null = null;

/** Loose validation: the shape must be close enough to plan from, or the list is rebuilt. */
function isUsable(value: unknown): value is OpportunityListState {
  const state = value as OpportunityListState | null;
  return (
    !!state &&
    typeof state === 'object' &&
    state.version === 1 &&
    Array.isArray(state.entries) &&
    Array.isArray(state.removed) &&
    state.entries.every((e) => !!e && typeof e.symbol === 'string')
  );
}

/**
 * The current list, or null when there is none yet. Cached in memory for the life of the process so a
 * 15-second loop does not read the file every cycle; `saveOpportunityList` keeps the cache in step.
 */
export function loadOpportunityList(): OpportunityListState | null {
  if (cache) return cache.state;
  try {
    const raw = fs.readFileSync(opportunityListPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    cache = { state: isUsable(parsed) ? parsed : null, readAt: Date.now() };
  } catch {
    // Missing or unreadable: not an error, it just means discovery has not run yet.
    cache = { state: null, readAt: Date.now() };
  }
  return cache.state;
}

/**
 * Persist the list. Returns whether it reached the disk: on a platform with an ephemeral filesystem
 * (or a read-only volume) the in-memory list still works for the life of the process, and the caller
 * reports that rather than pretending it is durable.
 */
export function saveOpportunityList(state: OpportunityListState): { durable: boolean; error?: string } {
  cache = { state, readAt: Date.now() };
  const file = opportunityListPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file); // atomic replace
    return { durable: true };
  } catch (error) {
    return { durable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Test seam: forget the cached list (used between cases and by `__resetOpportunityBoardCache`). */
export function __resetOpportunityListCache(): void {
  cache = null;
}

/** What an empty list looks like, for callers that need a starting point. */
export function freshOpportunityList(now = Date.now()): OpportunityListState {
  return emptyOpportunityList(now);
}
