import { describe, expect, it } from "bun:test";
import { ZERO, money, roundUpMoney } from "../../risk/src/index";
import { PersistenceService } from "./persistence-service";
import type { EngineEvent } from "../../matching-engine/index";
import type { OrderWrite } from "./records";
import { InMemoryPersistenceStore } from "./testing/in-memory-persistence-store";

/**
 * The invariants that unit tests on pure functions cannot reach.
 *
 * These exercise the settlement path end to end against the in-memory port, with values chosen
 * so that a float implementation drifts: every quantity and rate here is exactly representable
 * in base 10 and not in base 2.
 */

const MARKET = "BTC-PERP";
const NOW = 1_700_000_000_000;

describe("money invariants", () => {
  it("keeps locked <= total and returns to exactly zero across mixed-leverage cycles", async () => {
    // A deterministic pseudo-random walk: reproducible, but not a hand-picked happy path.
    let seed = 42;
    const nextInt = (bound: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };

    const store = new InMemoryPersistenceStore();
    const total = money(10_000);
    store.seedBalance({ userId: "user-1", asset: "USDC", total, locked: ZERO });
    const service = new PersistenceService(store);

    let locked = ZERO;

    for (let index = 0; index < 200; index += 1) {
      const leverage = [1, 3, 5, 7, 10, 20][nextInt(6)]!;
      // Thirds and sevenths of a non-representable quantity: the values that drift.
      // Quantized exactly as `submitOrder` does, so the amount locked and the amount recorded
      // on the order row are the same number — which is the property being tested.
      const lockedMargin = roundUpMoney(
        money("0.1").mul(money(1 + nextInt(9))).div(leverage),
      );
      const orderId = `order-${index}`;

      locked = locked.add(lockedMargin);
      store.seedBalance({ userId: "user-1", asset: "USDC", total, locked });
      store.seedOrder(
        pendingOrder({
          id: orderId,
          leverage,
          lockedMargin: lockedMargin.toFixed(18),
          // Half the orders are market orders, whose price is null — the case that used to
          // release nothing at all.
          price: index % 2 === 0 ? null : "1000",
          type: index % 2 === 0 ? "MARKET" : "LIMIT",
        }),
      );

      expect(store.getBalance("user-1", "USDC")!.locked.lte(total)).toBe(true);

      await service.persistEvent(orderCancelledEvent(orderId, index));

      locked = store.getBalance("user-1", "USDC")!.locked;
      expect(locked.lte(total)).toBe(true);
      expect(locked.isNegative()).toBe(false);
    }

    // Exactly zero, not merely close: `roundFinancial` used to leave a residue here.
    expect(locked.isZero()).toBe(true);
    expect(locked.toFixed()).toBe("0");
  });

  it("settles repeated fees and PnL to an exact total", async () => {
    const store = tradingStore();
    const service = new PersistenceService(store);

    // 100 round trips at a price and size that are not float-representable.
    for (let index = 0; index < 100; index += 1) {
      await service.persistEvent(tradeEvent(`open-${index}`, "BUY", "59.91", "0.1"));
      await service.persistEvent(tradeEvent(`close-${index}`, "SELL", "59.91", "0.1"));
    }

    // Each leg: notional 5.991. Taker fee 0.0005 → 0.0029955; maker fee 0.0002 → 0.0011982.
    // 200 legs each, no PnL because every round trip closes at its entry price.
    const takerFees = money("0.0029955").mul(200);
    const makerFees = money("0.0011982").mul(200);

    expect(store.getBalance("taker", "USDC")!.total.toFixed()).toBe(
      money(1_000).sub(takerFees).toFixed(),
    );
    expect(store.getBalance("maker", "USDC")!.total.toFixed()).toBe(
      money(1_000).sub(makerFees).toFixed(),
    );
    // Spelled out, so the expectation is a fixed value rather than the same expression twice.
    // At this magnitude the old `roundFinancial(12)` path also landed here; where it fails is
    // the balance size in the next test.
    expect(store.getBalance("taker", "USDC")!.total.toFixed()).toBe("999.4009");
    expect(store.getBalance("maker", "USDC")!.total.toFixed()).toBe("999.76036");

    // Both sides closed flat, so realized PnL is exactly the fees paid and the position is zero.
    expect(store.state.positions.get("taker:BTC-PERP")!.quantity).toBe(
      "0.000000000000000000",
    );
  });

  it("stays exact where a large balance exhausts float precision", async () => {
    // A float carries ~15-17 significant digits in total, so a billion-unit balance cannot
    // also resolve a 1e-7 fee. Debiting 100 such fees gives 999999999.9999881 under the old
    // path against an exact 999999999.99999 — a 1.9e-6 discrepancy created out of nothing,
    // and one `roundFinancial(12)` cannot repair because the digits are already gone.
    const store = new InMemoryPersistenceStore();
    store.seedBalance({
      userId: "whale",
      asset: "USDC",
      total: money(1_000_000_000),
      locked: ZERO,
    });

    let balance = money(1_000_000_000);
    for (let index = 0; index < 100; index += 1) {
      balance = await store
        .transaction(async (tx) => tx.adjustBalanceTotal("whale", "USDC", money("-0.0000001")));
    }

    expect(balance.toFixed()).toBe("999999999.99999");
  });

  it("writes every money column at the full column scale, never in exponential notation", async () => {
    const store = tradingStore();
    const service = new PersistenceService(store);

    // A fee small enough that String() would have produced "1e-7"-style output.
    await service.persistEvent(tradeEvent("tiny", "BUY", "0.001", "0.001"));

    for (const fill of store.state.fills.values()) {
      for (const column of [fill.price, fill.quantity, fill.notional, fill.fee, fill.realizedPnl]) {
        expect(column).not.toContain("e");
        expect(column.split(".")[1]).toHaveLength(18);
      }
    }
  });
});

