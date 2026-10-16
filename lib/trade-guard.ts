/**
 * Server-side guard for every /api/binance/* route.
 *
 * Fixes three defects at once:
 *  1. Credentials no longer live in `localStorage` or travel in request bodies. They resolve
 *     from deployment env (preferred) or from a short-lived httpOnly session.
 *  2. The order endpoint used to be reachable by anyone with a URL and any key in the JSON body;
 *     it now requires a same-site session plus a matched Origin.
 *  3. Duplicate submissions from a re-entrant scan loop are collapsed by an idempotency claim.
 *
 * NOTE: the session and idempotency maps are per-process. Single-instance deploys (Cloud Run
 * `--min-instances=1 --max-instances=1`) are required for the browser-session path; deployments
 * that set BINANCE_API_KEY/BINANCE_API_SECRET are stateless and scale freely.
 */

import crypto from 'crypto';

export const SESSION_COOKIE = 'tm_sess';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

export interface StoredCreds {
  apiKey: string;
  apiSecret: string;
  isTestnet: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface ResolvedCreds extends StoredCreds {
  source: 'env' | 'session';
  token?: string;
}

const sessions = new Map<string, StoredCreds>();
const claimedIds = new Map<string, number>();

function pruneNow(): void {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(token);
  }
  for (const [id, at] of claimedIds) {
    if (at + IDEMPOTENCY_TTL_MS <= now) claimedIds.delete(id);
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function readSessionToken(req: Request): string | undefined {
  return parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
}

/**
 * `secure` must be true on any https deployment: without it the browser would also hand this
 * credential-bearing cookie to a plaintext http request on the same host (cookie tossing).
 * Callers pass `isSecureRequest(req)`; plain-http local development keeps working.
 */
export function issueSession(
  creds: Omit<StoredCreds, 'createdAt' | 'expiresAt'>,
  opts: { secure?: boolean } = {}
): {
  token: string;
  cookie: string;
} {
  pruneNow();
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  sessions.set(token, { ...creds, createdAt: now, expiresAt: now + SESSION_TTL_MS });
  // httpOnly keeps keys out of reach of page JS; SameSite=Lax plus the Origin check blocks CSRF.
  const cookie = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000
  )}${opts.secure ? '; Secure' : ''}`;
  return { token, cookie };
}

/** Matching clear-cookie header, with the same attributes so the browser actually removes it. */
export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function revokeSession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

export function clearAllSessions(): void {
  sessions.clear();
}

export function envCredentials(): Omit<StoredCreds, 'createdAt' | 'expiresAt'> | null {
  const apiKey = (process.env.BINANCE_API_KEY ?? '').trim();
  const apiSecret = (process.env.BINANCE_API_SECRET ?? '').trim();
  if (!apiKey || !apiSecret) return null;
  return {
    apiKey,
    apiSecret,
    isTestnet: (process.env.BINANCE_TESTNET ?? 'true').trim().toLowerCase() !== 'false',
  };
}

export type CredResolution =
  | { ok: true; creds: ResolvedCreds }
  | { ok: false; status: number; error: string; code: string };

/** Env keys win over a session; there is deliberately no path that reads keys from the body. */
export function resolveCredentials(req: Request): CredResolution {
  const env = envCredentials();
  if (env) {
    const now = Date.now();
    return {
      ok: true,
      creds: { ...env, createdAt: now, expiresAt: Infinity, source: 'env' },
    };
  }

  const token = readSessionToken(req);
  const session = token ? sessions.get(token) : undefined;
  if (!session || session.expiresAt <= Date.now()) {
    return {
      ok: false,
      status: 401,
      code: 'NO_SESSION',
      error:
        'No authenticated Binance session. Submit your API key/secret once via Settings (stored server-side in an httpOnly session), or set BINANCE_API_KEY/BINANCE_API_SECRET on the server.',
    };
  }

  sessions.set(token!, { ...session, expiresAt: Date.now() + SESSION_TTL_MS });
  return { ok: true, creds: { ...session, source: 'session', token } };
}

/**
 * CSRF defence for cookie-authenticated POSTs: a cross-site form/fetch cannot set a custom
 * header, and a cross-origin POST carries an Origin that must match our own host.
 */
export function checkRequestIntegrity(req: Request): { ok: true } | { ok: false; error: string } {
  const header = req.headers.get('x-tm-request');
  if (header !== '1') {
    return {
      ok: false,
      error: 'Missing X-TM-Request header. This endpoint only accepts requests issued by the app UI.',
    };
  }

  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  const host = req.headers.get('host');
  const sameHost = (value: string | null) => {
    if (!value) return false;
    try {
      return new URL(value).host === host;
    } catch {
      return false;
    }
  };

  if (origin && !sameHost(origin)) {
    return { ok: false, error: 'Cross-origin request rejected.' };
  }
  if (!origin && referer && !sameHost(referer)) {
    return { ok: false, error: 'Cross-origin request rejected.' };
  }
  return { ok: true };
}

/** Returns true the first time an id is seen within the TTL window, false on a repeat. */
export function claimIdempotency(id: string | undefined): {
  claimed: boolean;
  reason?: 'REPLAY';
  key?: string;
} {
  pruneNow();
  if (!id) return { claimed: true };
  const key = id.slice(0, 64);
  if (claimedIds.has(key)) return { claimed: false, reason: 'REPLAY', key };
  claimedIds.set(key, Date.now());
  return { claimed: true, key };
}

export function releaseIdempotency(key: string | undefined): void {
  if (key) claimedIds.delete(key);
}

/** Stable, collision-resistant client order id usable as a Binance `newClientOrderId`. */
export function makeClientOrderId(prefix: string, symbol: string, nonce: string): string {
  const digest = crypto
    .createHash('sha1')
    .update(`${prefix}|${symbol.toUpperCase()}|${nonce}`)
    .digest('hex')
    .slice(0, 16);
  const safePrefix = prefix.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8);
  return `${safePrefix}-${symbol.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)}-${digest}`;
}

export function sessionStatus(req: Request): {
  active: boolean;
  source: 'env' | 'session' | 'none';
  isTestnet: boolean;
  expiresInMs?: number;
  keyHint?: string;
} {
  const env = envCredentials();
  if (env) {
    return {
      active: true,
      source: 'env',
      isTestnet: env.isTestnet,
      keyHint: `${env.apiKey.slice(0, 4)}…${env.apiKey.slice(-4)}`,
    };
  }
  const token = readSessionToken(req);
  const s = token ? sessions.get(token) : undefined;
  if (!s || s.expiresAt <= Date.now()) {
    return { active: false, source: 'none', isTestnet: true };
  }
  return {
    active: true,
    source: 'session',
    isTestnet: s.isTestnet,
    expiresInMs: s.expiresAt - Date.now(),
    keyHint: `${s.apiKey.slice(0, 4)}…${s.apiKey.slice(-4)}`,
  };
}
