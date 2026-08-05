import { Decimal, ZERO, money, type Money } from "./decimal";
import { calculateMarginSummary } from "./margin";
import { calculateUnrealizedPnl, positionNotional } from "./position-engine";
import type {
  AccountState,
  AdlAction,
  AdlCandidate,
  DeficitSettlement,
  InsuranceFund,
  InsuranceFundUsage,
  LiquidationOrder,
  LiquidationTrigger,
  MarkPrice,
  MarketRiskConfig,
  Position,
  TradeSide,
} from "./types";

export interface CreateLiquidationTriggerInput {
  eventId: string;
  account: AccountState;
  markets: MarketRiskConfig[];
  markPrices: MarkPrice[];
  createdAt: number;
  slippageBufferRate?: Money;
}

export interface SettleDeficitInput {
  asset: string;
  deficit: Money;
  insuranceFund: InsuranceFund;
  liquidatedPosition: Position;
  markPrice: Money;
  adlCandidates: AdlCandidate[];
}

export function createLiquidationTriggers(
  input: CreateLiquidationTriggerInput,
): LiquidationTrigger[] {
  const summary = calculateMarginSummary(
    input.account,
    input.markets,
    input.markPrices,
  );

  if (
    summary.maintenanceMargin.isZero() ||
    summary.accountEquity.gt(summary.maintenanceMargin)
  ) {
    return [];
  }

  const triggers: LiquidationTrigger[] = [];

  for (const position of input.account.positions) {
    if (position.quantity.isZero()) {
      continue;
    }

    const market = requireMarket(input.markets, position.marketId);
    const markPrice = requireMarkPrice(input.markPrices, position.marketId);
    const notional = positionNotional(position, markPrice);
    const maintenanceMargin = notional.mul(market.maintenanceMarginRate);

    triggers.push({
      eventId: `${input.eventId}:${position.marketId}`,
      userId: input.account.userId,
      marketId: position.marketId,
      positionQuantity: position.quantity,
      markPrice,
      maintenanceMargin,
      accountEquity: summary.accountEquity,
      status: "TRIGGERED",
      order: createLiquidationOrder({
        eventId: input.eventId,
        userId: input.account.userId,
        position,
        markPrice,
        slippageBufferRate: input.slippageBufferRate ?? money("0.005"),
      }),
      createdAt: input.createdAt,
    });
  }

  return triggers;
}

export function createLiquidationOrder(input: {
  eventId: string;
  userId: string;
  position: Position;
  markPrice: Money;
  slippageBufferRate: Money;
}): LiquidationOrder {
  if (input.position.quantity.isZero()) {
    throw new Error("cannot liquidate a flat position");
  }

  const side: TradeSide = input.position.quantity.gt(ZERO) ? "SELL" : "BUY";
  const priceMultiplier =
    side === "SELL"
      ? money(1).sub(input.slippageBufferRate)
      : money(1).add(input.slippageBufferRate);

  return {
    orderId: `${input.eventId}:${input.position.marketId}:liquidation-order`,
    userId: input.userId,
    marketId: input.position.marketId,
    side,
    quantity: input.position.quantity.abs(),
    limitPrice: input.markPrice.mul(priceMultiplier),
    reduceOnly: true,
  };
}

export function useInsuranceFund(
  fund: InsuranceFund,
  requestedDeficit: Money,
): InsuranceFundUsage {
  assertNonNegative(requestedDeficit, "requested deficit");

  const used = Decimal.min(fund.balance, requestedDeficit);

  return {
    asset: fund.asset,
    requested: requestedDeficit,
    used,
    remainingDeficit: requestedDeficit.sub(used),
    nextFundBalance: fund.balance.sub(used),
  };
}

