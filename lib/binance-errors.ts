/**
 * Classifies a raw Binance/transport failure into an actionable diagnosis.
 *
 * Why this exists: every failed call used to be reported as "Binance rejected these credentials",
 * including failures where the credentials were never even evaluated — a wrong-network key, an IP
 * allowlist miss, a geo-block, a DNS outage or a timeout. That sent operators hunting for a broken
 * key when the real cause was a flag or a region.
 *
 * The classification is pure (no network, no env) so it can be unit-tested exhaustively.
 */

export type BinanceFailureCode =
  | 'GEO_BLOCKED'
  | 'IP_NOT_ALLOWED'
  | 'INVALID_KEY'
  | 'KEY_NETWORK_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'TIMESTAMP_DRIFT'
  | 'RATE_LIMITED'
  | 'NETWORK_UNREACHABLE'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface BinanceFailure {
  /** Stable machine code for the UI/logs. */
  code: BinanceFailureCode;
  /** One line: what actually happened. */
  title: string;
  /** What the operator should do about it. */
  action: string;
  /** Safe to simply try again later? */
  retryable: boolean;
  /** Raw HTTP status (0 = the request never got a response). */
  httpStatus: number;
  /** Binance error code when one was returned (e.g. -2015). */
  binanceCode: number | null;
}

interface RawFailure {
  message: string;
  httpStatus: number;
  binanceCode: number | null;
}

const RATE_LIMIT_HTTP = new Set([418, 429]);

/**
 * Accepts anything thrown by the Binance client (or a plain Error) and pulls out the fields the
 * classifier needs. Duck-typed on purpose so this module imports nothing and stays testable.
 */
export function toRawFailure(err: unknown): RawFailure {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; httpStatus?: unknown; code?: unknown };
    const httpStatus = typeof e.httpStatus === 'number' && Number.isFinite(e.httpStatus) ? e.httpStatus : 0;
    const binanceCode = typeof e.code === 'number' && Number.isFinite(e.code) ? e.code : null;
    return { message: String(e.message ?? ''), httpStatus, binanceCode };
  }
  return { message: String(err ?? ''), httpStatus: 0, binanceCode: null };
}

/**
 * Order matters: the first matching rule wins, so the most specific and most consequential
 * condition (legal geo-block) is checked before generic credential rejections.
 */
