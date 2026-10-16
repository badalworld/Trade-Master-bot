import { NextRequest, NextResponse } from 'next/server';
import { baseUrlFor, getAccount, publicGet } from '@/lib/binance-client';
import { classifyError, type BinanceFailure } from '@/lib/binance-errors';
import { buildConfigCheck, type ReachabilityProbe } from '@/lib/config-check';
import { engine, loadEngineConfig } from '@/lib/engine';
import { operatorAuthMode, operatorAuthRequired, operatorTokenConfigured, requireOperator } from '@/lib/operator-auth';
import { ledger, ledgerPath } from '@/lib/position-ledger';
import { loadRiskPolicy, policySummary } from '@/lib/risk-policy';
import { envCredentials, resolveCredentials, sessionStatus } from '@/lib/trade-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROBE_TIMEOUT_MS = 4000;

/**
 * One-shot deployment self-diagnosis: why is (or isn't) this deployment able to trade, and on which
 * network? Replaces the guesswork of reading logs — an operator gets a verdict, a reachability
 * report for both Binance hosts, and an explicit action list.
 *
 * Operator-gated like every other account-touching route, and it never returns key material (only
 * presence flags and the same 4+4 character hint the Settings panel shows).
 */
export async function GET(req: NextRequest) {
  if (req.headers.get('x-tm-request') !== '1') {
    return NextResponse.json(
      { success: false, code: 'ORIGIN_REJECTED', error: 'Direct browsing of this endpoint is not allowed.' },
      { status: 403 }
    );
  }

  const operator = requireOperator(req);
  if (!operator.ok) {
    return NextResponse.json({ success: false, code: operator.code, error: operator.error }, { status: operator.httpStatus });
  }

  // ---------------------------------------------------------------- configuration (no network)
  const env = process.env;
  const apiKeyPresent = Boolean((env.BINANCE_API_KEY ?? '').trim());
  const apiSecretPresent = Boolean((env.BINANCE_API_SECRET ?? '').trim());
  const testnetRaw = env.BINANCE_TESTNET === undefined ? null : env.BINANCE_TESTNET;

  const status = sessionStatus(req);
  const isTestnet = status.active ? status.isTestnet : envCredentials()?.isTestnet ?? true;
  const targetNetwork: 'testnet' | 'mainnet' = isTestnet ? 'testnet' : 'mainnet';

  const engineConfig = loadEngineConfig(env);
  const engineStatus = engine.getStatus();
  const policy = loadRiskPolicy();
  const dataDir = ledgerPath();

  // ---------------------------------------------------------------- reachability (both hosts)
  const probe = async (testnet: boolean): Promise<ReachabilityProbe> => {
    const started = Date.now();
    try {
      await publicGet(testnet, '/fapi/v1/ping', '', PROBE_TIMEOUT_MS);
      return { reachable: true, latencyMs: Date.now() - started, failure: null };
    } catch (err) {
      return {
        reachable: false,
        latencyMs: Date.now() - started,
        failure: classifyError(err, testnet),
      };
    }
  };
  const [testnetReach, mainnetReach] = await Promise.all([probe(true), probe(false)]);

  // ---------------------------------------------------------------- authenticated verification
  let verification: {
    attempted: boolean;
    ok: boolean;
    failure: BinanceFailure | null;
    balanceUsdt: number | null;
    canTrade: boolean | null;
  } = { attempted: false, ok: false, failure: null, balanceUsdt: null, canTrade: null };

  const resolution = resolveCredentials(req);
  if (resolution.ok) {
    verification = { ...verification, attempted: true };
    try {
      const account = await getAccount(resolution.creds);
      verification = {
        attempted: true,
        ok: true,
        failure: null,
        balanceUsdt: account.availableBalance,
        canTrade: account.canTrade,
      };
    } catch (err) {
      verification = {
        attempted: true,
        ok: false,
        failure: classifyError(err, resolution.creds.isTestnet),
        balanceUsdt: null,
        canTrade: null,
      };
    }
  }

  const result = buildConfigCheck({
    operator: {
      required: operatorAuthRequired(env),
      configured: operatorTokenConfigured(env),
      authenticated: true, // this request passed the gate above
      mode: operatorAuthMode(env),
    },
    keys: { apiKeyPresent, apiSecretPresent, testnetRaw, isTestnet },
    credentials: { source: status.source, keyHint: status.keyHint ?? null },
    verification: { attempted: verification.attempted, ok: verification.ok, failure: verification.failure },
    reachability: { testnet: testnetReach, mainnet: mainnetReach },
    engine: { enabled: engineConfig.enabled, autoEntry: engineConfig.autoEntry, running: engineStatus.running },
    ledger: { durable: ledger.isDurable(), path: dataDir },
    policy: {
      halted: policy.halted,
      allowMainnet: policy.allowMainnet,
      maxMarginUsdt: policy.maxMarginUsdt,
      maxDailyLossUsdt: policy.maxDailyLossUsdt,
      maxOpenPositions: policy.maxOpenPositions,
    },
  });

  const blockers = result.issues.filter((i) => i.severity === 'blocker').length;

  return NextResponse.json({
    success: true,
    verdict: result.verdict,
    headline: result.headline,
    targetNetwork: result.targetNetwork,
    endpoint: baseUrlFor(isTestnet),
    binanceTestnetRaw: testnetRaw,
    credentials: { source: status.source, keyHint: status.keyHint ?? null, active: status.active },
    operator: {
      required: operatorAuthRequired(env),
      configured: operatorTokenConfigured(env),
      mode: operatorAuthMode(env),
      authenticated: true,
    },
    serverKeys: { apiKeyPresent, apiSecretPresent },
    verification,
    reachability: { testnet: testnetReach, mainnet: mainnetReach },
    engine: {
      enabled: engineConfig.enabled,
      autoEntry: engineConfig.autoEntry,
      enforceBrackets: engineConfig.enforceBrackets,
      running: engineStatus.running,
      cycles: engineStatus.cycles,
      credentialSource: engineStatus.credentialSource,
      lastError: engineStatus.lastError,
    },
    ledger: { path: dataDir, durable: ledger.isDurable() },
    policy: policySummary(policy),
    blockers,
    issues: result.issues,
    timestamp: new Date().toISOString(),
  });
}
