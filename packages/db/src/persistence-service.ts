import type { EngineEvent, TradeExecuted } from "../../matching-engine/index";
import {
  ZERO,
  applyFillToPosition,
  emptyPosition,
  money,
  moneyOr,
  positionSide,
  toDecimalString,
  type FillInput,
  type MarketRiskConfig,
  type Money,
  type Position,
} from "../../risk/src/index";
import type {
  DurableOrderSide,
  DurableOrderStatus,
  DurableOrderType,
  DurableTimeInForce,
  FillWrite,
  JsonValue,
  MarketWrite,
  OrderWrite,
  PositionWrite,
  ProcessedEventWrite,
} from "./records";
import type {
  PersistenceStore,
  PersistenceTransaction,
} from "./persistence-store";

/** Fallback for order rows written before `orders.leverage` existed. */
const DEFAULT_LEVERAGE = 10;

export interface PersistEventMetadata {
  stream?: string;
  streamId?: string;
  processedAt?: Date;
}

export interface PersistEventResult {
  status: "processed" | "skipped";
  eventId: string;
  eventType: EngineEvent["type"];
  writes: string[];
}

export class PersistenceService {
  constructor(private readonly store: PersistenceStore) {}

  async persistEvent(
    event: EngineEvent,
    metadata: PersistEventMetadata = {},
  ): Promise<PersistEventResult> {
    return this.store.transaction(async (tx) => {
      const existing = await tx.findProcessedEvent(event.eventId);

      if (existing) {
        return {
          status: "skipped",
          eventId: event.eventId,
          eventType: event.type,
          writes: [],
        };
      }

      const writes = await this.applyEvent(tx, event);
      await tx.createProcessedEvent(
        processedEventFromEngineEvent(event, metadata),
      );

      return {
        status: "processed",
        eventId: event.eventId,
        eventType: event.type,
        writes: [...writes, "processed_events.create"],
      };
    });
  }

  private async applyEvent(
    tx: PersistenceTransaction,
    event: EngineEvent,
  ): Promise<string[]> {
    switch (event.type) {
      case "order.accepted":
        await tx.updateOrderStatus({
          orderId: event.orderId,
          status: "OPEN",
          updatedAt: new Date(event.timestamp),
        });
        return ["orders.mark_open"];

      case "order.rejected":
        await releaseOrderMargin(
          tx,
          await tx.findOrder(event.orderId),
          event.market,
          new Date(event.timestamp),
        );

        await tx.updateOrderStatus({
          orderId: event.orderId,
          status: "REJECTED",
          rejectionReason: event.reason,
          updatedAt: new Date(event.timestamp),
        });
        return ["orders.mark_rejected", "balance.unlock"];

      case "order.rested":
        await tx.upsertOrder(orderWriteFromRestedEvent(event));
        return ["orders.upsert_rested"];

      case "order.cancelled":
        await releaseOrderMargin(
          tx,
          await tx.findOrder(event.orderId),
          event.market,
          new Date(event.timestamp),
        );

        await tx.updateOrderStatus({
          orderId: event.orderId,
          status: "CANCELLED",
          remainingQuantity: toDecimalString(money(event.remainingQtyLots)),
          updatedAt: new Date(event.timestamp),
        });
        return ["orders.mark_cancelled", "balance.unlock"];

      case "order.cancel_rejected":
        return ["orders.cancel_rejected_noop"];

      case "order.expired":
        await releaseOrderMargin(
          tx,
          await tx.findOrder(event.orderId),
          event.market,
          new Date(event.timestamp),
        );

        await tx.updateOrderStatus({
          orderId: event.orderId,
          status: "EXPIRED",
          remainingQuantity: toDecimalString(money(event.remainingQtyLots)),
          updatedAt: new Date(event.timestamp),
        });
        return ["orders.mark_expired", "balance.unlock"];

      case "trade.executed":
        const market = await tx.findMarket(event.market);

        if (!market) {
          throw new Error(`market not found: ${event.market}`);
        }

        // Read both orders once: the release path clears lockedMargin, and the position
        // mapping needs the leverage the order was submitted with.
        const makerOrder = await tx.findOrder(event.makerOrderId);
        const takerOrder = await tx.findOrder(event.takerOrderId);
        const riskConfig = marketToRiskConfig(market);

        // Positions are applied before the fills are written, because the fill row records the
        // realized PnL that only exists once the position update has run.
        const maker = await applyRoleFillToPosition(tx, event, "MAKER", riskConfig, makerOrder);
        const taker = await applyRoleFillToPosition(tx, event, "TAKER", riskConfig, takerOrder);

        await tx.createFills(fillsFromTrade(event, maker, taker));

        const makerStatus = orderStatusFromRemaining(event.makerOrderRemainingQtyLots);
        await tx.updateOrderStatus({
          orderId: event.makerOrderId,
          status: makerStatus,
          remainingQuantity: toDecimalString(money(event.makerOrderRemainingQtyLots)),
          updatedAt: new Date(event.timestamp),
        });

        if (makerStatus === "FILLED") {
          await releaseOrderMargin(tx, makerOrder, event.market, new Date(event.timestamp));
        }

        const takerStatus = orderStatusFromRemaining(event.takerOrderRemainingQtyLots);
        await tx.updateOrderStatus({
          orderId: event.takerOrderId,
          status: takerStatus,
          remainingQuantity: toDecimalString(money(event.takerOrderRemainingQtyLots)),
          updatedAt: new Date(event.timestamp),
        });

        if (takerStatus === "FILLED") {
          await releaseOrderMargin(tx, takerOrder, event.market, new Date(event.timestamp));
        }

        // Settle last, so the margin released above has already lowered `locked` by the time
        // `total` moves.
        await settleRoleFill(tx, event, "MAKER", market.quoteAsset, maker);
        await settleRoleFill(tx, event, "TAKER", market.quoteAsset, taker);

        return [
          "positions.upsert_maker_after_trade",
          "positions.upsert_taker_after_trade",
          "fills.create_many",
          "orders.update_maker_after_trade",
          "orders.update_taker_after_trade",
          "balance.unlock_maker",
          "balance.unlock_taker",
          "balance.settle_maker",
          "balance.settle_taker",
        ];
    }
  }
}

