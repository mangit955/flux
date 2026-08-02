import type { CancelOrderCommand, NewOrderCommand, Side } from "../types/command";
import type {
  CancelRejectedReason,
  EngineEvent,
  OrderExpiredReason,
  OrderRejectedReason,
  OrderRested,
  TradeExecuted,
} from "../types/event";
import type {
  Order,
  OrderBookSnapshot,
  OrderSnapshot,
  OrderStatus,
  PriceLevelSnapshot,
} from "../types/order";
import { PriceLevelTree, type PriceLevelLike } from "./price-level-tree";

interface PriceLevel extends PriceLevelLike {
  totalQtyLots: number;
  head?: OrderNode;
  tail?: OrderNode;
}

interface OrderNode extends Order {
  sequence: number;
  level?: PriceLevel;
  prev?: OrderNode;
  next?: OrderNode;
}

interface IncomingOrder extends Order {
  sequence: number;
  minPriceTicks?: number;
  maxPriceTicks?: number;
}

export class OrderBook {
  private readonly bids = new PriceLevelTree<PriceLevel>("max");
  private readonly asks = new PriceLevelTree<PriceLevel>("min");
  private readonly openOrdersById = new Map<string, OrderNode>();
  private readonly seenOrderIds = new Set<string>();
  private sequence = 0;
  private tradeSequence = 0;

