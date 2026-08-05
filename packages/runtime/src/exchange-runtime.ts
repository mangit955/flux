import { MatchingEngine, type NewOrderCommand } from "../../matching-engine/index";
import { checkOrderMargin, money } from "../../risk/src/index";
import { commandStream, InMemoryStreamBus, type StreamBus } from "./stream";
import { RuntimeStore } from "./store";
import { toRiskConfig, type RuntimeCommand, type RuntimeOrder } from "./types";
import { MatchingWorker, RuntimePersistenceWorker } from "./workers";
import { estimateMarketOrderRiskPrice, type MarketOrderRiskPrice } from "./market-order-risk";

/** Leverage assumed when the caller does not specify one. */
const DEFAULT_LEVERAGE = 10;

export interface SubmitOrderInput {
  userId: string;
  marketId: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  quantity: number;
  price?: number;
  timeInForce: "GTC" | "IOC";
  reduceOnly?: boolean;
  postOnly?: boolean;
  leverage?: number;
}

// WebSocket publisher interface
interface WebSocketPublisher {
  publish(input: {
    channel: string;
    market?: string;
    userId?: string;
    sequence?: number;
    data: unknown;
  }): number;
}

export class ExchangeRuntime {
  readonly store: RuntimeStore;
  readonly bus: StreamBus;
  readonly engine: MatchingEngine;
  readonly matchingWorker: MatchingWorker;
  readonly persistenceWorker: RuntimePersistenceWorker;

  constructor(input: {
    store?: RuntimeStore;
    bus?: StreamBus;
    engine?: MatchingEngine;
    clock?: () => number;
    hub?: WebSocketPublisher;
  } = {}) {
    this.store = input.store ?? new RuntimeStore();
    this.bus = input.bus ?? new InMemoryStreamBus();
    this.engine = input.engine ?? new MatchingEngine({ clock: input.clock });
    this.matchingWorker = new MatchingWorker(
      this.bus, 
      this.engine, 
      () => [...this.store.markets.keys()],
      input.hub
    );
    this.persistenceWorker = new RuntimePersistenceWorker(
      this.bus, 
      this.store, 
      () => [...this.store.markets.keys()],
      input.hub
    );
  }

  register(email: string, password: string, now = Date.now()) {
    return this.store.createUser({ email, password, now });
  }

  login(email: string, password: string) {
    return this.store.login(email, password);
  }

  deposit(userId: string, asset: string, amount: number) {
    if (amount <= 0) {
      throw new Error("deposit amount must be positive");
    }

    return this.store.adjustBalance(userId, asset, amount);
  }

  withdraw(userId: string, asset: string, amount: number) {
    if (amount <= 0) {
      throw new Error("withdraw amount must be positive");
    }

    const balance = this.store.storedBalance(userId, asset);
    if (balance.total.sub(balance.locked).lt(money(amount))) {
      throw new Error("insufficient available balance");
    }

    return this.store.adjustBalance(userId, asset, -amount);
  }

  async submitOrder(input: SubmitOrderInput, now = Date.now()): Promise<RuntimeOrder> {
    const market = this.store.markets.get(input.marketId);

    if (!market) {
      throw new Error("market not found");
    }

    const marketOrderRisk = input.type === "MARKET"
      ? this.resolveLocalMarketOrderRisk(input)
      : undefined;
    const riskPrice = marketOrderRisk?.marginPrice ?? input.price;

    if (riskPrice == null || !Number.isFinite(riskPrice) || riskPrice <= 0) {
      throw new Error("invalid order price");
    }

    const orderId = `order-${this.store.orders.size + 1}`;
    const order: RuntimeOrder = {
      id: orderId,
      userId: input.userId,
      marketId: input.marketId,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      remainingQuantity: input.quantity,
      price: input.price,
      timeInForce: input.timeInForce,
      leverage: input.leverage ?? DEFAULT_LEVERAGE,
      reduceOnly: input.reduceOnly ?? false,
      postOnly: input.postOnly ?? false,
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
    };

    const check = checkOrderMargin(
      {
        userId: input.userId,
        collateralAsset: market.quoteAsset,
        walletBalance: this.store.storedBalance(input.userId, market.quoteAsset).total,
        positions: [...this.store.positions.values()].filter(
          (position) => position.userId === input.userId,
        ),
        openOrders: [],
      },
      {
        marketId: input.marketId,
        side: input.side,
        price: money(riskPrice),
        quantity: money(input.quantity),
        reduceOnly: input.reduceOnly ?? false,
        estimatedFeeRate: money(market.takerFeeRate),
        leverage: input.leverage ?? DEFAULT_LEVERAGE,
      },
      [toRiskConfig(market)],
      [{ marketId: input.marketId, price: money(riskPrice) }],
    );

    if (!check.ok) {
      order.status = "REJECTED";
      order.rejectionReason = check.reason;
      this.store.orders.set(order.id, order);
      return order;
    }

    this.store.orders.set(order.id, order);

    const command: NewOrderCommand = {
      commandId: `cmd-${order.id}`,
      orderId: order.id,
      userId: input.userId,
      market: input.marketId,
      side: input.side === "BUY" ? "buy" : "sell",
      type: input.type === "MARKET" ? "market" : "limit",
      qtyLots: input.quantity,
      priceTicks: input.price,
      minPriceTicks: marketOrderRisk?.minExecutionPrice,
      maxPriceTicks: marketOrderRisk?.maxExecutionPrice,
      timeInForce: input.timeInForce,
      reduceOnly: input.reduceOnly,
      postOnly: input.postOnly,
      createdAt: now,
    };
    const runtimeCommand: RuntimeCommand = { type: "order.created", command };
    await this.bus.append(commandStream(input.marketId), runtimeCommand);

    return order;
  }

  async cancelOrder(userId: string, marketId: string, orderId: string): Promise<void> {
    await this.bus.append(commandStream(marketId), {
      type: "order.cancelled",
      command: {
        commandId: `cmd-cancel-${orderId}`,
        userId,
        market: marketId,
        orderId,
      },
    });
  }

  async drain(maxIterations = 20): Promise<number> {
    let processed = 0;

    for (let index = 0; index < maxIterations; index += 1) {
      const matched = await this.matchingWorker.processOnce();
      const persisted = await this.persistenceWorker.processOnce();
      processed += matched + persisted;

      if (matched + persisted === 0) {
        break;
      }
    }

    return processed;
  }

  getOrderBookSnapshot(marketId: string, depth?: number) {
    return this.engine.getBookSnapshot(marketId, depth);
  }

  private resolveLocalMarketOrderRisk(input: SubmitOrderInput): MarketOrderRiskPrice {
    const orderBook = this.engine.getBookSnapshot(input.marketId);
    const bestLevel = input.side === "BUY" ? orderBook.asks[0] : orderBook.bids[0];

    if (!bestLevel) {
      throw new Error("market order insufficient visible liquidity");
    }

    return estimateMarketOrderRiskPrice({
      side: input.side,
      quantity: input.quantity,
      orderBook,
      // Local mode has no mark-price service; the best executable level is the
      // only safe reference available to the demo runtime.
      markPrice: bestLevel.priceTicks,
    });
  }
}
