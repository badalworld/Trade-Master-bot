import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

interface SymbolFilterSpec {
  quantityPrecision: number;
  pricePrecision: number;
  minQty: number;
  stepSize: number;
  tickSize: number;
}

// Built-in precision defaults for Binance USDT-M Perpetual Futures pairs
const FALLBACK_SYMBOL_SPECS: Record<string, SymbolFilterSpec> = {
  BTCUSDT: { quantityPrecision: 3, pricePrecision: 2, minQty: 0.001, stepSize: 0.001, tickSize: 0.1 },
  ETHUSDT: { quantityPrecision: 3, pricePrecision: 2, minQty: 0.001, stepSize: 0.001, tickSize: 0.01 },
  SOLUSDT: { quantityPrecision: 0, pricePrecision: 2, minQty: 1, stepSize: 1, tickSize: 0.01 },
  BNBUSDT: { quantityPrecision: 2, pricePrecision: 2, minQty: 0.01, stepSize: 0.01, tickSize: 0.01 },
  DOGEUSDT: { quantityPrecision: 0, pricePrecision: 5, minQty: 1, stepSize: 1, tickSize: 0.00001 },
  XRPUSDT: { quantityPrecision: 1, pricePrecision: 4, minQty: 0.1, stepSize: 0.1, tickSize: 0.0001 },
  ADAUSDT: { quantityPrecision: 0, pricePrecision: 4, minQty: 1, stepSize: 1, tickSize: 0.0001 },
  AVAXUSDT: { quantityPrecision: 0, pricePrecision: 2, minQty: 1, stepSize: 1, tickSize: 0.01 },
  SUIUSDT: { quantityPrecision: 1, pricePrecision: 4, minQty: 0.1, stepSize: 0.1, tickSize: 0.0001 },
  LINKUSDT: { quantityPrecision: 2, pricePrecision: 3, minQty: 0.01, stepSize: 0.01, tickSize: 0.001 },
  NEARUSDT: { quantityPrecision: 0, pricePrecision: 3, minQty: 1, stepSize: 1, tickSize: 0.001 },
  PEPEUSDT: { quantityPrecision: 0, pricePrecision: 8, minQty: 100, stepSize: 1, tickSize: 0.00000001 },
  '1000PEPEUSDT': { quantityPrecision: 0, pricePrecision: 7, minQty: 1, stepSize: 1, tickSize: 0.0000001 },
};

let cachedExchangeSpecs: Record<string, SymbolFilterSpec> | null = null;
let cachedAt = 0;