/**
 * Release the collateral an order actually reserved at submit time.
 *
 * The amount is read from the order row rather than recomputed: reconstructing it needs the
 * order's leverage (which used to be hardcoded to 10) and its price (which is null for every
 * market order), so the old reconstruction over-released, under-released, or released nothing
 * depending on the order. `lockedMargin > 0` doubles as the once-only guard, since the column
 * is zeroed in the same transaction.
 */
async function releaseOrderMargin(
  tx: PersistenceTransaction,
  order: OrderWrite | null,
  marketId: string,
  updatedAt: Date,
): Promise<void> {
  if (!order || order.reduceOnly) {
    return;
  }

  const lockedMargin = moneyOr(order.lockedMargin);

  if (!lockedMargin.gt(ZERO)) {
    return;
  }

  const market = await tx.findMarket(marketId);

  if (!market) {
    return;
  }

  await tx.unlockBalanceForOrder(order.userId, market.quoteAsset, lockedMargin);
  await tx.clearOrderLockedMargin(order.id, updatedAt);
}

/** What one side of a trade owes or is owed, once its position has been updated. */
interface RoleFillOutcome {
  userId: string;
  fee: Money;
  realizedPnlDelta: Money;
}

async function applyRoleFillToPosition(
  tx: PersistenceTransaction,
  event: TradeExecuted,
  role: "MAKER" | "TAKER",
  market: MarketRiskConfig,
  order: OrderWrite | null,
): Promise<RoleFillOutcome> {
  const userId = role === "MAKER" ? event.makerUserId : event.takerUserId;
  const side = role === "MAKER" ? event.makerSide : event.takerSide;
  const existing = positionFromWrite(
    await tx.findPosition(userId, event.market),
  ) ?? emptyPosition(userId, event.market, order?.leverage ?? DEFAULT_LEVERAGE);
  // The matching engine still works in floats, so its values are parsed into exact decimals
  // here, at the boundary. Everything downstream of this point is exact.
  const price = money(event.priceTicks);
  const quantity = money(event.qtyLots);
  // Charged by liquidity role, not always at the taker rate — providing liquidity is cheaper.
  const fee = price
    .mul(quantity)
    .mul(role === "MAKER" ? market.makerFeeRate : market.takerFeeRate);
  const fill: FillInput = {
    userId,
    marketId: event.market,
    side: side === "buy" ? "BUY" : "SELL",
    price,
    quantity,
    fee,
  };
  // `applyFillToPosition` subtracts the fee into `position.realizedPnl`, so the position row
  // records PnL net of fees while `realizedPnlDelta` stays gross.
  const result = applyFillToPosition(existing, fill, market);

  await tx.upsertPosition(positionToWrite(result.next, new Date(event.timestamp)));

  return { userId, fee, realizedPnlDelta: result.realizedPnlDelta };
}

/**
 * Move the money a fill actually produced: credit gross realized PnL, debit the trading fee,
 * and record both in the ledger. Without this the exchange collects nothing and a user who
 * closes a winning position receives nothing spendable.
 */
async function settleRoleFill(
  tx: PersistenceTransaction,
  event: TradeExecuted,
  role: "MAKER" | "TAKER",
  asset: string,
  outcome: RoleFillOutcome,
): Promise<void> {
  const fillId = `${event.tradeId}:${role.toLowerCase()}`;
  const createdAt = new Date(event.timestamp);

  if (!outcome.realizedPnlDelta.isZero()) {
    const balanceAfter = await tx.adjustBalanceTotal(
      outcome.userId,
      asset,
      outcome.realizedPnlDelta,
    );

    await tx.createLedgerEntry({
      id: `${fillId}:pnl`,
      userId: outcome.userId,
      asset,
      type: "REALIZED_PNL",
      amount: toDecimalString(outcome.realizedPnlDelta),
      balanceAfter: toDecimalString(balanceAfter),
      referenceId: fillId,
      createdAt,
    });
  }

  if (outcome.fee.gt(ZERO)) {
    const balanceAfter = await tx.adjustBalanceTotal(
      outcome.userId,
      asset,
      outcome.fee.neg(),
    );

    await tx.createLedgerEntry({
      id: `${fillId}:fee`,
      userId: outcome.userId,
      asset,
      type: "TRADING_FEE",
      amount: toDecimalString(outcome.fee.neg()),
      balanceAfter: toDecimalString(balanceAfter),
      referenceId: fillId,
      createdAt,
    });
  }
}

