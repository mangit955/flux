import { describe, expect, it } from "bun:test";
import {
  MatchingEngine,
  type EngineEvent,
  type TradeExecuted,
} from "../../matching-engine/index";
import { createOutboxEvent } from "./outbox";
import { PersistenceService } from "./persistence-service";
import type { OrderWrite } from "./records";
import { money } from "../../risk/src/index";
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
      price: "100.000000000000000000",
      quantity: "5.000000000000000000",
      remainingQuantity: "5.000000000000000000",
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
        "positions.upsert_maker_after_trade",
        "positions.upsert_taker_after_trade",
        "fills.create_many",
        "orders.update_maker_after_trade",
        "orders.update_taker_after_trade",
        "balance.unlock_maker",
        "balance.unlock_taker",
        "balance.settle_maker",
        "balance.settle_taker",
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
      price: "100.000000000000000000",
      quantity: "5.000000000000000000",
      notional: "500.000000000000000000",
    });
    expect(store.state.fills.get("trade-1:taker")).toMatchObject({
      orderId: "bid-1",
      userId: "taker",
      liquidityRole: "TAKER",
    });
    expect(store.state.orders.get("ask-1")).toMatchObject({
      status: "FILLED",
      remainingQuantity: "0.000000000000000000",
    });
    expect(store.state.orders.get("bid-1")).toMatchObject({
      status: "FILLED",
      remainingQuantity: "0.000000000000000000",
    });
    expect(store.state.positions.get("maker:BTC-PERP")).toMatchObject({
      quantity: "-5.000000000000000000",
      entryPrice: "100.000000000000000000",
      side: "SHORT",
    });
    expect(store.state.positions.get("taker:BTC-PERP")).toMatchObject({
      quantity: "5.000000000000000000",
      entryPrice: "100.000000000000000000",
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
      remainingQuantity: "3.000000000000000000",
    });
  });
});

