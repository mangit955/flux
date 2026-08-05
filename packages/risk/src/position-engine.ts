import { Decimal, ZERO, money, type Money } from "./decimal";
import type {
  FillInput,
  MarketRiskConfig,
  Position,
  PositionSide,
  PositionUpdateResult,
  PositionView,
} from "./types";

/**
 * Quantities below this are treated as a fully closed position.
 *
 * Still needed after the move to exact arithmetic: fill quantities originate in the matching
 * engine, which subtracts them in float (`orderbook.ts:285-287`), so a sequence of partial fills
 * can close a position to a residue rather than to exactly zero.
 */
const DUST = money("1e-12");

export function emptyPosition(
  userId: string,
  marketId: string,
  leverage = 1,
): Position {
  return {
    userId,
    marketId,
    quantity: ZERO,
    entryPrice: ZERO,
    realizedPnl: ZERO,
    leverage,
  };
}

export function applyFillToPosition(
  position: Position | undefined,
  fill: FillInput,
  market: MarketRiskConfig,
): PositionUpdateResult {
  assertPositive(fill.quantity, "fill quantity");
  assertPositive(fill.price, "fill price");
  assertLeverage(position?.leverage ?? 1, market);

  const previous = clonePosition(
    position ?? emptyPosition(fill.userId, fill.marketId),
  );
  const signedFillQuantity =
    fill.side === "BUY" ? fill.quantity : fill.quantity.neg();
  const sameDirection =
    previous.quantity.isZero() ||
    previous.quantity.s === signedFillQuantity.s;

  let nextQuantity = previous.quantity.add(signedFillQuantity);
  let nextEntryPrice = previous.entryPrice;
  let realizedPnlDelta = ZERO;
  let closedQuantity = ZERO;
  let openedQuantity = ZERO;

  if (sameDirection) {
    const previousAbsQuantity = previous.quantity.abs();
    const nextAbsQuantity = nextQuantity.abs();

    nextEntryPrice = nextAbsQuantity.isZero()
      ? ZERO
      : previous.entryPrice
          .mul(previousAbsQuantity)
          .add(fill.price.mul(fill.quantity))
          .div(nextAbsQuantity);
    openedQuantity = fill.quantity;
  } else {
    closedQuantity = Decimal.min(previous.quantity.abs(), fill.quantity);
    realizedPnlDelta = calculateRealizedPnl(
      previous.quantity,
      previous.entryPrice,
      fill.price,
      closedQuantity,
    );

    if (nextQuantity.isZero()) {
      nextEntryPrice = ZERO;
    } else if (nextQuantity.s !== previous.quantity.s) {
      openedQuantity = nextQuantity.abs();
      nextEntryPrice = fill.price;
    } else {
      nextEntryPrice = previous.entryPrice;
    }
  }

  if (isDust(nextQuantity)) {
    nextQuantity = ZERO;
    nextEntryPrice = ZERO;
  }

  const next: Position = {
    ...previous,
    userId: fill.userId,
    marketId: fill.marketId,
    quantity: nextQuantity,
    entryPrice: nextEntryPrice,
    realizedPnl: previous.realizedPnl.add(realizedPnlDelta).sub(fill.fee),
  };

  return {
    previous,
    next,
    closedQuantity,
    openedQuantity,
    realizedPnlDelta,
    feePaid: fill.fee,
  };
}

export function positionSide(position: Pick<Position, "quantity">): PositionSide {
  if (position.quantity.gt(ZERO)) {
    return "LONG";
  }

  if (position.quantity.lt(ZERO)) {
    return "SHORT";
  }

  return "FLAT";
}

export function calculateUnrealizedPnl(
  position: Pick<Position, "quantity" | "entryPrice">,
  markPrice: Money,
): Money {
  if (position.quantity.isZero()) {
    return ZERO;
  }

  return markPrice.sub(position.entryPrice).mul(position.quantity);
}

export function positionNotional(
  position: Pick<Position, "quantity">,
  markPrice: Money,
): Money {
  return position.quantity.abs().mul(markPrice);
}

export function viewPosition(
  position: Position,
  market: MarketRiskConfig,
  markPrice: Money,
): PositionView {
  const notional = positionNotional(position, markPrice);

  return {
    ...position,
    side: positionSide(position),
    notional,
    unrealizedPnl: calculateUnrealizedPnl(position, markPrice),
    initialMargin: notional.div(position.leverage),
    maintenanceMargin: notional.mul(market.maintenanceMarginRate),
  };
}

function calculateRealizedPnl(
  previousQuantity: Money,
  entryPrice: Money,
  fillPrice: Money,
  closedQuantity: Money,
): Money {
  if (previousQuantity.gt(ZERO)) {
    return fillPrice.sub(entryPrice).mul(closedQuantity);
  }

  return entryPrice.sub(fillPrice).mul(closedQuantity);
}

function assertPositive(value: Money, label: string): void {
  if (!value.isFinite() || value.lte(ZERO)) {
    throw new Error(`${label} must be positive`);
  }
}

function assertLeverage(leverage: number, market: MarketRiskConfig): void {
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > market.maxLeverage) {
    throw new Error(
      `leverage must be between 1 and ${market.maxLeverage} for ${market.marketId}`,
    );
  }
}

function clonePosition(position: Position): Position {
  return { ...position };
}

function isDust(value: Money): boolean {
  return value.abs().lt(DUST);
}
