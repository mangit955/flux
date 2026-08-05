import { ZERO, type Money } from "./decimal";
import { calculateUnrealizedPnl, positionNotional } from "./position-engine";
import type {
  AccountState,
  MarkPrice,
  MarginSummary,
  MarketRiskConfig,
  OpenOrderRisk,
  OrderMarginCheck,
} from "./types";

export function calculateMarginSummary(
  account: AccountState,
  markets: MarketRiskConfig[],
  markPrices: MarkPrice[],
): MarginSummary {
  const marketById = indexMarkets(markets);
  const markPriceByMarket = indexMarkPrices(markPrices);

  let unrealizedPnl = ZERO;
  let initialMargin = ZERO;
  let maintenanceMargin = ZERO;

  for (const position of account.positions) {
    if (position.quantity.isZero()) {
      continue;
    }

    const market = requireMarket(marketById, position.marketId);
    const markPrice = requireMarkPrice(markPriceByMarket, position.marketId);
    const notional = positionNotional(position, markPrice);

    unrealizedPnl = unrealizedPnl.add(calculateUnrealizedPnl(position, markPrice));
    initialMargin = initialMargin.add(notional.div(position.leverage));
    maintenanceMargin = maintenanceMargin.add(
      notional.mul(market.maintenanceMarginRate),
    );
  }

  const openOrderInitialMargin = account.openOrders.reduce(
    (sum, order) => sum.add(initialMarginForOpenOrder(order, marketById)),
    ZERO,
  );
  const openOrderFees = account.openOrders.reduce(
    (sum, order) => sum.add(estimatedFeeForOpenOrder(order)),
    ZERO,
  );
  const accountEquity = account.walletBalance.add(unrealizedPnl);
  const availableMargin = accountEquity
    .sub(initialMargin)
    .sub(openOrderInitialMargin)
    .sub(openOrderFees);

  return {
    userId: account.userId,
    collateralAsset: account.collateralAsset,
    walletBalance: account.walletBalance,
    unrealizedPnl,
    accountEquity,
    initialMargin,
    maintenanceMargin,
    openOrderInitialMargin,
    openOrderFees,
    availableMargin,
    marginRatio: maintenanceMargin.isZero()
      ? null
      : accountEquity.div(maintenanceMargin),
  };
}

export function checkOrderMargin(
  account: AccountState,
  order: OpenOrderRisk,
  markets: MarketRiskConfig[],
  markPrices: MarkPrice[],
): OrderMarginCheck {
  const market = markets.find((candidate) => candidate.marketId === order.marketId);

  if (!market) {
    return {
      ok: false,
      requiredInitialMargin: ZERO,
      requiredFee: ZERO,
      availableMargin: ZERO,
      reason: "UNKNOWN_MARKET",
    };
  }

  if (
    !Number.isInteger(order.leverage) ||
    order.leverage < 1 ||
    order.leverage > market.maxLeverage
  ) {
    return {
      ok: false,
      requiredInitialMargin: ZERO,
      requiredFee: ZERO,
      availableMargin: calculateMarginSummary(account, markets, markPrices)
        .availableMargin,
      reason: "INVALID_LEVERAGE",
    };
  }

  const summary = calculateMarginSummary(account, markets, markPrices);
  const requiredInitialMargin = initialMarginForOpenOrder(order, new Map([[market.marketId, market]]));
  const requiredFee = estimatedFeeForOpenOrder(order);
  const required = requiredInitialMargin.add(requiredFee);
  const ok = order.reduceOnly || summary.availableMargin.gte(required);

  return {
    ok,
    requiredInitialMargin,
    requiredFee,
    availableMargin: summary.availableMargin,
    reason: ok ? undefined : "INSUFFICIENT_MARGIN",
  };
}

export function isMaintenanceMarginViolated(
  account: AccountState,
  markets: MarketRiskConfig[],
  markPrices: MarkPrice[],
): boolean {
  const summary = calculateMarginSummary(account, markets, markPrices);

  return (
    summary.maintenanceMargin.gt(ZERO) &&
    summary.accountEquity.lte(summary.maintenanceMargin)
  );
}

function initialMarginForOpenOrder(
  order: OpenOrderRisk,
  marketById: Map<string, MarketRiskConfig>,
): Money {
  if (order.reduceOnly) {
    return ZERO;
  }

  const market = requireMarket(marketById, order.marketId);
  const leverage = Math.min(order.leverage, market.maxLeverage);

  return order.price.mul(order.quantity).div(leverage);
}

function estimatedFeeForOpenOrder(order: OpenOrderRisk): Money {
  if (order.reduceOnly) {
    return ZERO;
  }

  return order.price.mul(order.quantity).mul(order.estimatedFeeRate);
}

function requireMarket(
  marketById: Map<string, MarketRiskConfig>,
  marketId: string,
): MarketRiskConfig {
  const market = marketById.get(marketId);

  if (!market) {
    throw new Error(`Unknown market: ${marketId}`);
  }

  return market;
}

function requireMarkPrice(
  markPriceByMarket: Map<string, Money>,
  marketId: string,
): Money {
  const price = markPriceByMarket.get(marketId);

  if (price == null) {
    throw new Error(`Missing mark price for market: ${marketId}`);
  }

  return price;
}

function indexMarkets(markets: MarketRiskConfig[]): Map<string, MarketRiskConfig> {
  return new Map(markets.map((market) => [market.marketId, market]));
}

function indexMarkPrices(markPrices: MarkPrice[]): Map<string, Money> {
  return new Map(markPrices.map((markPrice) => [markPrice.marketId, markPrice.price]));
}
