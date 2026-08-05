import { describe, expect, it } from "bun:test";
import { ZERO, money, type MarkPrice, type Money } from "../../risk/src/index";
import { ExchangeRuntime } from "./exchange-runtime";
import { InMemoryLiquidationStore } from "./in-memory-liquidation-store";
import { LiquidationWorker } from "./liquidation-worker";
import type { LiquidationOrderSubmitter, MarkPriceSource } from "./liquidation-store";
import { RuntimeStore } from "./store";
import type { SubmitOrderInput } from "./exchange-runtime";
import type { RuntimeOrder } from "./types";

const MARKET = "BTC-PERP";

/** Records what the worker would have placed, without running the engine. */
class RecordingSubmitter implements LiquidationOrderSubmitter {
  readonly submitted: SubmitOrderInput[] = [];
  readonly cancelled: Array<{ userId: string; marketId: string; orderId: string }> = [];

  async submitOrder(input: SubmitOrderInput): Promise<RuntimeOrder> {
    this.submitted.push(input);

    return {
      id: `liq-order-${this.submitted.length}`,
      userId: input.userId,
      marketId: input.marketId,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      remainingQuantity: input.quantity,
      price: input.price,
      timeInForce: input.timeInForce,
      leverage: input.leverage ?? 1,
      reduceOnly: input.reduceOnly ?? false,
      postOnly: false,
      status: "PENDING",
      createdAt: 1,
      updatedAt: 1,
    };
  }

  async cancelOrder(userId: string, marketId: string, orderId: string): Promise<void> {
    this.cancelled.push({ userId, marketId, orderId });
  }
}

class StubMarkPrices implements MarkPriceSource {
  constructor(private readonly prices: MarkPrice[]) {}

  async markPrices(): Promise<MarkPrice[]> {
    return this.prices;
  }
}

function harness(markPrice: Money | null, clock = () => 1_000_000) {
  const store = new RuntimeStore();
  const liquidationStore = new InMemoryLiquidationStore(store);
  const submitter = new RecordingSubmitter();
  const worker = new LiquidationWorker({
    store: liquidationStore,
    submitter,
    markPrices: new StubMarkPrices(
      markPrice ? [{ marketId: MARKET, price: markPrice }] : [],
    ),
    markets: () => [...store.markets.values()],
    clock,
  });

  return { store, liquidationStore, submitter, worker };
}

/** A 1 BTC long at 100 on 20x leverage: 5 collateral, maintenance margin 0.5% of notional. */
function openLong(store: RuntimeStore, userId: string, walletBalance: number) {
  store.adjustBalance(userId, "USDC", walletBalance);
  store.setPosition({
    userId,
    marketId: MARKET,
    quantity: money(1),
    entryPrice: money(100),
    realizedPnl: ZERO,
    leverage: 20,
  });
}

function restOrder(store: RuntimeStore, order: Partial<RuntimeOrder> & { id: string; userId: string }) {
  store.orders.set(order.id, {
    marketId: MARKET,
    side: "BUY",
    type: "LIMIT",
    quantity: 1,
    remainingQuantity: 1,
    price: 100,
    timeInForce: "GTC",
    leverage: 20,
    reduceOnly: false,
    postOnly: false,
    status: "OPEN",
    createdAt: 1,
    updatedAt: 1,
    ...order,
  } as RuntimeOrder);
}

