import type { OrderBookLevel, OrderBookSnapshot } from "./orderbook-cache";

export interface MarketOrderRiskInput {
  side: "BUY" | "SELL";
  quantity: number;
  orderBook: OrderBookSnapshot;
  markPrice: number;
  slippageBufferRate?: number;
}

export interface MarketOrderRiskPrice {
  marginPrice: number;
  minExecutionPrice?: number;
  maxExecutionPrice?: number;
}

/**
 * Prices a market order from executable depth, then adds a conservative mark-price
 * buffer for margin reservation and matching-engine price protection.
 */
export function estimateMarketOrderRiskPrice(
  input: MarketOrderRiskInput,
): MarketOrderRiskPrice {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new Error("invalid market order quantity");
  }
  if (!Number.isFinite(input.markPrice) || input.markPrice <= 0) {
    throw new Error("market order risk price unavailable");
  }

  const buffer = input.slippageBufferRate ?? 0.05;
  if (!Number.isFinite(buffer) || buffer < 0) {
    throw new Error("invalid market order slippage buffer");
  }

  const levels = executableLevels(input.side, input.orderBook);
  const worstExecutionPrice = priceForFullQuantity(levels, input.quantity);

  if (input.side === "BUY") {
    const maxExecutionPrice = Math.max(
      worstExecutionPrice,
      input.markPrice * (1 + buffer),
    );
    return { marginPrice: maxExecutionPrice, maxExecutionPrice };
  }

  return {
    // Margin is reserved against the highest plausible notional, while the
    // execution guard prevents selling materially below the observed depth.
    marginPrice: Math.max(worstExecutionPrice, input.markPrice * (1 + buffer)),
    minExecutionPrice: Math.min(
      worstExecutionPrice,
      input.markPrice * (1 - buffer),
    ),
  };
}

function executableLevels(
  side: "BUY" | "SELL",
  orderBook: OrderBookSnapshot,
): OrderBookLevel[] {
  const levels = side === "BUY" ? orderBook.asks : orderBook.bids;
  return [...levels].sort((left, right) =>
    side === "BUY"
      ? left.priceTicks - right.priceTicks
      : right.priceTicks - left.priceTicks,
  );
}

function priceForFullQuantity(
  levels: OrderBookLevel[],
  quantity: number,
): number {
  let remaining = quantity;

  for (const level of levels) {
    if (
      !Number.isFinite(level.priceTicks) ||
      level.priceTicks <= 0 ||
      !Number.isFinite(level.totalQtyLots) ||
      level.totalQtyLots <= 0
    ) {
      continue;
    }

    remaining -= level.totalQtyLots;
    if (remaining <= 0) {
      return level.priceTicks;
    }
  }

  throw new Error("market order insufficient visible liquidity");
}
