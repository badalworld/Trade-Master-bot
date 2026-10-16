import { NextRequest, NextResponse } from 'next/server';
import { BinanceApiError, getAccount, getIncome, getLivePositions } from '@/lib/binance-client';
import { checkRequestIntegrity, resolveCredentials } from '@/lib/trade-guard';
import { requireOperator } from '@/lib/operator-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Authoritative account snapshot straight from Binance. Positions come from the exchange, so a
 * cleared browser cache can no longer make a real open position "disappear" from the UI.
 */
export async function POST(req: NextRequest) {
  try {
    const integrity = checkRequestIntegrity(req);
    if (!integrity.ok) return NextResponse.json({ success: false, error: integrity.error }, { status: 403 });

    const operator = requireOperator(req);
    if (!operator.ok) {
      return NextResponse.json({ success: false, code: operator.code, error: operator.error }, { status: operator.httpStatus });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const forbidden of ['apiKey', 'apiSecret']) {
      if (body[forbidden] !== undefined) {
        return NextResponse.json(
          { success: false, code: 'CREDENTIALS_IN_BODY', error: `Do not send "${forbidden}" — credentials are resolved server-side.` },
          { status: 400 }
        );
      }
    }

    const resolution = resolveCredentials(req);
    if (!resolution.ok) {
      return NextResponse.json({ success: false, code: resolution.code, error: resolution.error }, { status: resolution.status });
    }
    const creds = resolution.creds;

    const [account, positions, income] = await Promise.all([
      getAccount(creds),
      getLivePositions(creds).catch(() => []),
      getIncome(creds, 200).catch(() => []),
    ]);

    let totalRealizedPnl = 0;
    let totalCommissionFees = 0;
    let totalFundingFees = 0;
    for (const item of income) {
      if (item.incomeType === 'REALIZED_PNL') totalRealizedPnl += item.income;
      else if (item.incomeType === 'COMMISSION') totalCommissionFees += Math.abs(item.income);
      else if (item.incomeType === 'FUNDING_FEE') totalFundingFees += item.income;
    }

    return NextResponse.json(
      {
        success: true,
        timestamp: Date.now(),
        network: creds.isTestnet ? 'testnet' : 'mainnet',
        usedWeight: account.usedWeight,
        balance: {
          totalWalletBalance: account.totalWalletBalance,
          availableBalance: account.availableBalance,
          totalMarginBalance: account.totalMarginBalance || account.totalWalletBalance + account.totalUnrealizedProfit,
          currentEquity: account.totalWalletBalance + account.totalUnrealizedProfit,
          totalUnrealizedProfit: account.totalUnrealizedProfit,
          totalRealizedPnl: Number(totalRealizedPnl.toFixed(4)),
          totalCommissionFees: Number(totalCommissionFees.toFixed(4)),
          totalFundingFees: Number(totalFundingFees.toFixed(4)),
          incomeRecordsCount: income.length,
          openPositionsCount: positions.length,
          canTrade: account.canTrade,
        },
        positions: positions.map((p) => ({
          symbol: p.symbol,
          side: p.side,
          positionAmt: p.positionAmt,
          quantity: Math.abs(p.positionAmt),
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          unrealizedProfit: Number(p.unrealizedProfit.toFixed(4)),
          leverage: p.leverage,
          margin: Number(p.isolatedMargin.toFixed(4)),
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    const message = err instanceof BinanceApiError ? err.message : (err as Error).message;
    return NextResponse.json(
      { success: false, error: message || 'Account sync failed' },
      { status: err instanceof BinanceApiError ? 400 : 500 }
    );
  }
}