export function settleLiquidationDeficit(
  input: SettleDeficitInput,
): DeficitSettlement {
  if (input.asset !== input.insuranceFund.asset) {
    throw new Error(
      `insurance fund asset ${input.insuranceFund.asset} does not match ${input.asset}`,
    );
  }

  const insuranceFund = useInsuranceFund(input.insuranceFund, input.deficit);

  if (insuranceFund.remainingDeficit.isZero()) {
    return {
      insuranceFund,
      adlActions: [],
      unresolvedDeficit: ZERO,
      status: "INSURANCE_FUND_USED",
    };
  }

  const adlQuantity = insuranceFund.remainingDeficit.div(input.markPrice);
  const adlActions = createAdlActions({
    liquidatedPosition: input.liquidatedPosition,
    markPrice: input.markPrice,
    quantityToReduce: adlQuantity,
    candidates: input.adlCandidates,
  });
  const coveredByAdl = adlActions.reduce(
    (sum, action) => sum.add(action.quantity.mul(action.price)),
    ZERO,
  );
  const unresolvedDeficit = Decimal.max(
    ZERO,
    insuranceFund.remainingDeficit.sub(coveredByAdl),
  );

  return {
    insuranceFund,
    adlActions,
    unresolvedDeficit,
    status: unresolvedDeficit.isZero() ? "ADL_USED" : "FAILED",
  };
}

export function createAdlActions(input: {
  liquidatedPosition: Position;
  markPrice: Money;
  quantityToReduce: Money;
  candidates: AdlCandidate[];
}): AdlAction[] {
  assertNonNegative(input.quantityToReduce, "ADL quantity");

  if (
    input.liquidatedPosition.quantity.isZero() ||
    input.quantityToReduce.isZero()
  ) {
    return [];
  }

  const requiredOppositeSign = -input.liquidatedPosition.quantity.s;
  const rankedCandidates = input.candidates
    .filter(
      (candidate) =>
        candidate.position.marketId === input.liquidatedPosition.marketId &&
        !candidate.position.quantity.isZero() &&
        candidate.position.quantity.s === requiredOppositeSign,
    )
    .map((candidate) => ({
      candidate,
      score: calculateAdlScore(candidate),
    }))
    .sort((a, b) => b.score.cmp(a.score));

  const actions: AdlAction[] = [];
  let remainingQuantity = input.quantityToReduce;

  for (const ranked of rankedCandidates) {
    if (remainingQuantity.lte(ZERO)) {
      break;
    }

    const reducibleQuantity = Decimal.min(
      ranked.candidate.position.quantity.abs(),
      remainingQuantity,
    );

    if (reducibleQuantity.lte(ZERO)) {
      continue;
    }

    actions.push({
      userId: ranked.candidate.userId,
      marketId: ranked.candidate.position.marketId,
      side: ranked.candidate.position.quantity.gt(ZERO) ? "SELL" : "BUY",
      quantity: reducibleQuantity,
      price: input.markPrice,
      score: ranked.score,
    });

    remainingQuantity = remainingQuantity.sub(reducibleQuantity);
  }

  return actions;
}

export function calculateAdlScore(candidate: AdlCandidate): Money {
  const notional = positionNotional(candidate.position, candidate.markPrice);

  if (notional.isZero()) {
    return ZERO;
  }

  const unrealizedPnl = calculateUnrealizedPnl(
    candidate.position,
    candidate.markPrice,
  );
  const costBasis = candidate.position.entryPrice
    .mul(candidate.position.quantity)
    .abs();

  if (costBasis.isZero()) {
    return ZERO;
  }

  const pnlPercent = unrealizedPnl.div(costBasis);
  // Floor the divisor so a wiped-out account does not divide by zero.
  const equityFloor = Decimal.max(candidate.accountEquity, money("1e-9"));
  const effectiveLeverage = notional.div(equityFloor);

  return pnlPercent.mul(effectiveLeverage);
}

function requireMarket(
  markets: MarketRiskConfig[],
  marketId: string,
): MarketRiskConfig {
  const market = markets.find((candidate) => candidate.marketId === marketId);

  if (!market) {
    throw new Error(`Unknown market: ${marketId}`);
  }

  return market;
}

function requireMarkPrice(markPrices: MarkPrice[], marketId: string): Money {
  const markPrice = markPrices.find(
    (candidate) => candidate.marketId === marketId,
  );

  if (!markPrice) {
    throw new Error(`Missing mark price for market: ${marketId}`);
  }

  return markPrice.price;
}

function assertNonNegative(value: Money, label: string): void {
  if (!value.isFinite() || value.lt(ZERO)) {
    throw new Error(`${label} must be non-negative`);
  }
}
