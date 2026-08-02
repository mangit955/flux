import { describe, expect, it } from "bun:test";
import { estimateMarketOrderRiskPrice } from "./market-order-risk";

describe("estimateMarketOrderRiskPrice", () => {
  const orderBook = {
    market: "BTC-PERP",
    sequence: 1,
    bids: [
      { priceTicks: 99, totalQtyLots: 1 },
      { priceTicks: 98, totalQtyLots: 2 },
    ],
    asks: [
      { priceTicks: 101, totalQtyLots: 1 },
      { priceTicks: 102, totalQtyLots: 2 },
    ],
  };

  it("reserves a buy market order at the worse of visible depth and buffered mark", () => {
    expect(estimateMarketOrderRiskPrice({
      side: "BUY",
      quantity: 2,
      orderBook,
      markPrice: 100,
    })).toEqual({ marginPrice: 105, maxExecutionPrice: 105 });
  });

  it("rejects a market order that exceeds visible liquidity", () => {
    expect(() => estimateMarketOrderRiskPrice({
      side: "SELL",
      quantity: 4,
      orderBook,
      markPrice: 100,
    })).toThrow("market order insufficient visible liquidity");
  });
});