function processedEventFromEngineEvent(
  event: EngineEvent,
  metadata: PersistEventMetadata,
): ProcessedEventWrite {
  return {
    eventId: event.eventId,
    eventType: event.type,
    stream: metadata.stream,
    streamId: metadata.streamId,
    marketId: event.market,
    raw: toJsonValue(event),
    processedAt: metadata.processedAt ?? new Date(),
  };
}

function orderWriteFromRestedEvent(
  event: Extract<EngineEvent, { type: "order.rested" }>,
): OrderWrite {
  return {
    id: event.order.orderId,
    userId: event.order.userId,
    marketId: event.order.market,
    side: sideToDurable(event.order.side),
    type: orderTypeToDurable(event.order.type),
    timeInForce: timeInForceToDurable(event.order.timeInForce),
    price:
      event.order.priceTicks == null
        ? null
        : toDecimalString(money(event.order.priceTicks)),
    quantity: toDecimalString(money(event.order.qtyLots)),
    remainingQuantity: toDecimalString(money(event.order.remainingQtyLots)),
    reduceOnly: event.order.reduceOnly,
    postOnly: event.order.postOnly,
    status: event.order.status,
    rejectionReason: null,
    createdAt: new Date(event.order.createdAt),
    updatedAt: new Date(event.timestamp),
  };
}

function fillsFromTrade(
  event: TradeExecuted,
  maker: RoleFillOutcome,
  taker: RoleFillOutcome,
): FillWrite[] {
  const createdAt = new Date(event.timestamp);
  const price = money(event.priceTicks);
  const quantity = money(event.qtyLots);
  const notional = toDecimalString(price.mul(quantity));

  return [
    {
      id: `${event.tradeId}:maker`,
      tradeId: event.tradeId,
      orderId: event.makerOrderId,
      userId: event.makerUserId,
      marketId: event.market,
      side: sideToDurable(event.makerSide),
      liquidityRole: "MAKER",
      price: toDecimalString(price),
      quantity: toDecimalString(quantity),
      notional,
      fee: toDecimalString(maker.fee),
      realizedPnl: toDecimalString(maker.realizedPnlDelta),
      eventId: event.eventId,
      createdAt,
    },
    {
      id: `${event.tradeId}:taker`,
      tradeId: event.tradeId,
      orderId: event.takerOrderId,
      userId: event.takerUserId,
      marketId: event.market,
      side: sideToDurable(event.takerSide),
      liquidityRole: "TAKER",
      price: toDecimalString(price),
      quantity: toDecimalString(quantity),
      notional,
      fee: toDecimalString(taker.fee),
      realizedPnl: toDecimalString(taker.realizedPnlDelta),
      eventId: event.eventId,
      createdAt,
    },
  ];
}

function sideToDurable(side: "buy" | "sell"): DurableOrderSide {
  return side === "buy" ? "BUY" : "SELL";
}

function orderTypeToDurable(type: "market" | "limit"): DurableOrderType {
  return type === "market" ? "MARKET" : "LIMIT";
}

function timeInForceToDurable(timeInForce: "GTC" | "IOC"): DurableTimeInForce {
  return timeInForce;
}

function orderStatusFromRemaining(remainingQtyLots: number): DurableOrderStatus {
  return remainingQtyLots === 0 ? "FILLED" : "PARTIALLY_FILLED";
}

function marketToRiskConfig(market: MarketWrite): MarketRiskConfig {
  return {
    marketId: market.marketId,
    tickSize: money(market.tickSize),
    lotSize: money(market.lotSize),
    maxLeverage: market.maxLeverage,
    initialMarginRate: money(market.initialMarginRate),
    maintenanceMarginRate: money(market.maintenanceMarginRate),
    makerFeeRate: money(market.makerFeeRate),
    takerFeeRate: money(market.takerFeeRate),
  };
}

function positionFromWrite(position: PositionWrite | null): Position | null {
  return position
    ? {
        userId: position.userId,
        marketId: position.marketId,
        quantity: money(position.quantity),
        entryPrice: money(position.entryPrice),
        realizedPnl: money(position.realizedPnl),
        leverage: position.leverage,
      }
    : null;
}

function positionToWrite(position: Position, updatedAt: Date): PositionWrite {
  return {
    userId: position.userId,
    marketId: position.marketId,
    side: positionSide(position),
    quantity: toDecimalString(position.quantity),
    entryPrice: toDecimalString(position.entryPrice),
    realizedPnl: toDecimalString(position.realizedPnl),
    leverage: position.leverage,
    updatedAt,
  };
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