describe("LiquidationWorker — scanning", () => {
  it("leaves a healthy account alone", async () => {
    const { store, submitter, worker } = harness(money(100));
    openLong(store, "solvent", 5_000);

    expect(await worker.processOnce()).toBe(0);
    expect(submitter.submitted).toHaveLength(0);
  });

  it("force-closes a position below maintenance margin with a reduce-only IOC order", async () => {
    const { store, liquidationStore, submitter, worker } = harness(money(60));
    // Equity = 5 wallet + (60 - 100) unrealized = -35, well under the 0.3 maintenance margin.
    openLong(store, "underwater", 5);

    expect(await worker.processOnce()).toBe(1);
    expect(submitter.submitted).toHaveLength(1);

    const [order] = submitter.submitted;
    expect(order?.side).toBe("SELL");
    expect(order?.quantity).toBe(1);
    expect(order?.reduceOnly).toBe(true);
    expect(order?.timeInForce).toBe("IOC");
    expect(order?.type).toBe("LIMIT");
    // Mark price less the default 0.5% slippage buffer, so it crosses the book to get filled.
    expect(order?.price).toBeCloseTo(59.7, 10);
    expect(order?.leverage).toBe(20);

    const [liquidation] = [...liquidationStore.liquidations.values()];
    expect(liquidation?.status).toBe("LIQUIDATING");
    expect(liquidation?.userId).toBe("underwater");
    expect(money(liquidation!.markPrice).toFixed()).toBe("60");
  });

  it("cancels the user's own working orders before closing, so self-trade prevention cannot block the close", async () => {
    const { store, submitter, worker } = harness(money(60));
    openLong(store, "underwater", 5);
    restOrder(store, { id: "resting-1", userId: "underwater", side: "SELL" });

    expect(await worker.processOnce()).toBe(1);
    expect(submitter.cancelled).toEqual([
      { userId: "underwater", marketId: MARKET, orderId: "resting-1" },
    ]);
    expect(submitter.submitted).toHaveLength(0);
  });

  it("does not submit a second close while one is still working", async () => {
    const { store, submitter, worker } = harness(money(60));
    openLong(store, "underwater", 5);
    restOrder(store, {
      id: "liq-1",
      userId: "underwater",
      side: "SELL",
      reduceOnly: true,
      status: "PARTIALLY_FILLED",
    });

    expect(await worker.processOnce()).toBe(0);
    expect(submitter.submitted).toHaveLength(0);
  });

  it("skips a market with no fresh mark price rather than marking the position at zero", async () => {
    const { store, submitter, worker } = harness(null);
    openLong(store, "underwater", 5);

    expect(await worker.processOnce()).toBe(0);
    expect(submitter.submitted).toHaveLength(0);
  });

  it("waits out the retry interval instead of resubmitting on every tick", async () => {
    let now = 1_000_000;
    const { store, submitter, worker } = harness(money(60), () => now);
    openLong(store, "underwater", 5);

    await worker.processOnce();
    await worker.processOnce();
    expect(submitter.submitted).toHaveLength(1);

    now += 1_001;
    await worker.processOnce();
    expect(submitter.submitted).toHaveLength(2);
  });
});

describe("LiquidationWorker — settlement", () => {
  async function triggerLiquidation(walletBalance: number) {
    const context = harness(money(60));
    openLong(context.store, "underwater", walletBalance);
    await context.worker.processOnce();

    const [liquidation] = [...context.liquidationStore.liquidations.values()];
    return { ...context, liquidationId: liquidation!.id };
  }

  it("leaves the liquidation open while the position is still being closed", async () => {
    const { liquidationStore, worker, liquidationId } = await triggerLiquidation(5);

    await worker.processOnce();

    expect(liquidationStore.liquidations.get(liquidationId)?.status).toBe("LIQUIDATING");
  });

  it("closes the liquidation without touching the fund when the balance survived", async () => {
    const { store, liquidationStore, worker, liquidationId } = await triggerLiquidation(5);

    store.setPosition({
      userId: "underwater",
      marketId: MARKET,
      quantity: ZERO,
      entryPrice: ZERO,
      realizedPnl: money(-1),
      leverage: 20,
    });

    await worker.processOnce();

    expect(liquidationStore.liquidations.get(liquidationId)?.status).toBe("CLOSED");
    expect((await liquidationStore.readInsuranceFund("USDC")).balance.toFixed()).toBe("1000000");
    expect(liquidationStore.ledger).toHaveLength(0);
  });

  it("covers bad debt from the insurance fund and records both sides in the ledger", async () => {
    const { store, liquidationStore, worker, liquidationId } = await triggerLiquidation(5);

    // The close realized a 40 loss against 5 of collateral: 35 of bad debt.
    store.setPosition({
      userId: "underwater",
      marketId: MARKET,
      quantity: ZERO,
      entryPrice: ZERO,
      realizedPnl: money(-40),
      leverage: 20,
    });
    store.settleBalance("underwater", "USDC", money(-40));
    expect(store.storedBalance("underwater", "USDC").total.toFixed()).toBe("-35");

    await worker.processOnce();

    expect(store.storedBalance("underwater", "USDC").total.toFixed()).toBe("0");
    expect((await liquidationStore.readInsuranceFund("USDC")).balance.toFixed()).toBe("999965");

    const liquidation = liquidationStore.liquidations.get(liquidationId);
    expect(liquidation?.status).toBe("INSURANCE_FUND_USED");
    expect(money(liquidation!.insuranceFundUsed).toFixed()).toBe("35");

    const fundEntry = liquidationStore.ledger.find(
      (entry) => entry.type === "INSURANCE_FUND_TRANSFER",
    );
    const userEntry = liquidationStore.ledger.find(
      (entry) => entry.type === "LIQUIDATION_LOSS",
    );
    expect(fundEntry?.userId).toBeNull();
    expect(money(fundEntry!.amount).toFixed()).toBe("-35");
    expect(money(fundEntry!.balanceAfter).toFixed()).toBe("999965");
    expect(userEntry?.userId).toBe("underwater");
    expect(money(userEntry!.amount).toFixed()).toBe("35");
    expect(money(userEntry!.balanceAfter).toFixed()).toBe("0");
    expect(userEntry?.referenceId).toBe(liquidationId);
  });

  it("records FAILED and keeps the shortfall on the books when the fund cannot cover it", async () => {
    const { store, liquidationStore, worker, liquidationId } = await triggerLiquidation(5);

    liquidationStore.setInsuranceFund("USDC", money(10));
    store.setPosition({
      userId: "underwater",
      marketId: MARKET,
      quantity: ZERO,
      entryPrice: ZERO,
      realizedPnl: money(-40),
      leverage: 20,
    });
    store.settleBalance("underwater", "USDC", money(-40));

    await worker.processOnce();

    expect(liquidationStore.liquidations.get(liquidationId)?.status).toBe("FAILED");
    expect((await liquidationStore.readInsuranceFund("USDC")).balance.toFixed()).toBe("0");
    // The shortfall is not forgiven: 35 of debt, 10 covered, 25 still owed.
    expect(store.storedBalance("underwater", "USDC").total.toFixed()).toBe("-25");
  });

  it("does not sweep a negative balance while collateral is still locked", async () => {
    const { store, liquidationStore, worker, liquidationId } = await triggerLiquidation(5);

    store.setPosition({
      userId: "underwater",
      marketId: MARKET,
      quantity: ZERO,
      entryPrice: ZERO,
      realizedPnl: money(-40),
      leverage: 20,
    });
    store.settleBalance("underwater", "USDC", money(-40));
    store.setLocked("underwater", "USDC", money(1));

    await worker.processOnce();

    // Crediting now would leave locked (1) above total (0), which the money path forbids.
    expect(liquidationStore.liquidations.get(liquidationId)?.status).toBe("LIQUIDATING");
    expect(store.storedBalance("underwater", "USDC").total.toFixed()).toBe("-35");
  });
});

