import { describe, expect, it } from "bun:test";
import { money } from "./decimal";
import {
  applyFillToPosition,
  calculateUnrealizedPnl,
  emptyPosition,
  positionSide,
  viewPosition,
} from "./position-engine";
import type { FillInput, MarketRiskConfig, Position } from "./types";

const m = money;

const market: MarketRiskConfig = {
  marketId: "BTC-PERP",
  tickSize: m("0.1"),
  lotSize: m("0.001"),
  maxLeverage: 20,
  initialMarginRate: m("0.05"),
  maintenanceMarginRate: m("0.005"),
  makerFeeRate: m("0.0002"),
  takerFeeRate: m("0.0005"),
};

describe("applyFillToPosition", () => {
  it("opens a long position", () => {
    const result = applyFillToPosition(undefined, fill("BUY", 100, 2), market);

    expect(result.next.quantity.toFixed()).toBe("2");
    expect(result.next.entryPrice.toFixed()).toBe("100");
    expect(result.next.realizedPnl.toFixed()).toBe("0");
    expect(result.openedQuantity.toFixed()).toBe("2");
    expect(positionSide(result.next)).toBe("LONG");
  });

  it("increases a long position with weighted average entry", () => {
    const first = applyFillToPosition(undefined, fill("BUY", 100, 2), market);
    const second = applyFillToPosition(first.next, fill("BUY", 110, 2), market);

    expect(second.next.quantity.toFixed()).toBe("4");
    expect(second.next.entryPrice.toFixed()).toBe("105");
    expect(second.next.realizedPnl.toFixed()).toBe("0");
  });

  it("reduces a long and realizes pnl", () => {
    const position: Position = {
      ...emptyPosition("user-1", "BTC-PERP", 10),
      quantity: m(4),
      entryPrice: m(100),
    };

    const result = applyFillToPosition(
      position,
      fill("SELL", 120, 1.5, 0.1),
      market,
    );

    expect(result.closedQuantity.toFixed()).toBe("1.5");
    expect(result.realizedPnlDelta.toFixed()).toBe("30");
    expect(result.feePaid.toFixed()).toBe("0.1");
    expect(result.next.quantity.toFixed()).toBe("2.5");
    expect(result.next.entryPrice.toFixed()).toBe("100");
    expect(result.next.realizedPnl.toFixed()).toBe("29.9");
  });

  it("closes a short position", () => {
    const position: Position = {
      ...emptyPosition("user-1", "BTC-PERP", 10),
      quantity: m(-3),
      entryPrice: m(100),
    };

    const result = applyFillToPosition(position, fill("BUY", 90, 3), market);

    expect(result.next.quantity.toFixed()).toBe("0");
    expect(result.next.entryPrice.toFixed()).toBe("0");
    expect(result.next.realizedPnl.toFixed()).toBe("30");
    expect(positionSide(result.next)).toBe("FLAT");
  });

  it("reverses from long to short", () => {
    const position: Position = {
      ...emptyPosition("user-1", "BTC-PERP", 10),
      quantity: m(2),
      entryPrice: m(100),
    };

    const result = applyFillToPosition(position, fill("SELL", 90, 5), market);

    expect(result.closedQuantity.toFixed()).toBe("2");
    expect(result.openedQuantity.toFixed()).toBe("3");
    expect(result.realizedPnlDelta.toFixed()).toBe("-20");
    expect(result.next.quantity.toFixed()).toBe("-3");
    expect(result.next.entryPrice.toFixed()).toBe("90");
    expect(result.next.realizedPnl.toFixed()).toBe("-20");
    expect(positionSide(result.next)).toBe("SHORT");
  });

  it("calculates unrealized pnl for longs and shorts", () => {
    expect(
      calculateUnrealizedPnl({ quantity: m(2), entryPrice: m(100) }, m(130)).toFixed(),
    ).toBe("60");
    expect(
      calculateUnrealizedPnl({ quantity: m(-2), entryPrice: m(100) }, m(80)).toFixed(),
    ).toBe("40");
  });

  it("builds a position view with notional and margin values", () => {
    const position: Position = {
      ...emptyPosition("user-1", "BTC-PERP", 10),
      quantity: m(2),
      entryPrice: m(100),
    };

    const view = viewPosition(position, market, m(120));

    expect(view.side).toBe("LONG");
    expect(view.notional.toFixed()).toBe("240");
    expect(view.unrealizedPnl.toFixed()).toBe("40");
    expect(view.initialMargin.toFixed()).toBe("24");
    expect(view.maintenanceMargin.toFixed()).toBe("1.2");
  });

  it("keeps the weighted average entry exact where floats drift", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point. The old path papered over it
    // by rounding to 12 places; here the intermediate value is simply never wrong, so there is
    // nothing to round and no dependence on the magnitudes staying small.
    const first = applyFillToPosition(undefined, fill("BUY", 100, 0.1), market);
    const second = applyFillToPosition(first.next, fill("BUY", 100, 0.2), market);

    expect(second.next.quantity.toFixed()).toBe("0.3");
    expect(second.next.entryPrice.toFixed()).toBe("100");
  });

  it("closes to exactly flat after many partial fills", () => {
    let position = applyFillToPosition(undefined, fill("BUY", 100, 1), market).next;

    for (let i = 0; i < 10; i += 1) {
      position = applyFillToPosition(position, fill("SELL", 100, 0.1), market).next;
    }

    expect(position.quantity.isZero()).toBe(true);
    expect(positionSide(position)).toBe("FLAT");
  });
});

function fill(
  side: "BUY" | "SELL",
  price: number,
  quantity: number,
  fee = 0,
): FillInput {
  return {
    userId: "user-1",
    marketId: "BTC-PERP",
    side,
    price: m(price),
    quantity: m(quantity),
    fee: m(fee),
  };
}
