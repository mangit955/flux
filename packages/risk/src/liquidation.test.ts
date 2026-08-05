import { describe, expect, it } from "bun:test";
import { money } from "./decimal";
import {
  calculateAdlScore,
  createAdlActions,
  createLiquidationOrder,
  createLiquidationTriggers,
  settleLiquidationDeficit,
  useInsuranceFund,
} from "./liquidation";
import type {
  AccountState,
  AdlCandidate,
  InsuranceFund,
  MarketRiskConfig,
  Position,
} from "./types";

const m = money;

const CREATED_AT = 1_700_000_000_000;

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

describe("liquidation triggers", () => {
  it("creates reduce-only liquidation orders when maintenance margin is breached", () => {
    const triggers = createLiquidationTriggers({
      eventId: "liq-1",
      account: account({
        walletBalance: 5,
        positions: [position({ quantity: 1, entryPrice: 100, leverage: 10 })],
      }),
      markets: [market],
      markPrices: [{ marketId: market.marketId, price: m(94) }],
      createdAt: CREATED_AT,
      slippageBufferRate: m("0.01"),
    });

    expect(triggers).toHaveLength(1);

    const trigger = triggers[0];
    expect(trigger?.eventId).toBe("liq-1:BTC-PERP");
    expect(trigger?.userId).toBe("user-1");
    expect(trigger?.marketId).toBe("BTC-PERP");
    expect(trigger?.positionQuantity.toFixed()).toBe("1");
    expect(trigger?.markPrice.toFixed()).toBe("94");
    expect(trigger?.maintenanceMargin.toFixed()).toBe("0.47");
    expect(trigger?.accountEquity.toFixed()).toBe("-1");
    expect(trigger?.status).toBe("TRIGGERED");
    expect(trigger?.createdAt).toBe(CREATED_AT);
    expect(trigger?.order.orderId).toBe("liq-1:BTC-PERP:liquidation-order");
    expect(trigger?.order.side).toBe("SELL");
    expect(trigger?.order.quantity.toFixed()).toBe("1");
    expect(trigger?.order.limitPrice.toFixed()).toBe("93.06");
    expect(trigger?.order.reduceOnly).toBe(true);
  });

  it("does not trigger liquidation when equity is above maintenance margin", () => {
    const triggers = createLiquidationTriggers({
      eventId: "liq-1",
      account: account({
        walletBalance: 100,
        positions: [position({ quantity: 1, entryPrice: 100, leverage: 10 })],
      }),
      markets: [market],
      markPrices: [{ marketId: market.marketId, price: m(94) }],
      createdAt: CREATED_AT,
    });

    expect(triggers).toEqual([]);
  });

  it("uses buy orders to liquidate short positions", () => {
    const order = createLiquidationOrder({
      eventId: "liq-1",
      userId: "user-1",
      position: position({ quantity: -2, entryPrice: 100 }),
      markPrice: m(110),
      slippageBufferRate: m("0.01"),
    });

    expect(order.orderId).toBe("liq-1:BTC-PERP:liquidation-order");
    expect(order.userId).toBe("user-1");
    expect(order.marketId).toBe("BTC-PERP");
    expect(order.side).toBe("BUY");
    expect(order.quantity.toFixed()).toBe("2");
    expect(order.limitPrice.toFixed()).toBe("111.1");
    expect(order.reduceOnly).toBe(true);
  });
});