describe("LiquidationWorker — end to end through ExchangeRuntime", () => {
  it("force-closes an underwater position against resting liquidity", async () => {
    const runtime = new ExchangeRuntime({ clock: () => 1 });
    const maker = runtime.register("maker@example.com", "pw", 1);
    const taker = runtime.register("taker@example.com", "pw", 1);

    runtime.deposit(maker.id, "USDC", 100_000);
    runtime.deposit(taker.id, "USDC", 10);

    // The taker opens a 1 BTC long at 100 on 20x — 5 of margin against a 10 balance.
    await runtime.submitOrder(
      { userId: maker.id, marketId: MARKET, side: "SELL", type: "LIMIT", quantity: 1, price: 100, timeInForce: "GTC", leverage: 20 },
      1,
    );
    await runtime.submitOrder(
      { userId: taker.id, marketId: MARKET, side: "BUY", type: "LIMIT", quantity: 1, price: 100, timeInForce: "GTC", leverage: 20 },
      1,
    );
    await runtime.drain();

    expect(runtime.store.getPosition(taker.id, MARKET)?.quantity.toFixed()).toBe("1");

    // The maker posts a much lower bid. That trade marks the position down and provides the
    // liquidity the forced close needs.
    await runtime.submitOrder(
      { userId: maker.id, marketId: MARKET, side: "BUY", type: "LIMIT", quantity: 2, price: 90, timeInForce: "GTC", leverage: 20 },
      1,
    );
    await runtime.drain();
    runtime.store.setLastTradePrice(MARKET, money(90));

    await runtime.drain();

    const position = runtime.store.getPosition(taker.id, MARKET);
    expect(position?.quantity.toFixed()).toBe("0");

    const liquidations = [...runtime.liquidationStore.liquidations.values()];
    expect(liquidations).toHaveLength(1);
    expect(liquidations[0]?.userId).toBe(taker.id);
    expect(["CLOSED", "INSURANCE_FUND_USED"]).toContain(liquidations[0]!.status);

    for (const userId of [maker.id, taker.id]) {
      const balance = runtime.store.storedBalance(userId, "USDC");
      expect(balance.locked.lte(balance.total)).toBe(true);
    }
  });
});