describe("PersistenceService margin release", () => {
  it("releases the recorded margin for a market order, whose price is null", async () => {
    // TODO #7: the old code recomputed the release from `order.price`, which is null for every
    // market order, so `Number(null || 0)` made every one of these leak its whole reserve.
    const store = storeWithBalance({ locked: 150 });
    const service = new PersistenceService(store);

    store.seedOrder(
      pendingOrder({
        id: "order-market",
        type: "MARKET",
        price: null,
        quantity: "5",
        remainingQuantity: "5",
        lockedMargin: "150",
      }),
    );

    await service.persistEvent(
      orderExpiredEvent("order-market", 5, "MARKET_LIQUIDITY_EXHAUSTED"),
    );

    expect(balanceOf(store, "user-1")).toEqual({ locked: "0", total: "1000" });
    expect(store.state.orders.get("order-market")).toMatchObject({
      status: "EXPIRED",
      lockedMargin: "0",
    });
  });

  it("releases exactly what a 20x order locked, not a leverage-10 reconstruction", async () => {
    // TODO #6: the old code hardcoded `leverage = 10`, so a 20x order was refunded 2x its lock.
    // The 200 of padding represents other orders' reserves — without it, over-release is hidden
    // by the `Math.max(0, ...)` clamp in the store.
    const store = storeWithBalance({ locked: 250 });
    const service = new PersistenceService(store);

    store.seedOrder(
      pendingOrder({
        id: "order-2",
        price: "1000",
        quantity: "1",
        remainingQuantity: "1",
        leverage: 20,
        lockedMargin: "50",
      }),
    );

    await service.persistEvent(orderCancelledEvent("order-2", 1));

    expect(balanceOf(store, "user-1").locked).toBe("200");
  });

  it("releases against the market's quote asset, not a hardcoded USDC", async () => {
    // TODO #8.
    const store = storeWithBalance({ asset: "USDT", locked: 40 });
    store.seedBalance({ userId: "user-1", asset: "USDC", total: money(1_000), locked: money(40) });
    store.seedMarket({
      marketId: MARKET,
      quoteAsset: "USDT",
      tickSize: "0.1",
      lotSize: "0.001",
      maxLeverage: 20,
      initialMarginRate: "0.05",
      maintenanceMarginRate: "0.005",
      makerFeeRate: "0.0002",
      takerFeeRate: "0.0005",
    });
    const service = new PersistenceService(store);

    store.seedOrder(pendingOrder({ id: "order-3", lockedMargin: "40" }));

    await service.persistEvent(orderCancelledEvent("order-3", 1));

    expect(balanceOf(store, "user-1", "USDT").locked).toBe("0");
    expect(balanceOf(store, "user-1").locked).toBe("40");
  });

  it("releases a partially filled order's full reserve once, on the terminal event", async () => {
    const store = storeWithBalance({ locked: 100 });
    const service = new PersistenceService(store);
    const trade = tradeExecutedEvent();

    store.seedOrder(
      pendingOrder({
        id: trade.takerOrderId,
        userId: "taker",
        side: "BUY",
        price: "100",
        quantity: "10",
        remainingQuantity: "10",
        lockedMargin: "100",
      }),
    );
    store.seedOrder(
      pendingOrder({
        id: trade.makerOrderId,
        userId: "maker",
        side: "SELL",
        price: "100",
        quantity: "5",
        remainingQuantity: "5",
      }),
    );
    // 300 = this order's 100 reserve plus 200 held by other orders, so an over- or
    // under-release is visible rather than clamped at zero.
    store.seedBalance({ userId: "taker", asset: "USDC", total: money(1_000), locked: money(300) });

    // Partial fill leaves the taker PARTIALLY_FILLED, so nothing is released yet.
    await service.persistEvent({ ...trade, takerOrderRemainingQtyLots: 5 });
    expect(balanceOf(store, "taker").locked).toBe("300");

    // The engine then expires the unfilled remainder of an IOC/market taker.
    await service.persistEvent(orderExpiredEvent(trade.takerOrderId, 5, "IOC_UNFILLED"));
    expect(balanceOf(store, "taker").locked).toBe("200");

    // A second terminal event for the same order must not release again.
    await service.persistEvent({
      ...orderCancelledEvent(trade.takerOrderId, 0),
      eventId: "event-cancelled-dup",
    });
    expect(balanceOf(store, "taker").locked).toBe("200");
  });

  it("keeps locked <= total across mixed-leverage lock/release cycles", async () => {
    const store = storeWithBalance({ locked: 0 });
    const service = new PersistenceService(store);
    const orders = [
      { id: "cycle-1", leverage: 5, lockedMargin: "200", price: "1000" as string | null },
      { id: "cycle-2", leverage: 10, lockedMargin: "100", price: "1000" as string | null },
      { id: "cycle-3", leverage: 20, lockedMargin: "50", price: null as string | null },
    ];
    const total = store.getBalance("user-1", "USDC")!.total;
    let locked = money(0);

    for (const [index, spec] of orders.entries()) {
      // Lock, the way submitOrder does.
      locked = locked.add(money(spec.lockedMargin));
      store.seedBalance({ userId: "user-1", asset: "USDC", total, locked });
      store.seedOrder(
        pendingOrder({
          id: spec.id,
          type: spec.price == null ? "MARKET" : "LIMIT",
          price: spec.price,
          leverage: spec.leverage,
          lockedMargin: spec.lockedMargin,
        }),
      );

      expect(store.getBalance("user-1", "USDC")!.locked.lte(total)).toBe(true);

      await service.persistEvent({
        ...orderCancelledEvent(spec.id, 1),
        eventId: `event-cycle-${index}`,
      });

      locked = store.getBalance("user-1", "USDC")!.locked;
      expect(locked.lte(total)).toBe(true);
    }

    expect(locked.isZero()).toBe(true);
  });

  it("opens the position at the order's leverage rather than a hardcoded 10", async () => {
    const store = storeWithBalance({ locked: 0 });
    const service = new PersistenceService(store);
    const trade = tradeExecutedEvent();

    store.seedOrder(
      pendingOrder({ id: trade.makerOrderId, userId: "maker", side: "SELL", quantity: "5", remainingQuantity: "5", leverage: 20 }),
    );
    store.seedOrder(
      pendingOrder({ id: trade.takerOrderId, userId: "taker", side: "BUY", quantity: "5", remainingQuantity: "5", leverage: 5 }),
    );

    await service.persistEvent(trade);

    expect(store.state.positions.get("maker:BTC-PERP")).toMatchObject({ leverage: 20 });
    expect(store.state.positions.get("taker:BTC-PERP")).toMatchObject({ leverage: 5 });
  });
});

