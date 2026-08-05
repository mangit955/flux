import {
  MatchingEngine,
  type EngineEvent,
  type TradeExecuted,
} from "../../matching-engine/index";
import {
  ZERO,
  applyFillToPosition,
  emptyPosition,
  money,
  toNumber,
  type FillInput,
  type Money,
} from "../../risk/src/index";
import { commandStream, eventStream, type StreamBus } from "./stream";
import { toRiskConfig, type RuntimeCommand, type RuntimeFill, type RuntimeOrder } from "./types";
import type { RuntimeStore } from "./store";

/** Leverage assumed when the order that opened the position is no longer in the store. */
const DEFAULT_LEVERAGE = 10;

/** What one side of a trade owes or is owed, once its position has been updated. */
interface RoleFillOutcome {
  userId: string;
  asset: string;
  fee: Money;
  realizedPnlDelta: Money;
}

// WebSocket hub interface for event publishing
interface WebSocketPublisher {
  publish(input: {
    channel: string;
    market?: string;
    userId?: string;
    sequence?: number;
    data: unknown;
  }): number;
}

export class MatchingWorker {
  private readonly offsets = new Map<string, string>();

  constructor(
    private readonly bus: StreamBus,
    private readonly engine: MatchingEngine,
    private readonly markets: () => string[],
    private readonly hub?: WebSocketPublisher,
  ) {}

  async processOnce(): Promise<number> {
    let processed = 0;

    for (const market of this.markets()) {
      const stream = commandStream(market);
      const messages = await this.bus.readAfter<RuntimeCommand>(
        stream,
        this.offsets.get(stream),
      );

      for (const message of messages) {
        const events =
          message.payload.type === "order.created"
            ? this.engine.submitOrder(message.payload.command)
            : this.engine.cancelOrder(message.payload.command);

        for (const event of events) {
          await this.bus.append(eventStream(event.market), {
            type: "engine.event",
            event,
          });
          
          // Publish orderbook updates for public channels
          if (this.hub && (event.type === "trade.executed" || event.type === "order.rested")) {
            this.publishOrderbookUpdate(event);
          }
        }

        this.offsets.set(stream, message.id);
        processed += 1;
      }
    }

    return processed;
  }

  private publishOrderbookUpdate(event: EngineEvent): void {
    if (!this.hub) return;

    try {
      // Get current orderbook snapshot for the market
      const snapshot = this.engine.getBookSnapshot(event.market, 20);
      
      this.hub.publish({
        channel: "orderbook",
        market: event.market,
        sequence: event.sequence,
        data: snapshot,
      });

      // Also publish trade data if it's a trade event
      if (event.type === "trade.executed") {
        this.hub.publish({
          channel: "trades",
          market: event.market,
          sequence: event.sequence,
          data: {
            tradeId: event.tradeId,
            price: event.priceTicks,
            quantity: event.qtyLots,
            side: event.takerSide,
            timestamp: event.timestamp,
          },
        });
      }
    } catch (error) {
      console.error("Failed to publish WebSocket update:", error);
    }
  }
}

export class RuntimePersistenceWorker {
  private readonly offsets = new Map<string, string>();

  constructor(
    private readonly bus: StreamBus,
    private readonly store: RuntimeStore,
    private readonly markets: () => string[],
    private readonly hub?: WebSocketPublisher,
  ) {}

  async processOnce(): Promise<number> {
    let processed = 0;

    for (const market of this.markets()) {
      const stream = eventStream(market);
      const messages = await this.bus.readAfter<{ type: "engine.event"; event: EngineEvent }>(
        stream,
        this.offsets.get(stream),
      );

      for (const message of messages) {
        this.applyEvent(message.payload.event);
        this.offsets.set(stream, message.id);
        processed += 1;
      }
    }

    return processed;
  }

  private applyEvent(event: EngineEvent): void {
    if (this.store.processedEvents.has(event.eventId)) {
      return;
    }

    const orderUpdateUsers = new Set<string>();

    switch (event.type) {
      case "order.accepted":
        this.updateOrder(event.orderId, { status: "OPEN", updatedAt: event.timestamp });
        break;
      case "order.rejected":
        this.updateOrder(event.orderId, {
          status: "REJECTED",
          rejectionReason: event.reason,
          updatedAt: event.timestamp,
        });
        break;
      case "order.rested":
        this.updateOrder(event.order.orderId, {
          status: event.order.status,
          remainingQuantity: event.order.remainingQtyLots,
          updatedAt: event.timestamp,
        });
        orderUpdateUsers.add(event.order.userId);
        break;
      case "order.cancelled":
        const cancelledOrder = this.store.orders.get(event.orderId);
        if (cancelledOrder) {
          orderUpdateUsers.add(cancelledOrder.userId);
        }
        this.updateOrder(event.orderId, {
          status: "CANCELLED",
          remainingQuantity: event.remainingQtyLots,
          updatedAt: event.timestamp,
        });
        break;
      case "order.expired":
        const expiredOrder = this.store.orders.get(event.orderId);
        if (expiredOrder) {
          orderUpdateUsers.add(expiredOrder.userId);
        }
        this.updateOrder(event.orderId, {
          status: "EXPIRED",
          remainingQuantity: event.remainingQtyLots,
          updatedAt: event.timestamp,
        });
        break;
      case "order.cancel_rejected":
        break;
      case "trade.executed":
        this.applyTrade(event);
        orderUpdateUsers.add(event.makerUserId);
        orderUpdateUsers.add(event.takerUserId);
        break;
    }

    // Publish private updates to affected users
    if (this.hub && orderUpdateUsers.size > 0) {
      for (const userId of orderUpdateUsers) {
        this.publishPrivateUpdates(userId);
      }
    }

    this.store.processedEvents.add(event.eventId);
  }

