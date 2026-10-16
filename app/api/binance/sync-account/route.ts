import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

interface BinanceRawPosition {
  symbol?: string;
  positionAmt?: string;
  entryPrice?: string;
  markPrice?: string;
  unRealizedProfit?: string;
  unrealizedProfit?: string;
  leverage?: string;
  isolatedWallet?: string;
  initialMargin?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey, apiSecret, isTestnet = false } = body;

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        {
          success: false,
          error: 'API Key and Secret Key are required to sync Binance account details.',
        },
        { status: 400 }
      );
    }

    const baseUrl = isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}&recvWindow=5000`;
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');

    // 1. Fetch authenticated account info (wallet balance, unrealized pnl, open positions, etc.)
    const accountRes = await fetch(
      `${baseUrl}/fapi/v2/account?${queryString}&signature=${signature}`,
      {
        headers: {
          'X-MBX-APIKEY': apiKey,
        },
        cache: 'no-store',
      }
    );

    if (!accountRes.ok) {
      const errData = await accountRes.json().catch(() => ({}));
      return NextResponse.json(
        {
          success: false,
          error: errData.msg || `Binance API error HTTP ${accountRes.status}`,
        },
        { status: 400 }
      );
    }

    const usedWeightHeader = accountRes.headers.get('x-mbx-used-weight-1m');
    const usedWeight = usedWeightHeader ? parseInt(usedWeightHeader, 10) : undefined;

    const accData = await accountRes.json();
    const totalWalletBalance = parseFloat(accData.totalWalletBalance || '0');
    const totalUnrealizedProfit = parseFloat(accData.totalUnrealizedProfit || '0');
    const availableBalance = parseFloat(accData.availableBalance || '0');
    const totalMarginBalance = parseFloat(accData.totalMarginBalance || '0');

    // 2. Query income history for realized PnL, platform commission fees, and funding fees
    let totalRealizedPnl = 0;
    let totalCommissionFees = 0;
    let totalFundingFees = 0;
    let incomeRecordsCount = 0;

    try {
      const incomeTimestamp = Date.now();
      const incomeQueryString = `timestamp=${incomeTimestamp}&recvWindow=5000&limit=100`;
      const incomeSig = crypto
        .createHmac('sha256', apiSecret)
        .update(incomeQueryString)
        .digest('hex');

      const incomeRes = await fetch(
        `${baseUrl}/fapi/v1/income?${incomeQueryString}&signature=${incomeSig}`,
        {
          headers: {
            'X-MBX-APIKEY': apiKey,
          },
          cache: 'no-store',
        }
      );

      if (incomeRes.ok) {
        const incomeData = await incomeRes.json();
        if (Array.isArray(incomeData)) {
          incomeRecordsCount = incomeData.length;
          for (const item of incomeData) {
            const amount = parseFloat(item.income || '0');
            if (item.incomeType === 'REALIZED_PNL') {
              totalRealizedPnl += amount;
            } else if (item.incomeType === 'COMMISSION') {
              totalCommissionFees += Math.abs(amount);
            } else if (item.incomeType === 'FUNDING_FEE') {
              totalFundingFees += amount;
            }
          }
        }
      }
    } catch {
      // Income history optional fallback if rate limit or network issue
    }

    // 3. Extract active positions from Binance directly
    const rawPositions: BinanceRawPosition[] = Array.isArray(accData.positions)
      ? accData.positions.filter(
          (p: BinanceRawPosition) => Math.abs(parseFloat(p.positionAmt || '0')) > 0
        )
      : [];

    return NextResponse.json({
      success: true,
      timestamp: Date.now(),
      usedWeight: !isNaN(Number(usedWeight)) ? usedWeight : undefined,
      balance: {
        totalWalletBalance,
        availableBalance,
        totalMarginBalance: totalMarginBalance || totalWalletBalance + totalUnrealizedProfit,
        currentEquity: totalWalletBalance + totalUnrealizedProfit,
        totalUnrealizedProfit,
        totalRealizedPnl,
        totalCommissionFees,
        totalFundingFees,
        incomeRecordsCount,
        openPositionsCount: rawPositions.length,
      },
      positions: rawPositions.map((p) => {
        const amt = parseFloat(p.positionAmt || '0');
        const entryPrice = parseFloat(p.entryPrice || '0');
        const markPrice = parseFloat(p.markPrice || '0') || entryPrice;
        const leverage = parseInt(p.leverage || '10', 10) || 10;
        const unrealizedProfit = parseFloat(
          p.unRealizedProfit || p.unrealizedProfit || '0'
        );
        const isolatedMargin =
          parseFloat(p.isolatedWallet || p.initialMargin || '0') ||
          (Math.abs(amt) * entryPrice) / leverage;

        return {
          symbol: p.symbol || 'BTCUSDT',
          side: amt >= 0 ? 'LONG' : 'SHORT',
          positionAmt: amt,
          quantity: Math.abs(amt),
          entryPrice,
          markPrice,
          unrealizedProfit,
          leverage,
          margin: Number(isolatedMargin.toFixed(2)),
        };
      }),
    });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Internal server error while syncing Binance account',
      },
      { status: 500 }
    );
  }
}
