import { describe, expect, it } from "bun:test";
import { ZERO, money } from "./decimal";
import {
  applyFundingPayments,
  calculateFundingRate,
  calculatePremiumIndex,
  createFundingExecution,
  nextFundingTime,
  shouldExecuteFunding,
} from "./funding";
import type { Balance, FundingMarketConfig, Position } from "./types";

const m = money;

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const FUNDING_TIME = 1_700_000_000_000;

const market: FundingMarketConfig = {
  marketId: "BTC-PERP",
  fundingIntervalHours: 8,
  fundingRateCap: m("0.00375"),
};

describe("funding calculations", () => {
  it("calculates premium index from mark and index prices", () => {
    expect(calculatePremiumIndex(m(101), m(100)).toFixed()).toBe("0.01");
    expect(calculatePremiumIndex(m(99), m(100)).toFixed()).toBe("-0.01");
  });

  it("caps funding rate in both directions", () => {
    expect(calculateFundingRate(m("0.01"), market.fundingRateCap).toFixed()).toBe(
      "0.00375",
    );
    expect(
      calculateFundingRate(m("-0.01"), market.fundingRateCap).toFixed(),
    ).toBe("-0.00375");
    expect(
      calculateFundingRate(m("0.001"), market.fundingRateCap).toFixed(),
    ).toBe("0.001");
  });

  it("runs when the funding interval is due", () => {
    expect(shouldExecuteFunding(FUNDING_TIME, null, 8)).toBe(true);
    expect(
      shouldExecuteFunding(FUNDING_TIME, FUNDING_TIME - EIGHT_HOURS_MS, 8),
    ).toBe(true);
    expect(
      shouldExecuteFunding(FUNDING_TIME, FUNDING_TIME - EIGHT_HOURS_MS + 1, 8),
    ).toBe(false);
    expect(nextFundingTime(FUNDING_TIME, 8)).toBe(
      FUNDING_TIME + EIGHT_HOURS_MS,
    );
  });
});

describe("funding execution", () => {
  it("creates positive funding payments where longs pay shorts", () => {
    const execution = createFundingExecution({
      market,
      eventId: "funding-1",
      price: {
        marketId: market.marketId,
        markPrice: m(101),
        indexPrice: m(100),
        timestamp: FUNDING_TIME,
      },
      positions: [
        position({ userId: "long", quantity: 2 }),
        position({ userId: "short", quantity: -2 }),
        position({ userId: "flat", quantity: 0 }),
      ],
    });

    expect(execution.eventId).toBe("funding-1");
    expect(execution.marketId).toBe("BTC-PERP");
    expect(execution.markPrice.toFixed()).toBe("101");
    expect(execution.indexPrice.toFixed()).toBe("100");
    expect(execution.premiumIndex.toFixed()).toBe("0.01");
    expect(execution.fundingRate.toFixed()).toBe("0.00375");
    expect(execution.fundingTime).toBe(FUNDING_TIME);

    expect(execution.payments).toHaveLength(2);
    expect(execution.payments[0]?.id).toBe("funding-1:long:BTC-PERP");
    expect(execution.payments[0]?.userId).toBe("long");
    expect(execution.payments[0]?.positionQuantity.toFixed()).toBe("2");
    expect(execution.payments[0]?.paymentAmount.toFixed()).toBe("-0.7575");
    expect(execution.payments[1]?.id).toBe("funding-1:short:BTC-PERP");
    expect(execution.payments[1]?.positionQuantity.toFixed()).toBe("-2");
    expect(execution.payments[1]?.paymentAmount.toFixed()).toBe("0.7575");

    // Funding is a transfer: the two sides must sum to exactly zero, not merely close to it.
    const net = execution.payments.reduce(
      (sum, payment) => sum.add(payment.paymentAmount),
      ZERO,
    );
    expect(net.isZero()).toBe(true);
  });

  it("creates negative funding payments where shorts pay longs", () => {
    const execution = createFundingExecution({
      market,
      eventId: "funding-2",
      price: {
        marketId: market.marketId,
        markPrice: m(99),
        indexPrice: m(100),
        timestamp: FUNDING_TIME,
      },
      positions: [
        position({ userId: "long", quantity: 1 }),
        position({ userId: "short", quantity: -1 }),
      ],
    });

    expect(execution.fundingRate.toFixed()).toBe("-0.00375");
    expect(execution.payments[0]?.userId).toBe("long");
    expect(execution.payments[0]?.paymentAmount.toFixed()).toBe("0.37125");
    expect(execution.payments[1]?.userId).toBe("short");
    expect(execution.payments[1]?.paymentAmount.toFixed()).toBe("-0.37125");
  });

  it("applies funding payments to collateral balances with ledger entries", () => {
    const execution = createFundingExecution({
      market,
      eventId: "funding-3",
      price: {
        marketId: market.marketId,
        markPrice: m(101),
        indexPrice: m(100),
        timestamp: FUNDING_TIME,
      },
      positions: [
        position({ userId: "long", quantity: 2 }),
        position({ userId: "short", quantity: -2 }),
      ],
    });

    const result = applyFundingPayments({
      collateralAsset: "USDC",
      balances: [
        balance({ userId: "long", total: 100 }),
        balance({ userId: "short", total: 100 }),
      ],
      payments: execution.payments,
      createdAt: FUNDING_TIME,
    });

    expect(result.balances[0]?.userId).toBe("long");
    expect(result.balances[0]?.total.toFixed()).toBe("99.2425");
    expect(result.balances[1]?.userId).toBe("short");
    expect(result.balances[1]?.total.toFixed()).toBe("100.7575");

    expect(result.ledgerEntries[0]?.id).toBe("funding-3:long:BTC-PERP:ledger");
    expect(result.ledgerEntries[0]?.type).toBe("FUNDING_PAYMENT");
    expect(result.ledgerEntries[0]?.amount.toFixed()).toBe("-0.7575");
    expect(result.ledgerEntries[0]?.balanceAfter.toFixed()).toBe("99.2425");
    expect(result.ledgerEntries[1]?.id).toBe("funding-3:short:BTC-PERP:ledger");
    expect(result.ledgerEntries[1]?.amount.toFixed()).toBe("0.7575");
    expect(result.ledgerEntries[1]?.balanceAfter.toFixed()).toBe("100.7575");
  });
});

function position(overrides: {
  userId?: string;
  marketId?: string;
  quantity?: number;
  entryPrice?: number;
  realizedPnl?: number;
  leverage?: number;
}): Position {
  return {
    userId: overrides.userId ?? "user-1",
    marketId: overrides.marketId ?? market.marketId,
    quantity: m(overrides.quantity ?? 0),
    entryPrice: m(overrides.entryPrice ?? 100),
    realizedPnl: m(overrides.realizedPnl ?? 0),
    leverage: overrides.leverage ?? 10,
  };
}

function balance(overrides: {
  userId?: string;
  asset?: string;
  total?: number;
  locked?: number;
}): Balance {
  return {
    userId: overrides.userId ?? "user-1",
    asset: overrides.asset ?? "USDC",
    total: m(overrides.total ?? 0),
    locked: m(overrides.locked ?? 0),
  };
}
