import type { ExchangeRuntime, SubmitOrderInput } from "./exchange-runtime";
import type {
  RuntimeBalance,
  RuntimeFill,
  RuntimeMarket,
  RuntimeOrder,
  RuntimePosition,
  RuntimeUser,
} from "./types";

export interface ApiRuntime {
  register(email: string, password: string): Promise<{ id: string }>;
  login(email: string, password: string): Promise<{ token: string; userId: string }>;
  loginAsGuest(): Promise<{ token: string; userId: string }>;
  authenticate(token: string | undefined): Promise<Pick<RuntimeUser, "id" | "email">>;
  listMarkets(): Promise<RuntimeMarket[]>;
  getMarket(marketId: string): Promise<RuntimeMarket | null>;
  deposit(userId: string, asset: string, amount: number): Promise<RuntimeBalance>;
  withdraw(userId: string, asset: string, amount: number): Promise<RuntimeBalance>;
  submitOrder(input: SubmitOrderInput): Promise<RuntimeOrder>;
  cancelOrder(userId: string, marketId: string, orderId: string): Promise<void>;
  listBalances(userId: string): Promise<RuntimeBalance[]>;
  listPositions(userId: string): Promise<RuntimePosition[]>;
  listOrders(userId: string): Promise<RuntimeOrder[]>;
  getOrder(userId: string, orderId: string): Promise<RuntimeOrder | null>;
  listFills(userId: string): Promise<RuntimeFill[]>;
  getOrderBook(marketId: string, depth?: number): Promise<OrderBookSnapshot>;
  drain(maxIterations?: number): Promise<number>;
}

export interface OrderBookSnapshot {
  sequence: number;
}

export class InMemoryApiRuntime implements ApiRuntime {
  constructor(readonly runtime: ExchangeRuntime) {}

  async register(email: string, password: string): Promise<{ id: string }> {
    return this.runtime.register(email, password);
  }

  async login(email: string, password: string): Promise<{ token: string; userId: string }> {
    return this.runtime.login(email, password);
  }

  async loginAsGuest(): Promise<{ token: string; userId: string }> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const email = `guest-${suffix}@guest.flux.local`;
    const password = `guest-${suffix}`;

    this.runtime.register(email, password);
    return this.runtime.login(email, password);
  }

  async authenticate(
    token: string | undefined,
  ): Promise<Pick<RuntimeUser, "id" | "email">> {
    return this.runtime.store.requireUser(token);
  }

  async listMarkets(): Promise<RuntimeMarket[]> {
    return [...this.runtime.store.markets.values()];
  }

  async getMarket(marketId: string): Promise<RuntimeMarket | null> {
    return this.runtime.store.markets.get(marketId) ?? null;
  }

  async deposit(
    userId: string,
    asset: string,
    amount: number,
  ): Promise<RuntimeBalance> {
    return this.runtime.deposit(userId, asset, amount);
  }

  async withdraw(
    userId: string,
    asset: string,
    amount: number,
  ): Promise<RuntimeBalance> {
    return this.runtime.withdraw(userId, asset, amount);
  }

  async submitOrder(input: SubmitOrderInput): Promise<RuntimeOrder> {
    return this.runtime.submitOrder(input);
  }

  async cancelOrder(
    userId: string,
    marketId: string,
    orderId: string,
  ): Promise<void> {
    await this.runtime.cancelOrder(userId, marketId, orderId);
  }

  async listBalances(userId: string): Promise<RuntimeBalance[]> {
    return this.runtime.store.balancesFor(userId);
  }

  async listPositions(userId: string): Promise<RuntimePosition[]> {
    return this.runtime.store.positionsFor(userId);
  }

  async listOrders(userId: string): Promise<RuntimeOrder[]> {
    return [...this.runtime.store.orders.values()].filter(
      (order) => order.userId === userId,
    );
  }

  async getOrder(userId: string, orderId: string): Promise<RuntimeOrder | null> {
    const order = this.runtime.store.orders.get(orderId);
    return order && order.userId === userId ? order : null;
  }

  async listFills(userId: string): Promise<RuntimeFill[]> {
    return [...this.runtime.store.fills.values()].filter(
      (fill) => fill.userId === userId,
    );
  }

  async drain(maxIterations?: number): Promise<number> {
    return this.runtime.drain(maxIterations);
  }

  async getOrderBook(marketId: string, depth?: number): Promise<OrderBookSnapshot> {
    return this.runtime.getOrderBookSnapshot(marketId, depth);
  }
}
