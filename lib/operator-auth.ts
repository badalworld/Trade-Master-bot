/**
 * Operator authentication for every money-touching endpoint.
 *
 * The first audit round (B3) removed API keys from the browser and added a CSRF guard — but the
 * order endpoints themselves stayed unauthenticated: `X-TM-Request: 1` is a header any non-browser
 * client can set, so a deployment with server-side keys was reachable by anyone who knew the URL.
 * That was verified live before this module existed:
 *
 *   anonymous POST /api/binance/execute        -> passed the credential gate, reached Binance
 *   anonymous POST /api/binance/execute CLOSE  -> accepted (would flatten hand-opened positions)
 *   anonymous POST /api/engine/control         -> 200, armed autopilot and persisted it
 *   anonymous POST /api/engine/control flatten -> accepted with the published confirm string
 *
 * The operator session is a stateless HMAC-signed cookie keyed by `TM_OPERATOR_TOKEN`, so it needs
 * no shared store: it verifies on any instance and survives restarts. Rotating the token
 * invalidates every outstanding cookie. `TM_OPERATOR_AUTH` decides when a session is needed:
 *
 *   auto (default) — required whenever server-side Binance keys exist (the anonymously reachable,
 *                    therefore dangerous, configuration)
 *   on             — always required, including the browser-supplied-key flow
 *   off            — never required. ONLY safe behind platform authentication (Cloud Run IAM/IAP,
 *                    VPN, an authenticating reverse proxy). Do not use on a public URL.
 *
 * Fail-closed rule: when auth is required and `TM_OPERATOR_TOKEN` is unset, money routes refuse
 * with `OPERATOR_AUTH_NOT_CONFIGURED` instead of quietly accepting anonymous orders.
 *
 * No `next/*` imports: pure logic plus an httpOnly cookie, unit-testable under `node --test`.
 */

import crypto from 'crypto';

export const OPERATOR_COOKIE = 'tm_op';
export const OPERATOR_TTL_MS = 12 * 60 * 60 * 1000;
/** Below this length a token is a guess away from being useless. */
const MIN_TOKEN_LENGTH = 16;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;

export type OperatorAuthMode = 'auto' | 'on' | 'off';

export interface OperatorStatus {
  /** Is a session required for money endpoints on this deployment? */
  required: boolean;
  /** Is a usable TM_OPERATOR_TOKEN configured? */
  configured: boolean;
  mode: OperatorAuthMode;
  /** True when the caller presented a valid operator cookie. */
  authenticated: boolean;
}

export function operatorToken(env: Record<string, string | undefined> = process.env): string {
  return (env.TM_OPERATOR_TOKEN ?? '').trim();
}

export function operatorTokenConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return operatorToken(env).length >= MIN_TOKEN_LENGTH;
}

export function operatorAuthMode(env: Record<string, string | undefined> = process.env): OperatorAuthMode {
  const raw = (env.TM_OPERATOR_AUTH ?? 'auto').trim().toLowerCase();
  if (raw === 'on' || raw === 'true' || raw === '1') return 'on';
  if (raw === 'off' || raw === 'false' || raw === '0') return 'off';
  return 'auto';
}

/** Server-side keys mean the deployment can trade with no browser session at all. */
export function hasServerBinanceKeys(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean((env.BINANCE_API_KEY ?? '').trim() && (env.BINANCE_API_SECRET ?? '').trim());
}

export function operatorAuthRequired(env: Record<string, string | undefined> = process.env): boolean {
  const mode = operatorAuthMode(env);
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return hasServerBinanceKeys(env);
}

// ---------------------------------------------------------------------------
// Cookie minting / verification (stateless)
// ---------------------------------------------------------------------------

/** `v1.<expiryMs>.<hmac>` — tamper evident, self-expiring, no server-side session table. */
export function signOperatorSession(expiresAtMs: number, token: string): string {
  const mac = crypto.createHmac('sha256', token).update(`v1|${expiresAtMs}`).digest('hex');
  return `v1.${expiresAtMs}.${mac}`;
}