describe("PersistenceService fee and PnL settlement", () => {
  // The seeded BTC-PERP market: makerFeeRate 0.0002, takerFeeRate 0.0005, quote asset USDC.
  // A 5 @ 100 trade is notional 500, so maker fee 0.1 and taker fee 0.25.
  const MAKER_FEE = 0.1;
  const TAKER_FEE = 0.25;

  it("charges the maker rate to the maker and the taker rate to the taker", async () => {
    // TODO #3: production charged nothing at all, and `estimatedFeeForOpenOrder` reserves at the
    // taker rate for both, so charging both at the taker rate would also be wrong.
    const store = tradingStore();
    const service = new PersistenceService(store);

    await service.persistEvent(tradeExecutedEvent());

    expect(balanceOf(store, "maker").total).toBe("999.9");
    expect(balanceOf(store, "taker").total).toBe("999.75");
  });

  it("records the fee on the fill row instead of a hardcoded zero", async () => {
    const store = tradingStore();
    const service = new PersistenceService(store);

    await service.persistEvent(tradeExecutedEvent());

    expect(store.state.fills.get("trade-1:maker")).toMatchObject({
      fee: "0.100000000000000000",
      realizedPnl: "0.000000000000000000",
    });
    expect(store.state.fills.get("trade-1:taker")).toMatchObject({
      fee: "0.250000000000000000",
      realizedPnl: "0.000000000000000000",
    });
  });

  it("writes a TRADING_FEE ledger entry per side", async () => {
    const store = tradingStore();
    const service = new PersistenceService(store);

    await service.persistEvent(tradeExecutedEvent());

    expect(store.state.ledgerEntries.get("trade-1:maker:fee")).toMatchObject({
      userId: "maker",
      asset: "USDC",
      type: "TRADING_FEE",
      amount: "-0.100000000000000000",
      balanceAfter: "999.900000000000000000",
      referenceId: "trade-1:maker",
    });
    expect(store.state.ledgerEntries.get("trade-1:taker:fee")).toMatchObject({
      type: "TRADING_FEE",
      amount: "-0.250000000000000000",
    });
  });

  it("credits realized PnL into the balance when a position is closed", async () => {
    // TODO #4: the PnL reached the position row but never became spendable.
    const store = tradingStore();
    const service = new PersistenceService(store);

    // Open: taker buys 5 @ 100.
    await service.persistEvent(tradeExecutedEvent());
    // Close: taker sells 5 @ 120, realizing +100 gross.
    await service.persistEvent(closingTradeEvent(120));

    // 1000 - 0.25 (opening taker fee) + 100 (gross PnL) - 0.3 (closing taker fee).
    expect(balanceOf(store, "taker").total).toBe("1099.45");
    expect(store.state.fills.get("trade-2:taker")).toMatchObject({
      realizedPnl: "100.000000000000000000",
    });
    expect(store.state.ledgerEntries.get("trade-2:taker:pnl")).toMatchObject({
      type: "REALIZED_PNL",
      amount: "100.000000000000000000",
      referenceId: "trade-2:taker",
    });
    // The position keeps PnL net of every fee it paid.
    expect(store.state.positions.get("taker:BTC-PERP")).toMatchObject({
      quantity: "0.000000000000000000",
      realizedPnl: "99.450000000000000000",
    });
  });

  it("records bad debt rather than clamping or throwing when a loss exceeds collateral", async () => {
    const store = tradingStore({ takerTotal: 50 });
    const service = new PersistenceService(store);

    await service.persistEvent(tradeExecutedEvent());
    // Price collapses to 20: the taker's long loses 400 on a 50 balance.
    await service.persistEvent(closingTradeEvent(20));

    const total = store.getBalance("taker", "USDC")!.total;

    expect(total.isNegative()).toBe(true);
    // 50 - 0.25 (opening fee) - 400 (loss) - 0.05 (closing fee).
    expect(total.toFixed()).toBe("-350.3");
  });

  it("never drives locked negative across a lock, partial fill, and close", async () => {
    const store = tradingStore();
    store.seedBalance({ userId: "taker", asset: "USDC", total: money(1_000), locked: money(100) });
    store.seedOrder(
      pendingOrder({
        id: "bid-1",
        userId: "taker",
        side: "BUY",
        quantity: "5",
        remainingQuantity: "5",
        lockedMargin: "100",
      }),
    );
    const service = new PersistenceService(store);

    await service.persistEvent({ ...tradeExecutedEvent(), takerOrderRemainingQtyLots: 2 });
    expect(store.getBalance("taker", "USDC")!.locked.isNegative()).toBe(false);

    await service.persistEvent(orderExpiredEvent("bid-1", 2, "IOC_UNFILLED"));

    const balance = store.getBalance("taker", "USDC")!;
    expect(balance.locked.isNegative()).toBe(false);
    expect(balance.locked.isZero()).toBe(true);
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

/** Balance columns as their exact decimal text, for comparison against expected values. */
function balanceOf(
  store: InMemoryPersistenceStore,
  userId: string,
  asset = "USDC",
): { total: string; locked: string } {
  const balance = store.getBalance(userId, asset);

  if (!balance) {
    throw new Error(`no ${asset} balance for ${userId}`);
  }

  return { total: balance.total.toFixed(), locked: balance.locked.toFixed() };
}

function storeWithBalance(input: {
  userId?: string;
  asset?: string;
  total?: number;
  locked: number;
}): InMemoryPersistenceStore {
  const store = new InMemoryPersistenceStore();

  store.seedBalance({
    userId: input.userId ?? "user-1",
    asset: input.asset ?? "USDC",
    total: money(input.total ?? 1_000),
    locked: money(input.locked),
  });

  return store;
}

/** A store with both sides of `tradeExecutedEvent()` funded and their orders seeded. */
function tradingStore(
  options: { takerTotal?: number } = {},
): InMemoryPersistenceStore {
  const store = new InMemoryPersistenceStore();

  store.seedBalance({ userId: "maker", asset: "USDC", total: money(1_000), locked: money(0) });
  store.seedBalance({
    userId: "taker",
    asset: "USDC",
    total: money(options.takerTotal ?? 1_000),
    locked: money(0),
  });
  store.seedOrder(
    pendingOrder({
      id: "ask-1",
      userId: "maker",
      side: "SELL",
      quantity: "5",
      remainingQuantity: "5",
    }),
  );
  store.seedOrder(
    pendingOrder({
      id: "bid-1",
      userId: "taker",
      side: "BUY",
      quantity: "5",
      remainingQuantity: "5",
    }),
  );

  return store;
}

function pendingOrder(overrides: Partial<OrderWrite>): OrderWrite {
  const now = new Date(NOW);

  return {
    id: overrides.id ?? "order-1",
    userId: overrides.userId ?? "user-1",
    marketId: overrides.marketId ?? MARKET,
    side: overrides.side ?? "BUY",
    type: overrides.type ?? "LIMIT",
    timeInForce: overrides.timeInForce ?? "GTC",
    // `?? "100"` would swallow an explicit null, which is exactly the market-order case here.
    price: overrides.price === undefined ? "100" : overrides.price,
    quantity: overrides.quantity ?? "1",
    remainingQuantity: overrides.remainingQuantity ?? "1",
    lockedMargin: overrides.lockedMargin,
    leverage: overrides.leverage,
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

/** The taker closes its long at `price`, with the roles reversed on a fresh trade id. */
function closingTradeEvent(price: number): TradeExecuted {
  return {
    ...tradeExecutedEvent(),
    eventId: "event-trade-2",
    tradeId: "trade-2",
    sequence: 11,
    makerOrderId: "ask-2",
    takerOrderId: "bid-2",
    makerSide: "buy",
    takerSide: "sell",
    priceTicks: price,
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

function orderCancelledEvent(
  orderId = "order-2",
  remainingQtyLots = 3,
): EngineEvent {
  return {
    eventId: `event-cancelled-${orderId}`,
    commandId: `cmd-${orderId}`,
    market: MARKET,
    sequence: 2,
    timestamp: NOW,
    type: "order.cancelled",
    orderId,
    remainingQtyLots,
  };
}

function orderExpiredEvent(
  orderId: string,
  remainingQtyLots: number,
  reason: "MARKET_LIQUIDITY_EXHAUSTED" | "IOC_UNFILLED",
): EngineEvent {
  return {
    eventId: `event-expired-${orderId}`,
    commandId: `cmd-${orderId}`,
    market: MARKET,
    sequence: 3,
    timestamp: NOW,
    type: "order.expired",
    orderId,
    remainingQtyLots,
    reason,
  };
}
