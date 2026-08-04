import { describe, expect, it } from "bun:test";
import {
  MatchingEngine,
  type EngineEvent,
  type TradeExecuted,
} from "../../matching-engine/index";
import { createOutboxEvent } from "./outbox";
import { PersistenceService } from "./persistence-service";
import type { OrderWrite } from "./records";
import { InMemoryPersistenceStore } from "./testing/in-memory-persistence-store";

const MARKET = "BTC-PERP";
const NOW = 1_700_000_000_000;

describe("PersistenceService", () => {
  it("upserts rested orders and records processed events", async () => {
    const store = new InMemoryPersistenceStore();
    const service = new PersistenceService(store);
    const engine = new MatchingEngine({ clock: () => NOW });

    const events = engine.submitOrder({
      commandId: "cmd-1",
      orderId: "bid-1",
      userId: "user-1",
      market: MARKET,
      side: "buy",
      type: "limit",
      qtyLots: 5,
      priceTicks: 100,
      timeInForce: "GTC",
      postOnly: true,
      createdAt: NOW,
    });

    for (const event of events) {
      await service.persistEvent(event, {
        stream: `engine.events.${MARKET}`,
        streamId: `0-${event.sequence}`,
        processedAt: new Date(NOW + event.sequence),
      });
    }

    expect(store.state.orders.get("bid-1")).toMatchObject({
      id: "bid-1",
      userId: "user-1",
      marketId: MARKET,
      side: "BUY",
      type: "LIMIT",
      price: "100",
      quantity: "5",
      remainingQuantity: "5",
      postOnly: true,
      status: "OPEN",
    });
    expect(store.state.processedEvents.size).toBe(events.length);
    expect(store.state.processedEvents.get(events[0]?.eventId ?? "")).toMatchObject({
      eventType: "order.accepted",
      stream: `engine.events.${MARKET}`,
      streamId: "0-1",
    });
  });

  it("persists trade fills and skips duplicate events", async () => {
    const store = new InMemoryPersistenceStore();
    const service = new PersistenceService(store);
    const trade = tradeExecutedEvent();

    store.seedOrder(
      pendingOrder({
        id: trade.makerOrderId,
        userId: trade.makerUserId,
        side: "SELL",
        price: "100",
        quantity: "5",
        remainingQuantity: "5",
      }),
    );
    store.seedOrder(
      pendingOrder({
        id: trade.takerOrderId,
        userId: trade.takerUserId,
        side: "BUY",
        price: "100",
        quantity: "5",
        remainingQuantity: "5",
      }),
    );

    const first = await service.persistEvent(trade);
    const second = await service.persistEvent(trade);

    expect(first).toMatchObject({
      status: "processed",
      writes: [
        "fills.create_many",
        "orders.update_maker_after_trade",
        "orders.update_taker_after_trade",
        "balance.unlock_maker",
        "balance.unlock_taker",
        "positions.upsert_maker_after_trade",
        "positions.upsert_taker_after_trade",
        "processed_events.create",
      ],
    });
    expect(second).toMatchObject({
      status: "skipped",
      writes: [],
    });
    expect([...store.state.fills.values()]).toHaveLength(2);
    expect(store.state.fills.get("trade-1:maker")).toMatchObject({
      orderId: "ask-1",
      userId: "maker",
      liquidityRole: "MAKER",
      price: "100",
      quantity: "5",
      notional: "500",
    });
    expect(store.state.fills.get("trade-1:taker")).toMatchObject({
      orderId: "bid-1",
      userId: "taker",
      liquidityRole: "TAKER",
    });
    expect(store.state.orders.get("ask-1")).toMatchObject({
      status: "FILLED",
      remainingQuantity: "0",
    });
    expect(store.state.orders.get("bid-1")).toMatchObject({
      status: "FILLED",
      remainingQuantity: "0",
    });
    expect(store.state.positions.get("maker:BTC-PERP")).toMatchObject({
      quantity: "-5",
      entryPrice: "100",
      side: "SHORT",
    });
    expect(store.state.positions.get("taker:BTC-PERP")).toMatchObject({
      quantity: "5",
      entryPrice: "100",
      side: "LONG",
    });
    expect(store.state.processedEvents.size).toBe(1);
  });

  it("updates rejected and cancelled order statuses idempotently", async () => {
    const store = new InMemoryPersistenceStore();
    const service = new PersistenceService(store);

    store.seedOrder(
      pendingOrder({
        id: "order-1",
        userId: "user-1",
        side: "BUY",
        price: "99",
        quantity: "2",
        remainingQuantity: "2",
      }),
    );

    await service.persistEvent(orderRejectedEvent());
    await service.persistEvent(orderRejectedEvent());

    expect(store.state.orders.get("order-1")).toMatchObject({
      status: "REJECTED",
      rejectionReason: "INVALID_QUANTITY",
    });
    expect(store.state.processedEvents.size).toBe(1);

    store.seedOrder(
      pendingOrder({
        id: "order-2",
        userId: "user-1",
        side: "SELL",
        price: "101",
        quantity: "3",
        remainingQuantity: "3",
      }),
    );

    await service.persistEvent(orderCancelledEvent());

    expect(store.state.orders.get("order-2")).toMatchObject({
      status: "CANCELLED",
      remainingQuantity: "3",
    });
  });
});

