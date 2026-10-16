import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey, apiSecret, isTestnet = false } = body;

    const baseUrl = isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    // 1. Test basic connectivity (Ping)
    const startTime = Date.now();
    let pingSuccess = false;
    let pingLatency = 0;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const pingRes = await fetch(`${baseUrl}/fapi/v1/ping`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timeout);
      pingLatency = Date.now() - startTime;
      pingSuccess = pingRes.ok;
    } catch {
      pingLatency = Date.now() - startTime;
      pingSuccess = false;
    }

    // 2. If credentials provided, attempt authenticated account balance query
    let authValid = false;
    let balanceInfo = null;
    let errorMessage: string | null = null;

    if (apiKey && apiSecret) {
      try {
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}&recvWindow=5000`;
        const signature = crypto
          .createHmac('sha256', apiSecret)
          .update(queryString)
          .digest('hex');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const accountRes = await fetch(
          `${baseUrl}/fapi/v2/account?${queryString}&signature=${signature}`,
          {
            headers: {
              'X-MBX-APIKEY': apiKey,
            },
            signal: controller.signal,
            cache: 'no-store',
          }
        );
        clearTimeout(timeout);

        if (accountRes.ok) {
          const accData = await accountRes.json();
          authValid = true;
          pingSuccess = true;
          balanceInfo = {
            totalWalletBalance: parseFloat(accData.totalWalletBalance || '0'),
            totalUnrealizedProfit: parseFloat(accData.totalUnrealizedProfit || '0'),
            availableBalance: parseFloat(accData.availableBalance || '0'),
            canTrade: accData.canTrade ?? true,
          };
        } else {
          const errData = await accountRes.json().catch(() => ({}));
          errorMessage =
            errData.msg || `Binance API rejected credentials (HTTP ${accountRes.status})`;
        }
      } catch (err: unknown) {
        const error = err as Error;
        errorMessage = error.message || 'Network error reaching Binance Futures API';
      }
    } else {
      errorMessage = 'Please provide both Binance API Key and Secret Key.';
    }

    return NextResponse.json({
      success: authValid || pingSuccess,
      endpoint: baseUrl,
      ping: {
        status: pingSuccess ? 'ONLINE' : 'UNREACHABLE',
        latencyMs: pingLatency,
      },
      auth: {
        provided: Boolean(apiKey && apiSecret),
        valid: authValid,
        message: authValid
          ? 'API Key & Secret verified on Binance Futures'
          : errorMessage || 'Unable to verify Binance Futures credentials.',
        balance: balanceInfo,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json(
      { success: false, error: error.message || 'Invalid request' },
      { status: 400 }
    );
  }
}
