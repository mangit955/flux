import type { EngineEvent, TradeExecuted } from "../../matching-engine/index";
import {
  applyFillToPosition,
  emptyPosition,
  positionSide,
  type FillInput,
  type MarketRiskConfig,
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
          remainingQuantity: decimalString(event.remainingQtyLots),
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
          remainingQuantity: decimalString(event.remainingQtyLots),
          updatedAt: new Date(event.timestamp),
        });
        return ["orders.mark_expired", "balance.unlock"];

      case "trade.executed":
        await tx.createFills(fillsFromTrade(event));

        // Read both orders once: the release path clears lockedMargin, and the position
        // mapping needs the leverage the order was submitted with.
        const makerOrder = await tx.findOrder(event.makerOrderId);
        const takerOrder = await tx.findOrder(event.takerOrderId);

        const makerStatus = orderStatusFromRemaining(event.makerOrderRemainingQtyLots);
        await tx.updateOrderStatus({
          orderId: event.makerOrderId,
          status: makerStatus,
          remainingQuantity: decimalString(event.makerOrderRemainingQtyLots),
          updatedAt: new Date(event.timestamp),
        });

        if (makerStatus === "FILLED") {
          await releaseOrderMargin(tx, makerOrder, event.market, new Date(event.timestamp));
        }

        const takerStatus = orderStatusFromRemaining(event.takerOrderRemainingQtyLots);
        await tx.updateOrderStatus({
          orderId: event.takerOrderId,
          status: takerStatus,
          remainingQuantity: decimalString(event.takerOrderRemainingQtyLots),
          updatedAt: new Date(event.timestamp),
        });

        if (takerStatus === "FILLED") {
          await releaseOrderMargin(tx, takerOrder, event.market, new Date(event.timestamp));
        }

        await applyTradeToPositions(tx, event, makerOrder, takerOrder);
        return [
          "fills.create_many",
          "orders.update_maker_after_trade",
          "orders.update_taker_after_trade",
          "balance.unlock_maker",
          "balance.unlock_taker",
          "positions.upsert_maker_after_trade",
          "positions.upsert_taker_after_trade",
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

  const lockedMargin = Number(order.lockedMargin ?? 0);

  if (!(lockedMargin > 0)) {
    return;
  }

  const market = await tx.findMarket(marketId);

  if (!market) {
    return;
  }

  await tx.unlockBalanceForOrder(order.userId, market.quoteAsset, lockedMargin);
  await tx.clearOrderLockedMargin(order.id, updatedAt);
}

async function applyTradeToPositions(
  tx: PersistenceTransaction,
  event: TradeExecuted,
  makerOrder: OrderWrite | null,
  takerOrder: OrderWrite | null,
): Promise<void> {
  const market = await tx.findMarket(event.market);

  if (!market) {
    throw new Error(`market not found: ${event.market}`);
  }

  await applyRoleFillToPosition(tx, event, "MAKER", marketToRiskConfig(market), makerOrder);
  await applyRoleFillToPosition(tx, event, "TAKER", marketToRiskConfig(market), takerOrder);
}

async function applyRoleFillToPosition(
  tx: PersistenceTransaction,
  event: TradeExecuted,
  role: "MAKER" | "TAKER",
  market: MarketRiskConfig,
  order: OrderWrite | null,
): Promise<void> {
  const userId = role === "MAKER" ? event.makerUserId : event.takerUserId;
  const side = role === "MAKER" ? event.makerSide : event.takerSide;
  const existing = positionFromWrite(
    await tx.findPosition(userId, event.market),
  ) ?? emptyPosition(userId, event.market, order?.leverage ?? DEFAULT_LEVERAGE);
  const fill: FillInput = {
    userId,
    marketId: event.market,
    side: side === "buy" ? "BUY" : "SELL",
    price: event.priceTicks,
    quantity: event.qtyLots,
    fee: 0,
  };
  const result = applyFillToPosition(existing, fill, market);

  await tx.upsertPosition(positionToWrite(result.next, new Date(event.timestamp)));
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
      event.order.priceTicks == null ? null : decimalString(event.order.priceTicks),
    quantity: decimalString(event.order.qtyLots),
    remainingQuantity: decimalString(event.order.remainingQtyLots),
    reduceOnly: event.order.reduceOnly,
    postOnly: event.order.postOnly,
    status: event.order.status,
    rejectionReason: null,
    createdAt: new Date(event.order.createdAt),
    updatedAt: new Date(event.timestamp),
  };
}

function fillsFromTrade(event: TradeExecuted): FillWrite[] {
  const createdAt = new Date(event.timestamp);
  const price = decimalString(event.priceTicks);
  const quantity = decimalString(event.qtyLots);
  const notional = decimalString(event.priceTicks * event.qtyLots);

  return [
    {
      id: `${event.tradeId}:maker`,
      tradeId: event.tradeId,
      orderId: event.makerOrderId,
      userId: event.makerUserId,
      marketId: event.market,
      side: sideToDurable(event.makerSide),
      liquidityRole: "MAKER",
      price,
      quantity,
      notional,
      fee: "0",
      realizedPnl: "0",
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
      price,
      quantity,
      notional,
      fee: "0",
      realizedPnl: "0",
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

function decimalString(value: number): string {
  return String(value);
}

function marketToRiskConfig(market: MarketWrite): MarketRiskConfig {
  return {
    marketId: market.marketId,
    tickSize: Number(market.tickSize),
    lotSize: Number(market.lotSize),
    maxLeverage: market.maxLeverage,
    initialMarginRate: Number(market.initialMarginRate),
    maintenanceMarginRate: Number(market.maintenanceMarginRate),
    makerFeeRate: Number(market.makerFeeRate),
    takerFeeRate: Number(market.takerFeeRate),
  };
}

function positionFromWrite(position: PositionWrite | null): Position | null {
  return position
    ? {
        userId: position.userId,
        marketId: position.marketId,
        quantity: Number(position.quantity),
        entryPrice: Number(position.entryPrice),
        realizedPnl: Number(position.realizedPnl),
        leverage: position.leverage,
      }
    : null;
}

function positionToWrite(position: Position, updatedAt: Date): PositionWrite {
  return {
    userId: position.userId,
    marketId: position.marketId,
    side: positionSide(position),
    quantity: decimalString(position.quantity),
    entryPrice: decimalString(position.entryPrice),
    realizedPnl: decimalString(position.realizedPnl),
    leverage: position.leverage,
    updatedAt,
  };
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
