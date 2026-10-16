import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/operator-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IP_SERVICES = [
  { url: 'https://api.ipify.org?format=json', kind: 'json' as const },
  { url: 'https://api4.my-ip.io/ip.json', kind: 'json' as const },
  { url: 'https://checkip.amazonaws.com', kind: 'text' as const },
  { url: 'https://ipv4.icanhazip.com', kind: 'text' as const },
];

const isPrivateOrLoopback = (ip: string): boolean =>
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(ip) ||
  ip.includes(':') ||
  ip === 'localhost';

/**
 * Reports the egress IP to whitelist on Binance.
 *
 * The previous version returned a *hardcoded, invented* address when detection failed and presented
 * it as trustworthy guidance — telling a user to whitelist an IP they do not own would either break
 * their keys or grant access to someone else's range. Detection failure now reports `null` and says so.
 */
export async function GET(_req: NextRequest) {
  // Reaches four third-party IP services on every call, so it is not left open to crawlers; the
  // app's Settings view is behind the operator gate anyway. No-op when no session is required.
  const operator = requireOperator(_req);
  if (!operator.ok) {
    return NextResponse.json({ success: false, code: operator.code, error: operator.error }, { status: operator.httpStatus });
  }

  const warnings: string[] = [];
  let ipv4: string | null = null;
  let source: 'egress-probe' | 'proxy-header' | 'unknown' = 'unknown';
  const attempts: { url: string; ok: boolean; detail: string }[] = [];

  for (const service of IP_SERVICES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(service.url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timer);

      if (!res.ok) {
        attempts.push({ url: service.url, ok: false, detail: `HTTP ${res.status}` });
        continue;
      }

      let candidate = '';
      if (service.kind === 'json') {
        const data = (await res.json().catch(() => null)) as { ip?: string; IPv4?: string } | null;
        candidate = (data?.ip || data?.IPv4 || '').trim();
      } else {
        candidate = (await res.text()).trim();
      }

      if (candidate && /^(\d{1,3}\.){3}\d{1,3}$/.test(candidate) && !isPrivateOrLoopback(candidate)) {
        ipv4 = candidate;
        source = 'egress-probe';
        attempts.push({ url: service.url, ok: true, detail: candidate });
        break;
      }
      attempts.push({ url: service.url, ok: false, detail: `unusable value "${candidate.slice(0, 32)}"` });
    } catch (err) {
      attempts.push({ url: service.url, ok: false, detail: (err as Error).message });
    }
  }

  // Server-side egress can differ from the proxy-visible client IP, so a header value is only a
  // hint and is never presented as an address to whitelist.
  if (!ipv4) {
    const forwarded = _req.headers.get('x-forwarded-for');
    const first = forwarded?.split(',')[0]?.trim();
    if (first && !isPrivateOrLoopback(first)) {
      warnings.push(
        `Could not probe egress IP directly. Request arrived via proxy header x-forwarded-for=${first}; that is the CLIENT address, not this server's egress address — do not whitelist it for Binance.`
      );
    }
    warnings.push('Egress IP could not be determined from this environment.');
  }

  const isEphemeralEgress = !ipv4;
  if (isEphemeralEgress) {
    warnings.push(
      'On serverless platforms (Cloud Run included) egress IP is usually ephemeral unless you provision a dedicated VPC connector / static egress IP. Prefer a static IP, or a key with no IP binding plus tight permissions.'
    );
  }

  return NextResponse.json({
    ipv4,
    verified: source === 'egress-probe',
    source,
    attempts,
    warnings,
    binanceWhitelistingInstructions: ipv4
      ? [
          'Log into Binance > Account > API Management',
          'Select your Trade Master API key and click "Edit Restrictions"',
          'Under "IP Access Restriction", choose "Restrict access to trusted IPs only (Recommended)"',
          `Paste exactly this verified address: ${ipv4}`,
          'Enable "Futures" permission only — disable "Withdraw" and "Enable Spot & Margin Trading"',
        ]
      : [
          'Do NOT whitelist an IP you have not verified — a wrong entry either locks you out or grants access to a stranger.',
          'Option A (recommended): provision a static egress IP for this service (e.g. Cloud Run VPC connector) and re-run this check.',
          'Option B: keep "No restrictions" but scope the key to Futures only, set a per-key limit, and keep a separate withdrawal-disabled key.',
        ],
    timestamp: new Date().toISOString(),
  });
}