export function verifyOperatorSession(
  cookieValue: string | undefined,
  token: string,
  now: number = Date.now()
): boolean {
  if (!cookieValue || !token) return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;

  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  const expected = crypto.createHmac('sha256', token).update(`v1|${expiresAt}`).digest('hex');
  const given = parts[2] ?? '';
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function mintOperatorSession(
  token: string,
  now: number = Date.now()
): { value: string; expiresAt: number; maxAgeSeconds: number } {
  const expiresAt = now + OPERATOR_TTL_MS;
  return {
    value: signOperatorSession(expiresAt, token),
    expiresAt,
    maxAgeSeconds: Math.floor(OPERATOR_TTL_MS / 1000),
  };
}

export function operatorCookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${OPERATOR_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${
    secure ? '; Secure' : ''
  }`;
}

export function clearOperatorCookieHeader(secure: boolean): string {
  return `${OPERATOR_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Constant-time-ish comparison, hashed first so lengths never leak through `timingSafeEqual`. */
export function operatorTokenMatches(provided: string, configured: string): boolean {
  if (!provided || !configured) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      /* malformed percent-encoding: skip the cookie rather than 500 */
    }
  }
  return out;
}

export function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0]!.trim().toLowerCase() === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function operatorStatusFromRequest(
  req: Request,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now()
): OperatorStatus {
  const token = operatorToken(env);
  const required = operatorAuthRequired(env);
  const configured = operatorTokenConfigured(env);
  const cookie = parseCookieHeader(req.headers.get('cookie'))[OPERATOR_COOKIE];
  const authenticated = required && configured ? verifyOperatorSession(cookie, token, now) : !required;
  return { required, configured, mode: operatorAuthMode(env), authenticated };
}

export type OperatorCheck =
  | { ok: true; status: OperatorStatus }
  | { ok: false; status: OperatorStatus; httpStatus: number; code: string; error: string };

/**
 * Gate for every route that can move money, read account data or change engine state.
 * Returns `ok: true` unchanged when this deployment needs no operator session.
 */
export function requireOperator(
  req: Request,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now()
): OperatorCheck {
  const status = operatorStatusFromRequest(req, env, now);

  if (!status.required) return { ok: true, status };

  if (!status.configured) {
    return {
      ok: false,
      status,
      httpStatus: 503,
      code: 'OPERATOR_AUTH_NOT_CONFIGURED',
      error:
        'This deployment holds server-side Binance keys but no TM_OPERATOR_TOKEN, so order placement would be open to anyone who can reach the URL. Trading endpoints are locked. Set TM_OPERATOR_TOKEN to a random value of at least 32 characters (and TM_OPERATOR_AUTH=off only if the URL itself is behind an authenticating proxy).',
    };
  }

  if (!status.authenticated) {
    return {
      ok: false,
      status,
      httpStatus: 401,
      code: 'OPERATOR_AUTH_REQUIRED',
      error: 'Operator sign-in required. Enter the Trade Master operator token to reach trading endpoints.',
    };
  }

  return { ok: true, status };
}

// ---------------------------------------------------------------------------
// Login throttling (best effort, per process — a lockout is not a security boundary)
// ---------------------------------------------------------------------------

interface LoginAttempts {
  failures: number;
  lockedUntil: number;
}

const loginAttempts = new Map<string, LoginAttempts>();

export function operatorLoginLockRemainingMs(ip: string, now: number = Date.now()): number {
  const entry = loginAttempts.get(ip);
  if (!entry) return 0;
  return entry.lockedUntil > now ? entry.lockedUntil - now : 0;
}

export function recordOperatorLoginFailure(ip: string, now: number = Date.now()): void {
  const entry = loginAttempts.get(ip) ?? { failures: 0, lockedUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= MAX_LOGIN_FAILURES) {
    entry.lockedUntil = now + LOGIN_LOCK_MS;
    entry.failures = 0;
  }
  loginAttempts.set(ip, entry);
  // Keep the map from growing without bound on a public URL.
  if (loginAttempts.size > 500) {
    for (const [key, value] of loginAttempts) {
      if (value.lockedUntil <= now && loginAttempts.size > 200) loginAttempts.delete(key);
    }
  }
}

export function clearOperatorLoginFailures(ip: string): void {
  loginAttempts.delete(ip);
}

/** Test seam. */
export function __resetOperatorLoginState(): void {
  loginAttempts.clear();
}