describe("insurance fund and ADL", () => {
  it("covers a deficit fully with the insurance fund", () => {
    const usage = useInsuranceFund(fund({ balance: 100 }), m(40));

    expect(usage.asset).toBe("USDC");
    expect(usage.requested.toFixed()).toBe("40");
    expect(usage.used.toFixed()).toBe("40");
    expect(usage.remainingDeficit.toFixed()).toBe("0");
    expect(usage.nextFundBalance.toFixed()).toBe("60");
  });

  it("uses ADL after the insurance fund is exhausted", () => {
    const settlement = settleLiquidationDeficit({
      asset: "USDC",
      deficit: m(150),
      insuranceFund: fund({ balance: 50 }),
      liquidatedPosition: position({
        userId: "liquidated",
        quantity: 2,
        entryPrice: 100,
      }),
      markPrice: m(100),
      adlCandidates: [
        adlCandidate({
          userId: "lower-score",
          quantity: -2,
          entryPrice: 120,
          accountEquity: 1_000,
          markPrice: 100,
        }),
        adlCandidate({
          userId: "higher-score",
          quantity: -2,
          entryPrice: 150,
          accountEquity: 100,
          markPrice: 100,
        }),
      ],
    });

    expect(settlement.insuranceFund.used.toFixed()).toBe("50");
    expect(settlement.insuranceFund.remainingDeficit.toFixed()).toBe("100");
    expect(settlement.insuranceFund.nextFundBalance.toFixed()).toBe("0");
    expect(settlement.status).toBe("ADL_USED");
    expect(settlement.unresolvedDeficit.isZero()).toBe(true);

    expect(settlement.adlActions).toHaveLength(1);
    const action = settlement.adlActions[0];
    expect(action?.userId).toBe("higher-score");
    expect(action?.marketId).toBe("BTC-PERP");
    expect(action?.side).toBe("BUY");
    expect(action?.quantity.toFixed()).toBe("1");
    expect(action?.price.toFixed()).toBe("100");
    expect(action?.score.toFixed(12)).toBe("0.666666666667");
  });

  it("reports unresolved deficit when ADL liquidity is insufficient", () => {
    const settlement = settleLiquidationDeficit({
      asset: "USDC",
      deficit: m(300),
      insuranceFund: fund({ balance: 0 }),
      liquidatedPosition: position({
        userId: "liquidated",
        quantity: 5,
        entryPrice: 100,
      }),
      markPrice: m(100),
      adlCandidates: [
        adlCandidate({
          userId: "short-1",
          quantity: -1,
          entryPrice: 150,
          accountEquity: 100,
          markPrice: 100,
        }),
      ],
    });

    expect(settlement.status).toBe("FAILED");
    expect(settlement.adlActions).toHaveLength(1);
    expect(settlement.unresolvedDeficit.toFixed()).toBe("200");
  });

  it("ranks ADL candidates by profitability and effective leverage", () => {
    const low = adlCandidate({
      userId: "low",
      quantity: -1,
      entryPrice: 120,
      accountEquity: 1_000,
      markPrice: 100,
    });
    const high = adlCandidate({
      userId: "high",
      quantity: -1,
      entryPrice: 150,
      accountEquity: 100,
      markPrice: 100,
    });

    expect(calculateAdlScore(high).gt(calculateAdlScore(low))).toBe(true);

    const actions = createAdlActions({
      liquidatedPosition: position({ quantity: 2, entryPrice: 100 }),
      markPrice: m(100),
      quantityToReduce: m("1.5"),
      candidates: [low, high],
    });

    expect(actions.map((action) => action.userId)).toEqual(["high", "low"]);
    expect(actions.map((action) => action.quantity.toFixed())).toEqual([
      "1",
      "0.5",
    ]);
  });
});

function account(overrides: {
  userId?: string;
  collateralAsset?: string;
  walletBalance?: number;
  positions?: Position[];
}): AccountState {
  return {
    userId: overrides.userId ?? "user-1",
    collateralAsset: overrides.collateralAsset ?? "USDC",
    walletBalance: m(overrides.walletBalance ?? 0),
    positions: overrides.positions ?? [],
    openOrders: [],
  };
}

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

function fund(overrides: { asset?: string; balance?: number }): InsuranceFund {
  return {
    asset: overrides.asset ?? "USDC",
    balance: m(overrides.balance ?? 0),
  };
}

function adlCandidate(input: {
  userId: string;
  quantity: number;
  entryPrice: number;
  accountEquity: number;
  markPrice: number;
}): AdlCandidate {
  return {
    userId: input.userId,
    position: position({
      userId: input.userId,
      quantity: input.quantity,
      entryPrice: input.entryPrice,
    }),
    accountEquity: m(input.accountEquity),
    markPrice: m(input.markPrice),
  };
}