  private publishPrivateUpdates(userId: string): void {
    if (!this.hub) return;

    try {
      // Publish updated positions
      const positions = this.store.positionsFor(userId);
      this.hub.publish({
        channel: "positions",
        userId,
        data: positions,
      });

      // Publish updated balances  
      const balances = this.store.balancesFor(userId);
      this.hub.publish({
        channel: "balances",
        userId,
        data: balances,
      });

      // Publish updated orders
      const orders = [...this.store.orders.values()].filter(o => o.userId === userId);
      this.hub.publish({
        channel: "orders",
        userId,
        data: orders,
      });
    } catch (error) {
      console.error(`Failed to publish private updates for user ${userId}:`, error);
    }
  }

  private applyTrade(event: TradeExecuted): void {
    // Positions first: the fill row records the realized PnL that only exists once the position
    // update has run. Mirrors the ordering in PersistenceService.
    const maker = this.applyFillToPosition(event, "MAKER");
    const taker = this.applyFillToPosition(event, "TAKER");
    const makerFill = fillFromTrade(event, "MAKER", maker);
    const takerFill = fillFromTrade(event, "TAKER", taker);

    this.store.fills.set(makerFill.id, makerFill);
    this.store.fills.set(takerFill.id, takerFill);
    this.updateOrder(event.makerOrderId, {
      status: event.makerOrderRemainingQtyLots === 0 ? "FILLED" : "PARTIALLY_FILLED",
      remainingQuantity: event.makerOrderRemainingQtyLots,
      updatedAt: event.timestamp,
    });
    this.updateOrder(event.takerOrderId, {
      status: event.takerOrderRemainingQtyLots === 0 ? "FILLED" : "PARTIALLY_FILLED",
      remainingQuantity: event.takerOrderRemainingQtyLots,
      updatedAt: event.timestamp,
    });

    this.settleRoleFill(event, maker);
    this.settleRoleFill(event, taker);
  }

  private applyFillToPosition(
    event: TradeExecuted,
    role: "MAKER" | "TAKER",
  ): RoleFillOutcome {
    const userId = role === "MAKER" ? event.makerUserId : event.takerUserId;
    const side = role === "MAKER" ? event.makerSide : event.takerSide;
    const market = this.store.markets.get(event.market);

    if (!market) {
      throw new Error(`Unknown market ${event.market}`);
    }

    const orderId = role === "MAKER" ? event.makerOrderId : event.takerOrderId;
    const existing =
      this.store.getPosition(userId, event.market) ??
      emptyPosition(
        userId,
        event.market,
        this.store.orders.get(orderId)?.leverage ?? DEFAULT_LEVERAGE,
      );
    // The matching engine still works in floats, so its values are parsed into exact decimals
    // here, at the boundary. Mirrors the ordering in `PersistenceService`.
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
    const result = applyFillToPosition(existing, fill, toRiskConfig(market));
    this.store.setPosition(result.next);

    return {
      userId,
      asset: market.quoteAsset,
      fee,
      realizedPnlDelta: result.realizedPnlDelta,
    };
  }

  /** Credit gross realized PnL and debit the trading fee — the in-memory twin of `settleRoleFill`. */
  private settleRoleFill(event: TradeExecuted, outcome: RoleFillOutcome): void {
    if (!outcome.realizedPnlDelta.isZero()) {
      this.store.settleBalance(
        outcome.userId,
        outcome.asset,
        outcome.realizedPnlDelta,
      );
    }

    if (outcome.fee.gt(ZERO)) {
      this.store.settleBalance(outcome.userId, outcome.asset, outcome.fee.neg());
    }
  }

  private updateOrder(orderId: string, patch: Partial<RuntimeOrder>): void {
    const existing = this.store.orders.get(orderId);

    if (existing) {
      this.store.orders.set(orderId, { ...existing, ...patch });
    }
  }
}

function fillFromTrade(
  event: TradeExecuted,
  role: "MAKER" | "TAKER",
  outcome: RoleFillOutcome,
): RuntimeFill {
  const maker = role === "MAKER";
  const side = maker ? event.makerSide : event.takerSide;
  const tradeValue = event.priceTicks * event.qtyLots;

  return {
    id: `${event.tradeId}:${role.toLowerCase()}`,
    tradeId: event.tradeId,
    orderId: maker ? event.makerOrderId : event.takerOrderId,
    userId: maker ? event.makerUserId : event.takerUserId,
    marketId: event.market,
    side: side === "buy" ? "BUY" : "SELL",
    liquidityRole: role,
    price: event.priceTicks,
    quantity: event.qtyLots,
    notional: tradeValue,
    fee: toNumber(outcome.fee),
    realizedPnl: toNumber(outcome.realizedPnlDelta),
    createdAt: event.timestamp,
  };
}