function tradingStore(): InMemoryPersistenceStore {
  const store = new InMemoryPersistenceStore();

  store.seedBalance({
    userId: "maker",
    asset: "USDC",
    total: money(1_000),
    locked: ZERO,
  });
  store.seedBalance({
    userId: "taker",
    asset: "USDC",
    total: money(1_000),
    locked: ZERO,
  });

  return store;
}

function pendingOrder(overrides: {
  id: string;
  leverage?: number;
  lockedMargin?: string;
  price?: string | null;
  type?: "MARKET" | "LIMIT";
}): OrderWrite {
  const now = new Date(NOW);

  return {
    id: overrides.id,
    userId: "user-1",
    marketId: MARKET,
    side: "BUY",
    type: overrides.type ?? "LIMIT",
    timeInForce: "GTC",
    price: overrides.price === undefined ? "100" : overrides.price,
    quantity: "1",
    remainingQuantity: "1",
    lockedMargin: overrides.lockedMargin,
    leverage: overrides.leverage,
    reduceOnly: false,
    postOnly: false,
    status: "PENDING",
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
  };
}

function orderCancelledEvent(orderId: string, sequence: number): EngineEvent {
  return {
    eventId: `event-cancelled-${orderId}`,
    commandId: `cmd-${orderId}`,
    market: MARKET,
    sequence,
    timestamp: NOW,
    type: "order.cancelled",
    orderId,
    remainingQtyLots: 1,
  };
}

function tradeEvent(
  id: string,
  takerSide: "BUY" | "SELL",
  price: string,
  quantity: string,
): EngineEvent {
  return {
    eventId: `event-${id}`,
    commandId: `cmd-${id}`,
    market: MARKET,
    sequence: 1,
    timestamp: NOW,
    type: "trade.executed",
    tradeId: `trade-${id}`,
    makerOrderId: `ask-${id}`,
    takerOrderId: `bid-${id}`,
    makerUserId: "maker",
    takerUserId: "taker",
    makerSide: takerSide === "BUY" ? "sell" : "buy",
    takerSide: takerSide === "BUY" ? "buy" : "sell",
    priceTicks: Number(price),
    qtyLots: Number(quantity),
    makerOrderRemainingQtyLots: 0,
    takerOrderRemainingQtyLots: 0,
  };
}
