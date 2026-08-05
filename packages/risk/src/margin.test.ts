import { describe, expect, it } from "bun:test";
import { money } from "./decimal";
import {
  calculateMarginSummary,
  checkOrderMargin,
  isMaintenanceMarginViolated,
} from "./margin";
import type {
  AccountState,
  MarketRiskConfig,
  OpenOrderRisk,
  Position,
} from "./types";

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

describe("cross-margin summary", () => {
  it("calculates account equity, position margin, open-order margin, and fees", () => {
    const summary = calculateMarginSummary(
      account({
        walletBalance: 1_000,
        positions: [position({ quantity: 2, entryPrice: 100, leverage: 10 })],
        openOrders: [order({ price: 110, quantity: 1, leverage: 10 })],
      }),
      [market],
      [{ marketId: market.marketId, price: m(120) }],
    );

    expect(summary.walletBalance.toFixed()).toBe("1000");
    expect(summary.unrealizedPnl.toFixed()).toBe("40");
    expect(summary.accountEquity.toFixed()).toBe("1040");
    expect(summary.initialMargin.toFixed()).toBe("24");
    expect(summary.maintenanceMargin.toFixed()).toBe("1.2");
    expect(summary.openOrderInitialMargin.toFixed()).toBe("11");
    expect(summary.openOrderFees.toFixed()).toBe("0.055");
    expect(summary.availableMargin.toFixed()).toBe("1004.945");
    expect(summary.marginRatio?.toFixed(9)).toBe("866.666666667");
  });

  it("passes a sufficient-margin order check", () => {
    const check = checkOrderMargin(
      account({ walletBalance: 1_000 }),
      order({ price: 100, quantity: 5, leverage: 10 }),
      [market],
      [{ marketId: market.marketId, price: m(100) }],
    );

    expect(check.ok).toBe(true);
    expect(check.reason).toBeUndefined();
    expect(check.requiredInitialMargin.toFixed()).toBe("50");
    expect(check.requiredFee.toFixed()).toBe("0.25");
    expect(check.availableMargin.toFixed()).toBe("1000");
  });

  it("rejects an insufficient-margin order check", () => {
    const check = checkOrderMargin(
      account({ walletBalance: 10 }),
      order({ price: 100, quantity: 5, leverage: 10 }),
      [market],
      [{ marketId: market.marketId, price: m(100) }],
    );

    expect(check.ok).toBe(false);
    expect(check.reason).toBe("INSUFFICIENT_MARGIN");
    expect(check.requiredInitialMargin.toFixed()).toBe("50");
    expect(check.requiredFee.toFixed()).toBe("0.25");
    expect(check.availableMargin.toFixed()).toBe("10");
  });

  it("does not reserve new margin for reduce-only orders", () => {
    const check = checkOrderMargin(
      account({ walletBalance: 0 }),
      order({ price: 100, quantity: 100, leverage: 10, reduceOnly: true }),
      [market],
      [{ marketId: market.marketId, price: m(100) }],
    );

    expect(check.ok).toBe(true);
    expect(check.reason).toBeUndefined();
    expect(check.requiredInitialMargin.isZero()).toBe(true);
    expect(check.requiredFee.isZero()).toBe(true);
    expect(check.availableMargin.isZero()).toBe(true);
  });

  it("rejects leverage above the market maximum", () => {
    const check = checkOrderMargin(
      account({ walletBalance: 1_000 }),
      order({ price: 100, quantity: 1, leverage: 100 }),
      [market],
      [{ marketId: market.marketId, price: m(100) }],
    );

    expect(check.ok).toBe(false);
    expect(check.reason).toBe("INVALID_LEVERAGE");
    expect(check.availableMargin.toFixed()).toBe("1000");
  });

  it("detects maintenance margin violation for later liquidation handling", () => {
    const violated = isMaintenanceMarginViolated(
      account({
        walletBalance: 5,
        positions: [position({ quantity: 1, entryPrice: 100, leverage: 10 })],
      }),
      [market],
      [{ marketId: market.marketId, price: m(94) }],
    );

    expect(violated).toBe(true);
  });

  it("reserves margin exactly for a quantity floats cannot represent", () => {
    // 0.1 * 59.91 / 3 has no exact float representation; the old path reserved a value that
    // was merely close, and `String()` of it could not even round-trip to the column.
    const check = checkOrderMargin(
      account({ walletBalance: 1_000 }),
      order({ price: 59.91, quantity: 0.1, leverage: 3 }),
      [market],
      [{ marketId: market.marketId, price: m("59.91") }],
    );

    expect(check.requiredInitialMargin.toFixed(18)).toBe("1.997000000000000000");
    expect(check.requiredFee.toFixed(18)).toBe("0.002995500000000000");
  });
});

function account(
  overrides: {
    walletBalance?: number;
    positions?: Position[];
    openOrders?: OpenOrderRisk[];
  } = {},
): AccountState {
  return {
    userId: "user-1",
    collateralAsset: "USDC",
    walletBalance: m(overrides.walletBalance ?? 1_000),
    positions: overrides.positions ?? [],
    openOrders: overrides.openOrders ?? [],
  };
}

function position(
  overrides: {
    quantity?: number;
    entryPrice?: number;
    realizedPnl?: number;
    leverage?: number;
  } = {},
): Position {
  return {
    userId: "user-1",
    marketId: market.marketId,
    quantity: m(overrides.quantity ?? 0),
    entryPrice: m(overrides.entryPrice ?? 0),
    realizedPnl: m(overrides.realizedPnl ?? 0),
    leverage: overrides.leverage ?? 10,
  };
}

function order(
  overrides: {
    side?: "BUY" | "SELL";
    price?: number;
    quantity?: number;
    reduceOnly?: boolean;
    leverage?: number;
  } = {},
): OpenOrderRisk {
  return {
    marketId: market.marketId,
    side: overrides.side ?? "BUY",
    price: m(overrides.price ?? 100),
    quantity: m(overrides.quantity ?? 1),
    reduceOnly: overrides.reduceOnly ?? false,
    estimatedFeeRate: market.takerFeeRate,
    leverage: overrides.leverage ?? 10,
  };
}
