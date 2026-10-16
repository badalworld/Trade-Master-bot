import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey, apiSecret, isTestnet = false, symbol, side, margin, leverage, price, stopLoss, takeProfit } = body;

    if (!apiKey || !apiSecret) {
      return NextResponse.json({ success: false, error: 'Binance API Key and Secret are required for live trade execution.' }, { status: 400 });
    }

    const baseUrl = isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    const timestamp = Date.now();
    // Calculate quantity based on margin * leverage / price
    const notional = margin * leverage;
    const quantity = Number((notional / price).toFixed(4));

    // 1. Place order on Binance Futures
    const orderParams = new URLSearchParams({
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(), // BUY or SELL
      type: 'MARKET',
      quantity: String(quantity > 0 ? quantity : 0.001),
      timestamp: String(timestamp),
      recvWindow: '5000',
    });

    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(orderParams.toString())
      .digest('hex');

    orderParams.append('signature', signature);

    const orderRes = await fetch(`${baseUrl}/fapi/v1/order`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: orderParams.toString(),
    });

    if (!orderRes.ok) {
      const errData = await orderRes.json().catch(() => ({}));
      return NextResponse.json({
        success: false,
        error: errData.msg || `Binance Order Execution Error HTTP ${orderRes.status}`,
      }, { status: 400 });
    }

    const orderData = await orderRes.json();

    return NextResponse.json({
      success: true,
      orderId: orderData.orderId,
      symbol: orderData.symbol,
      status: orderData.status,
      executedQty: orderData.executedQty,
      avgPrice: orderData.avgPrice || price,
      clientOrderId: orderData.clientOrderId,
      timestamp: Date.now(),
    });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ success: false, error: error.message || 'Execution error' }, { status: 500 });
  }
}