describe("outbox helper", () => {
  it("creates pending outbox events with stable audit fields", () => {
    const now = new Date(NOW);

    const event = createOutboxEvent({
      id: "outbox-1",
      aggregateType: "order",
      aggregateId: "order-1",
      type: "order.created",
      payload: { orderId: "order-1" },
      now,
    });

    expect(event).toEqual({
      id: "outbox-1",
      aggregateType: "order",
      aggregateId: "order-1",
      type: "order.created",
      payload: { orderId: "order-1" },
      status: "PENDING",
      attempts: 0,
      lastError: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  });
});

function pendingOrder(overrides: Partial<OrderWrite>): OrderWrite {
  const now = new Date(NOW);

  return {
    id: overrides.id ?? "order-1",
    userId: overrides.userId ?? "user-1",
    marketId: overrides.marketId ?? MARKET,
    side: overrides.side ?? "BUY",
    type: overrides.type ?? "LIMIT",
    timeInForce: overrides.timeInForce ?? "GTC",
    price: overrides.price ?? "100",
    quantity: overrides.quantity ?? "1",
    remainingQuantity: overrides.remainingQuantity ?? "1",
    reduceOnly: overrides.reduceOnly ?? false,
    postOnly: overrides.postOnly ?? false,
    status: overrides.status ?? "PENDING",
    rejectionReason: overrides.rejectionReason,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function tradeExecutedEvent(): TradeExecuted {
  return {
    eventId: "event-trade-1",
    commandId: "cmd-bid-1",
    market: MARKET,
    sequence: 10,
    timestamp: NOW,
    type: "trade.executed",
    tradeId: "trade-1",
    makerOrderId: "ask-1",
    takerOrderId: "bid-1",
    makerUserId: "maker",
    takerUserId: "taker",
    makerSide: "sell",
    takerSide: "buy",
    priceTicks: 100,
    qtyLots: 5,
    makerOrderRemainingQtyLots: 0,
    takerOrderRemainingQtyLots: 0,
  };
}

function orderRejectedEvent(): EngineEvent {
  return {
    eventId: "event-rejected-1",
    commandId: "cmd-order-1",
    market: MARKET,
    sequence: 1,
    timestamp: NOW,
    type: "order.rejected",
    orderId: "order-1",
    reason: "INVALID_QUANTITY",
  };
}

function orderCancelledEvent(): EngineEvent {
  return {
    eventId: "event-cancelled-1",
    commandId: "cmd-order-2",
    market: MARKET,
    sequence: 2,
    timestamp: NOW,
    type: "order.cancelled",
    orderId: "order-2",
    remainingQtyLots: 3,
  };
}