  constructor(
    readonly market: string,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  static fromSnapshot(
    snapshot: OrderBookSnapshot,
    clock: () => number = () => Date.now(),
  ): OrderBook {
    const book = new OrderBook(snapshot.market, clock);
    book.sequence = snapshot.sequence;

    for (const level of [...snapshot.bids, ...snapshot.asks]) {
      for (const order of level.orders) {
        book.seenOrderIds.add(order.orderId);
        book.restOrder({
          ...order,
          status: order.status,
          sequence: order.sequence,
        });
      }
    }

    return book;
  }

  submitOrder(command: NewOrderCommand): EngineEvent[] {
    const rejectionReason = this.validateNewOrder(command);

    if (rejectionReason) {
      return [this.orderRejected(command, rejectionReason)];
    }

    this.seenOrderIds.add(command.orderId);

    const events: EngineEvent[] = [this.orderAccepted(command)];
    const incoming = this.createIncomingOrder(command);
    const stopReason = this.matchIncomingOrder(command, incoming, events);

    if (incoming.remainingQtyLots === 0) {
      incoming.status = "FILLED";
      return events;
    }

    if (stopReason) {
      incoming.status = "EXPIRED";
      events.push(this.orderExpired(command, incoming, stopReason));
      return events;
    }

    if (incoming.type === "market") {
      incoming.status = "EXPIRED";
      events.push(
        this.orderExpired(command, incoming, "MARKET_LIQUIDITY_EXHAUSTED"),
      );
      return events;
    }

    if (incoming.timeInForce === "IOC") {
      incoming.status = "EXPIRED";
      events.push(this.orderExpired(command, incoming, "IOC_UNFILLED"));
      return events;
    }

    const restedOrder = this.restOrder(incoming);
    events.push({
      ...this.nextEventBase(command.commandId),
      type: "order.rested",
      order: toOrderSnapshot(restedOrder),
    });

    return events;
  }

  cancelOrder(command: CancelOrderCommand): EngineEvent[] {
    const order = this.openOrdersById.get(command.orderId);

    if (!order) {
      const reason: CancelRejectedReason = this.seenOrderIds.has(command.orderId)
        ? "ORDER_NOT_OPEN"
        : "ORDER_NOT_FOUND";

      return [this.cancelRejected(command, reason)];
    }

    if (order.userId !== command.userId) {
      return [this.cancelRejected(command, "USER_MISMATCH")];
    }

    const remainingQtyLots = order.remainingQtyLots;
    order.remainingQtyLots = 0;
    order.status = "CANCELLED";
    this.unlinkOpenOrder(order, remainingQtyLots);

    return [
      {
        ...this.nextEventBase(command.commandId),
        type: "order.cancelled",
        orderId: command.orderId,
        remainingQtyLots,
      },
    ];
  }

  getOpenOrder(orderId: string): OrderSnapshot | undefined {
    const order = this.openOrdersById.get(orderId);
    return order ? toOrderSnapshot(order) : undefined;
  }

  snapshot(depth?: number): OrderBookSnapshot {
    return {
      market: this.market,
      sequence: this.sequence,
      bids: this.bids.valuesBestFirst(depth).map(toPriceLevelSnapshot),
      asks: this.asks.valuesBestFirst(depth).map(toPriceLevelSnapshot),
    };
  }

  applyReplayEvent(event: EngineEvent): void {
    if (event.market !== this.market) {
      throw new Error(`Cannot replay ${event.market} event into ${this.market}`);
    }

    this.sequence = Math.max(this.sequence, event.sequence);

    switch (event.type) {
      case "order.rested":
        this.replayOrderRested(event);
        return;

      case "order.cancelled":
        this.replayOrderRemoved(event.orderId);
        return;

      case "trade.executed":
        this.replayTrade(event);
        return;

      case "order.accepted":
      case "order.rejected":
      case "order.cancel_rejected":
      case "order.expired":
        return;
    }
  }

  private validateNewOrder(command: NewOrderCommand): OrderRejectedReason | null {
    if (command.qtyLots <= 0) {
      return "INVALID_QUANTITY";
    }

    if (command.type === "market" && command.priceTicks != null) {
      return "MARKET_ORDER_HAS_PRICE";
    }

    if (
      command.type === "market" &&
      ((command.minPriceTicks != null && command.minPriceTicks <= 0) ||
        (command.maxPriceTicks != null && command.maxPriceTicks <= 0))
    ) {
      return "INVALID_PRICE";
    }

    if (command.type === "limit" && command.priceTicks == null) {
      return "LIMIT_ORDER_MISSING_PRICE";
    }

    if (command.priceTicks != null && command.priceTicks <= 0) {
      return "INVALID_PRICE";
    }

    if (command.postOnly && command.type !== "limit") {
      return "POST_ONLY_REQUIRES_LIMIT_ORDER";
    }

    if (command.postOnly && command.timeInForce !== "GTC") {
      return "POST_ONLY_REQUIRES_GTC";
    }

    if (this.seenOrderIds.has(command.orderId)) {
      return "DUPLICATE_ORDER_ID";
    }

    if (command.postOnly && this.wouldCross(command)) {
      return "POST_ONLY_WOULD_TAKE";
    }

    return null;
  }

  private createIncomingOrder(command: NewOrderCommand): IncomingOrder {
    return {
      orderId: command.orderId,
      userId: command.userId,
      market: command.market,
      side: command.side,
      type: command.type,
      qtyLots: command.qtyLots,
      remainingQtyLots: command.qtyLots,
      priceTicks: command.priceTicks,
      minPriceTicks: command.minPriceTicks,
      maxPriceTicks: command.maxPriceTicks,
      status: "OPEN",
      timeInForce: command.timeInForce,
      reduceOnly: command.reduceOnly ?? false,
      postOnly: command.postOnly ?? false,
      createdAt: command.createdAt,
      sequence: this.sequence,
    };
  }

  private matchIncomingOrder(
    command: NewOrderCommand,
    incoming: IncomingOrder,
    events: EngineEvent[],
  ): OrderExpiredReason | null {
    while (incoming.remainingQtyLots > 0) {
      const bestLevel = this.bestOppositeLevel(incoming.side);

      if (!bestLevel || !this.canCross(incoming, bestLevel)) {
        return null;
      }

      const maker = bestLevel.head;

      if (!maker) {
        this.removePriceLevel(incoming.side === "buy" ? "sell" : "buy", bestLevel);
        continue;
      }

      if (maker.userId === incoming.userId) {
        return "SELF_TRADE_PREVENTION";
      }

      const qtyLots = Math.min(
        incoming.remainingQtyLots,
        maker.remainingQtyLots,
      );

      maker.remainingQtyLots -= qtyLots;
      incoming.remainingQtyLots -= qtyLots;
      bestLevel.totalQtyLots -= qtyLots;

      maker.status =
        maker.remainingQtyLots === 0 ? "FILLED" : "PARTIALLY_FILLED";
      incoming.status =
        incoming.remainingQtyLots === 0 ? "FILLED" : "PARTIALLY_FILLED";

      events.push(this.tradeExecuted(command, maker, incoming, qtyLots));

      if (maker.remainingQtyLots === 0) {
        this.unlinkOpenOrder(maker, 0);
      }
    }

    return null;
  }

  private restOrder(incoming: IncomingOrder): OrderNode {
    const tree = incoming.side === "buy" ? this.bids : this.asks;
    const priceTicks = requireLimitPrice(incoming);
    let level = tree.get(priceTicks);

    if (!level) {
      level = {
        priceTicks,
        totalQtyLots: 0,
      };
      tree.set(level);
    }

    const order: OrderNode = {
      ...incoming,
      status:
        incoming.remainingQtyLots === incoming.qtyLots
          ? "OPEN"
          : "PARTIALLY_FILLED",
      level,
    };

    if (level.tail) {
      level.tail.next = order;
      order.prev = level.tail;
    } else {
      level.head = order;
    }

    level.tail = order;
    level.totalQtyLots += order.remainingQtyLots;
    this.openOrdersById.set(order.orderId, order);

    return order;
  }

  private replayOrderRested(event: OrderRested): void {
    if (this.openOrdersById.has(event.order.orderId)) {
      return;
    }

    this.seenOrderIds.add(event.order.orderId);
    this.restOrder({
      ...event.order,
      status: event.order.status,
      sequence: event.order.sequence,
    });
  }

  private replayTrade(event: TradeExecuted): void {
    const maker = this.openOrdersById.get(event.makerOrderId);

    if (!maker) {
      return;
    }

    const qtyLots = Math.min(event.qtyLots, maker.remainingQtyLots);
    maker.remainingQtyLots -= qtyLots;

    if (maker.level) {
      maker.level.totalQtyLots -= qtyLots;
    }

    maker.status =
      maker.remainingQtyLots === 0 ? "FILLED" : "PARTIALLY_FILLED";

    if (maker.remainingQtyLots === 0) {
      this.unlinkOpenOrder(maker, 0);
    }
  }

  private replayOrderRemoved(orderId: string): void {
    const order = this.openOrdersById.get(orderId);

    if (!order) {
      return;
    }

    const remainingQtyLots = order.remainingQtyLots;
    order.remainingQtyLots = 0;
    order.status = "CANCELLED";
    this.unlinkOpenOrder(order, remainingQtyLots);
  }

  private unlinkOpenOrder(order: OrderNode, qtyToSubtract: number): void {
    const level = order.level;

    if (!level) {
      return;
    }

    if (qtyToSubtract > 0) {
      level.totalQtyLots -= qtyToSubtract;
    }

    if (order.prev) {
      order.prev.next = order.next;
    } else {
      level.head = order.next;
    }

    if (order.next) {
      order.next.prev = order.prev;
    } else {
      level.tail = order.prev;
    }

    order.prev = undefined;
    order.next = undefined;
    order.level = undefined;
    this.openOrdersById.delete(order.orderId);

    if (!level.head || level.totalQtyLots <= 0) {
      this.removePriceLevel(order.side, level);
    }
  }

  private removePriceLevel(side: Side, level: PriceLevel): void {
    const tree = side === "buy" ? this.bids : this.asks;
    tree.delete(level.priceTicks);
  }

  private bestOppositeLevel(side: Side): PriceLevel | undefined {
    return side === "buy" ? this.asks.best() : this.bids.best();
  }

  private wouldCross(command: NewOrderCommand): boolean {
    const bestLevel = this.bestOppositeLevel(command.side);

    if (!bestLevel) {
      return false;
    }

    if (command.type === "market") {
      return true;
    }

    return command.side === "buy"
      ? bestLevel.priceTicks <= requireLimitPrice(command)
      : bestLevel.priceTicks >= requireLimitPrice(command);
  }

  private canCross(order: IncomingOrder, bestLevel: PriceLevel): boolean {
    if (order.type === "market") {
      if (order.side === "buy" && order.maxPriceTicks != null) {
        return bestLevel.priceTicks <= order.maxPriceTicks;
      }

      if (order.side === "sell" && order.minPriceTicks != null) {
        return bestLevel.priceTicks >= order.minPriceTicks;
      }

      return true;
    }

    return order.side === "buy"
      ? bestLevel.priceTicks <= requireLimitPrice(order)
      : bestLevel.priceTicks >= requireLimitPrice(order);
  }

  private orderAccepted(command: NewOrderCommand): EngineEvent {
    return {
      ...this.nextEventBase(command.commandId),
      type: "order.accepted",
      orderId: command.orderId,
    };
  }

  private orderRejected(
    command: NewOrderCommand,
    reason: OrderRejectedReason,
  ): EngineEvent {
    return {
      ...this.nextEventBase(command.commandId),
      type: "order.rejected",
      orderId: command.orderId,
      reason,
    };
  }

  private cancelRejected(
    command: CancelOrderCommand,
    reason: CancelRejectedReason,
  ): EngineEvent {
    return {
      ...this.nextEventBase(command.commandId),
      type: "order.cancel_rejected",
      orderId: command.orderId,
      reason,
    };
  }

  private orderExpired(
    command: NewOrderCommand,
    order: IncomingOrder,
    reason: OrderExpiredReason,
  ): EngineEvent {
    return {
      ...this.nextEventBase(command.commandId),
      type: "order.expired",
      orderId: order.orderId,
      remainingQtyLots: order.remainingQtyLots,
      reason,
    };
  }

  private tradeExecuted(
    command: NewOrderCommand,
    maker: OrderNode,
    taker: IncomingOrder,
    qtyLots: number,
  ): TradeExecuted {
    return {
      ...this.nextEventBase(command.commandId),
      type: "trade.executed",
      tradeId: `${this.market}-trade-${++this.tradeSequence}`,
      makerOrderId: maker.orderId,
      takerOrderId: taker.orderId,
      makerUserId: maker.userId,
      takerUserId: taker.userId,
      makerSide: maker.side,
      takerSide: taker.side,
      priceTicks: requireLimitPrice(maker),
      qtyLots,
      makerOrderRemainingQtyLots: maker.remainingQtyLots,
      takerOrderRemainingQtyLots: taker.remainingQtyLots,
    };
  }

  private nextEventBase(commandId: string): {
    eventId: string;
    commandId: string;
    market: string;
    sequence: number;
    timestamp: number;
  } {
    const sequence = ++this.sequence;

    return {
      eventId: `${this.market}-${sequence}`,
      commandId,
      market: this.market,
      sequence,
      timestamp: this.clock(),
    };
  }
}

function requireLimitPrice(order: { priceTicks?: number }): number {
  if (order.priceTicks == null) {
    throw new Error("Expected order to have a limit price");
  }

  return order.priceTicks;
}

function toOrderSnapshot(order: OrderNode): OrderSnapshot {
  return {
    orderId: order.orderId,
    userId: order.userId,
    market: order.market,
    side: order.side,
    type: order.type,
    qtyLots: order.qtyLots,
    remainingQtyLots: order.remainingQtyLots,
    priceTicks: order.priceTicks,
    status: order.status as OrderStatus,
    timeInForce: order.timeInForce,
    reduceOnly: order.reduceOnly,
    postOnly: order.postOnly,
    createdAt: order.createdAt,
    sequence: order.sequence,
  };
}

function toPriceLevelSnapshot(level: PriceLevel): PriceLevelSnapshot {
  const orders: PriceLevelSnapshot["orders"] = [];
  let current = level.head;

  while (current) {
    orders.push(toOrderSnapshot(current));
    current = current.next;
  }

  return {
    priceTicks: level.priceTicks,
    totalQtyLots: level.totalQtyLots,
    orders,
  };
}