async function getSymbolSpec(baseUrl: string, symbol: string): Promise<SymbolFilterSpec> {
  const upper = symbol.toUpperCase();
  const now = Date.now();

  if (!cachedExchangeSpecs || now - cachedAt > 10 * 60 * 1000) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${baseUrl}/fapi/v1/exchangeInfo`, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.symbols)) {
          const map: Record<string, SymbolFilterSpec> = {};
          for (const s of data.symbols) {
            const lotFilter = s.filters?.find((f: { filterType: string }) => f.filterType === 'LOT_SIZE');
            const priceFilter = s.filters?.find((f: { filterType: string }) => f.filterType === 'PRICE_FILTER');
            map[s.symbol] = {
              quantityPrecision: Number(s.quantityPrecision ?? 3),
              pricePrecision: Number(s.pricePrecision ?? 4),
              minQty: parseFloat(lotFilter?.minQty || '0.001'),
              stepSize: parseFloat(lotFilter?.stepSize || '0.001'),
              tickSize: parseFloat(priceFilter?.tickSize || '0.0001'),
            };
          }
          cachedExchangeSpecs = map;
          cachedAt = now;
        }
      }
    } catch {
      // Fallback to built-in specs
    }
  }

  return (
    cachedExchangeSpecs?.[upper] ||
    FALLBACK_SYMBOL_SPECS[upper] || {
      quantityPrecision: 3,
      pricePrecision: 4,
      minQty: 0.001,
      stepSize: 0.001,
      tickSize: 0.0001,
    }
  );
}

function formatByStep(value: number, step: number, precision: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (step > 0) {
    const stepped = Math.floor(value / step + 1e-8) * step;
    return stepped.toFixed(precision);
  }
  return value.toFixed(precision);
}

function signParams(params: URLSearchParams, secret: string): string {
  const sig = crypto.createHmac('sha256', secret).update(params.toString()).digest('hex');
  params.append('signature', sig);
  return params.toString();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      apiKey,
      apiSecret,
      isTestnet = false,
      action = 'OPEN', // 'OPEN' | 'CLOSE'
      symbol,
      side, // 'LONG' | 'SHORT' | 'BUY' | 'SELL'
      margin = 2.0,
      leverage = 10,
      price,
      quantity: requestedQty,
      stopLoss,
      takeProfit,
    } = body;

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        {
          success: false,
          error: 'Binance API Key and Secret are required for live trade execution.',
        },
        { status: 400 }
      );
    }

    if (!symbol) {
      return NextResponse.json({ success: false, error: 'Trading symbol is required.' }, { status: 400 });
    }

    const cleanSymbol = String(symbol).toUpperCase();
    const baseUrl = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
    const spec = await getSymbolSpec(baseUrl, cleanSymbol);

    // -------------------------------------------------------------------------
    // CASE 1: CLOSE AN EXISTING OPEN POSITION ON BINANCE
    // -------------------------------------------------------------------------
    if (action === 'CLOSE') {
      const normalizedSide = String(side).toUpperCase();
      // To close a LONG position we SELL; to close a SHORT position we BUY
      const closeOrderSide =
        normalizedSide === 'LONG' || normalizedSide === 'BUY' ? 'SELL' : 'BUY';

      // 1. Cancel any open TP/SL conditional orders for this symbol first
      try {
        const cancelParams = new URLSearchParams({
          symbol: cleanSymbol,
          timestamp: String(Date.now()),
          recvWindow: '5000',
        });
        await fetch(`${baseUrl}/fapi/v1/allOpenOrders`, {
          method: 'DELETE',
          headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: signParams(cancelParams, apiSecret),
        });
      } catch {
        // Non-fatal if no open orders exist
      }

      // 2. Submit reduceOnly MARKET order to close the position
      const rawCloseQty = Math.max(spec.minQty, Number(requestedQty) || spec.minQty);
      const formattedCloseQty = formatByStep(rawCloseQty, spec.stepSize, spec.quantityPrecision);

      const closeParams = new URLSearchParams({
        symbol: cleanSymbol,
        side: closeOrderSide,
        type: 'MARKET',
        quantity: formattedCloseQty,
        reduceOnly: 'true',
        timestamp: String(Date.now()),
        recvWindow: '5000',
      });

      const closeRes = await fetch(`${baseUrl}/fapi/v1/order`, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: signParams(closeParams, apiSecret),
      });

      if (!closeRes.ok) {
        const errData = await closeRes.json().catch(() => ({}));
        return NextResponse.json(
          {
            success: false,
            error: errData.msg || `Binance Close Order Error HTTP ${closeRes.status}`,
          },
          { status: 400 }
        );
      }

      const closeData = await closeRes.json();
      return NextResponse.json({
        success: true,
        action: 'CLOSE',
        orderId: closeData.orderId,
        symbol: closeData.symbol,
        status: closeData.status,
        executedQty: closeData.executedQty || formattedCloseQty,
        avgPrice: parseFloat(closeData.avgPrice || '0') || price,
        timestamp: Date.now(),
      });
    }

    // -------------------------------------------------------------------------
    // CASE 2: OPEN A NEW POSITION WITH ISOLATED LEVERAGE & INDICATOR TP/SL
    // -------------------------------------------------------------------------
    const normalizedSide = String(side).toUpperCase();
    // Map LONG -> BUY, SHORT -> SELL as required by Binance Futures /fapi/v1/order
    const entryOrderSide: 'BUY' | 'SELL' =
      normalizedSide === 'LONG' || normalizedSide === 'BUY' ? 'BUY' : 'SELL';
    const exitOrderSide: 'BUY' | 'SELL' = entryOrderSide === 'BUY' ? 'SELL' : 'BUY';

    const clampedLeverage = Math.min(50, Math.max(1, Math.round(Number(leverage) || 10)));
    const safeMargin = Math.max(1.0, Number(margin) || 2.0);
    const entryPrice = Number(price) || 0;

    if (entryPrice <= 0) {
      return NextResponse.json(
        { success: false, error: 'Valid market price is required for order execution.' },
        { status: 400 }
      );
    }

    // 1. Set Margin Type to ISOLATED on Binance (ignore -4046 if already ISOLATED)
    try {
      const marginParams = new URLSearchParams({
        symbol: cleanSymbol,
        marginType: 'ISOLATED',
        timestamp: String(Date.now()),
        recvWindow: '5000',
      });
      await fetch(`${baseUrl}/fapi/v1/marginType`, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: signParams(marginParams, apiSecret),
      });
    } catch {
      // Continue if already isolated
    }

    // 2. Set Leverage (10x - 15x) on Binance
    try {
      const levParams = new URLSearchParams({
        symbol: cleanSymbol,
        leverage: String(clampedLeverage),
        timestamp: String(Date.now()),
        recvWindow: '5000',
      });
      await fetch(`${baseUrl}/fapi/v1/leverage`, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: signParams(levParams, apiSecret),
      });
    } catch {
      // Continue if leverage call fails
    }

    // 3. Calculate quantity from ($2 Base Margin * 10x-15x Leverage) / Price, stepped to LOT_SIZE
    const notional = safeMargin * clampedLeverage;
    const rawQty = Math.max(spec.minQty, notional / entryPrice);
    const formattedQty = formatByStep(rawQty, spec.stepSize, spec.quantityPrecision);
    const finalQtyNum = parseFloat(formattedQty);

    // 4. Place Market Entry Order on Binance Futures
    const orderParams = new URLSearchParams({
      symbol: cleanSymbol,
      side: entryOrderSide,
      type: 'MARKET',
      quantity: finalQtyNum > 0 ? formattedQty : String(spec.minQty),
      timestamp: String(Date.now()),
      recvWindow: '5000',
    });

    const orderRes = await fetch(`${baseUrl}/fapi/v1/order`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: signParams(orderParams, apiSecret),
    });

    if (!orderRes.ok) {
      const errData = await orderRes.json().catch(() => ({}));
      return NextResponse.json(
        {
          success: false,
          error: errData.msg || `Binance Order Execution Error HTTP ${orderRes.status}`,
        },
        { status: 400 }
      );
    }

    const orderData = await orderRes.json();

    // 5. Place Indicator-Driven Dynamic Stop-Loss (STOP_MARKET) and Take-Profit (TAKE_PROFIT_MARKET) on Binance
    let slOrderId: string | number | undefined;
    let tpOrderId: string | number | undefined;

    if (stopLoss && Number(stopLoss) > 0) {
      try {
        const formattedSl = formatByStep(Number(stopLoss), spec.tickSize, spec.pricePrecision);
        const slParams = new URLSearchParams({
          symbol: cleanSymbol,
          side: exitOrderSide,
          type: 'STOP_MARKET',
          stopPrice: formattedSl,
          closePosition: 'true',
          workingType: 'MARK_PRICE',
          timestamp: String(Date.now()),
          recvWindow: '5000',
        });
        const slRes = await fetch(`${baseUrl}/fapi/v1/order`, {
          method: 'POST',
          headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: signParams(slParams, apiSecret),
        });
        if (slRes.ok) {
          const slData = await slRes.json();
          slOrderId = slData.orderId;
        }
      } catch {
        // Fallback: frontend dynamic TP/SL monitor remains active
      }
    }

    if (takeProfit && Number(takeProfit) > 0) {
      try {
        const formattedTp = formatByStep(Number(takeProfit), spec.tickSize, spec.pricePrecision);
        const tpParams = new URLSearchParams({
          symbol: cleanSymbol,
          side: exitOrderSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: formattedTp,
          closePosition: 'true',
          workingType: 'MARK_PRICE',
          timestamp: String(Date.now()),
          recvWindow: '5000',
        });
        const tpRes = await fetch(`${baseUrl}/fapi/v1/order`, {
          method: 'POST',
          headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: signParams(tpParams, apiSecret),
        });
        if (tpRes.ok) {
          const tpData = await tpRes.json();
          tpOrderId = tpData.orderId;
        }
      } catch {
        // Fallback: frontend dynamic TP/SL monitor remains active
      }
    }

    const executedQty = parseFloat(orderData.executedQty || formattedQty) || finalQtyNum || spec.minQty;
    const avgFillPrice = parseFloat(orderData.avgPrice || '0') || entryPrice;

    return NextResponse.json({
      success: true,
      action: 'OPEN',
      orderId: orderData.orderId,
      symbol: orderData.symbol || cleanSymbol,
      side: entryOrderSide === 'BUY' ? 'LONG' : 'SHORT',
      orderSide: entryOrderSide,
      leverage: clampedLeverage,
      marginType: 'ISOLATED',
      status: orderData.status,
      executedQty,
      avgPrice: avgFillPrice,
      slOrderId,
      tpOrderId,
      clientOrderId: orderData.clientOrderId,
      timestamp: Date.now(),
    });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json(
      { success: false, error: error.message || 'Execution error' },
      { status: 500 }
    );
  }
}