export function classifyBinanceFailure(
  raw: RawFailure,
  isTestnet: boolean
): BinanceFailure {
  const { message, httpStatus, binanceCode } = raw;
  const m = message.toLowerCase();

  const make = (
    code: BinanceFailureCode,
    title: string,
    action: string,
    retryable = false
  ): BinanceFailure => ({ code, title, action, retryable, httpStatus, binanceCode });

  // 1. Legal geo-restriction. Binance answers 451 (sometimes with code 0) before authentication,
  //    so no credential or flag can work around it.
  if (httpStatus === 451 || /restricted location|eligibility/.test(m)) {
    return make(
      'GEO_BLOCKED',
      "Binance refused the request because this server's location is restricted (HTTP 451)",
      'Move the deployment to a region where Binance Futures is permitted — the United States, Malaysia, Ontario (Canada) and a few others are restricted. No API key, permission change or code change can bypass this.'
    );
  }

  // 2. Rate limiting.
  if (RATE_LIMIT_HTTP.has(httpStatus) || binanceCode === -1003 || /too many requests|banned until/.test(m)) {
    return make(
      'RATE_LIMITED',
      'Binance rate limit reached',
      'Wait for the weight window to reset — the app backs off automatically. A slower scan interval or a shorter symbol allowlist reduces the load.',
      true
    );
  }

  // 3. Clock skew and signature mismatch have their own Binance codes and their own fixes.
  if (binanceCode === -1021 || /timestamp for this request is outside/.test(m)) {
    return make(
      'TIMESTAMP_DRIFT',
      'Binance rejected the request timestamp (clock skew)',
      'The host clock has drifted more than ~1s from Binance. Enable NTP/time synchronisation on the server or platform, then retry.',
      true
    );
  }
  if (binanceCode === -1022 || /signature for this request is not valid/.test(m)) {
    return make(
      'SIGNATURE_INVALID',
      'The API secret does not match the API key (signature rejected)',
      'Re-copy the secret from Binance API Management. Secrets are shown only once — if it was lost, delete the key and create a new pair.'
    );
  }

  // 4. -2015 is Binance's catch-all for "key / IP / permission". Split it as far as the text allows.
  if (binanceCode === -2015 || /invalid api-key/.test(m)) {
    if (/request ip/.test(m)) {
      return make(
        'IP_NOT_ALLOWED',
        "This server's IP is not on the API key's whitelist",
        fsIpAction()
      );
    }
    if (isTestnet) {
      return make(
        'KEY_NETWORK_MISMATCH',
        'These keys are not valid on Binance Futures Testnet',
        'Testnet needs keys created at testnet.binancefuture.com — mainnet keys are rejected there (and testnet keys are rejected on mainnet). This is what happens when BINANCE_TESTNET=true but real mainnet keys are supplied.'
      );
    }
    return make(
      'INVALID_KEY',
      'Binance did not recognise the API key, its IP, or its permissions',
      'Check all three: (1) the key string is correct, (2) the key has "Enable Futures" permission, and (3) any IP restriction includes this server. If the key was made on Binance Futures Testnet it will not work here, and vice versa.'
    );
  }

  // 5. Plain HTTP auth failures.
  if (httpStatus === 401) {
    return make(
      'INVALID_KEY',
      'Binance rejected the API key (HTTP 401)',
      'Verify the key and secret, that "Enable Futures" is on, and that the key belongs to the network this deployment targets (BINANCE_TESTNET).'
    );
  }
  if (httpStatus === 403) {
    return make(
      'IP_NOT_ALLOWED',
      "Binance refused the request from this server's address (HTTP 403)",
      fsIpAction()
    );
  }

  // 6. Transport failures: the request never reached an authenticated answer.
  if (httpStatus === 0) {
    if (/timed out|timeout|abort/.test(m)) {
      return make(
        'TIMEOUT',
        'Binance did not answer before the client timeout',
        'Usually transient or an egress-proxy problem. Retry; if it persists, check the deployment network path to fapi.binance.com and testnet.binancefuture.com.',
        true
      );
    }
    return make(
      'NETWORK_UNREACHABLE',
      'This server could not reach Binance at all',
      'This is an egress/DNS problem, not a credential problem — no key would work. Confirm outbound HTTPS access from the deployment and see the reachability block in /api/config/check.',
      true
    );
  }

  return make(
    'UNKNOWN',
    `Binance call failed (HTTP ${httpStatus}${binanceCode !== null ? `, code ${binanceCode}` : ''})`,
    'Inspect the raw message below. If it repeats, it is worth reporting.'
  );
}

/** Shared remediation text for the two IP-block cases. */
function fsIpAction(): string {
  return "Add this server's egress IP to the key's whitelist in Binance API Management (GET /api/network/ip reports it), or remove the IP restriction from the key.";
}

/** Convenience wrapper for `catch` blocks. */
export function classifyError(err: unknown, isTestnet: boolean): BinanceFailure {
  return classifyBinanceFailure(toRawFailure(err), isTestnet);
}

/**
 * HTTP status our own route should answer with, so the failure is not flattened into a generic 401
 * "your key is bad": a geo-block is 451, throttling is 429, an unreachable exchange is 502.
 */
export function httpStatusForFailure(code: BinanceFailureCode): number {
  switch (code) {
    case 'GEO_BLOCKED':
      return 451;
    case 'RATE_LIMITED':
      return 429;
    case 'NETWORK_UNREACHABLE':
    case 'TIMEOUT':
      return 502;
    case 'TIMESTAMP_DRIFT':
      return 500;
    default:
      return 401; // credential-class failures (key, secret, network mismatch, IP allowlist, permissions)
  }
}

/** `title — action` in one string, for logs that have a single message field. */
export function failureMessage(f: BinanceFailure): string {
  return `${f.title} — ${f.action}`;
}
