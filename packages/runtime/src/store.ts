import type {
  RuntimeBalance,
  RuntimeFill,
  RuntimeMarket,
  RuntimeOrder,
  RuntimeStateSnapshot,
  RuntimeUser,
} from "./types";
import type { Position } from "../../risk/src/index";

export class RuntimeStore {
  readonly users = new Map<string, RuntimeUser>();
  readonly sessions = new Map<string, string>();
  readonly balances = new Map<string, RuntimeBalance>();
  readonly markets = new Map<string, RuntimeMarket>();
  readonly orders = new Map<string, RuntimeOrder>();
  readonly fills = new Map<string, RuntimeFill>();
  readonly positions = new Map<string, Position>();
  readonly processedEvents = new Set<string>();

  constructor() {
    this.seedMarkets();
  }

  createUser(input: { email: string; password: string; now: number }): RuntimeUser {
    if ([...this.users.values()].some((user) => user.email === input.email)) {
      throw new Error("email already registered");
    }

    const user: RuntimeUser = {
      id: `user-${this.users.size + 1}`,
      email: input.email,
      passwordHash: input.password,
      createdAt: input.now,
    };

    this.users.set(user.id, user);
    return user;
  }

  login(email: string, password: string): { token: string; userId: string } {
    const user = [...this.users.values()].find(
      (candidate) => candidate.email === email && candidate.passwordHash === password,
    );

    if (!user) {
      throw new Error("invalid credentials");
    }

    const token = `token-${user.id}-${this.sessions.size + 1}`;
    this.sessions.set(token, user.id);
    return { token, userId: user.id };
  }

  requireUser(token: string | undefined): RuntimeUser {
    const userId = token ? this.sessions.get(token) : undefined;
    const user = userId ? this.users.get(userId) : undefined;

    if (!user) {
      throw new Error("unauthenticated");
    }

    return user;
  }

  adjustBalance(userId: string, asset: string, amount: number): RuntimeBalance {
    const key = balanceKey(userId, asset);
    const current =
      this.balances.get(key) ?? { userId, asset, total: 0, locked: 0 };
    const next = {
      ...current,
      total: Number((current.total + amount).toFixed(12)),
    };

    if (next.total < 0) {
      throw new Error("insufficient balance");
    }

    this.balances.set(key, next);
    return next;
  }

  /**
   * Applies a settlement delta (realized PnL, trading fee) to a balance.
   *
   * Unlike `adjustBalance` this permits a negative result: losses exceeding collateral are real
   * bad debt, and refusing to record them would silently forgive the shortfall. `adjustBalance`
   * keeps its guard for deposits and withdrawals, where a negative result means a bug.
   */
  settleBalance(userId: string, asset: string, amount: number): RuntimeBalance {
    const key = balanceKey(userId, asset);
    const current =
      this.balances.get(key) ?? { userId, asset, total: 0, locked: 0 };
    const next = {
      ...current,
      total: Number((current.total + amount).toFixed(12)),
    };

    if (next.total < 0) {
      console.error(
        `balance went negative for user ${userId} ${asset}: ${next.total} after ${amount}`,
      );
    }

    this.balances.set(key, next);
    return next;
  }

  getBalance(userId: string, asset: string): RuntimeBalance {
    return this.balances.get(balanceKey(userId, asset)) ?? {
      userId,
      asset,
      total: 0,
      locked: 0,
    };
  }

  getPosition(userId: string, marketId: string): Position | undefined {
    return this.positions.get(positionKey(userId, marketId));
  }

  setPosition(position: Position): void {
    this.positions.set(positionKey(position.userId, position.marketId), position);
  }

  snapshot(): RuntimeStateSnapshot {
    return {
      users: [...this.users.values()],
      balances: [...this.balances.values()],
      markets: [...this.markets.values()],
      orders: [...this.orders.values()],
      fills: [...this.fills.values()],
      positions: [...this.positions.values()],
    };
  }

  private seedMarkets(): void {
    const markets: RuntimeMarket[] = [
      {
        marketId: "BTC-PERP",
        symbol: "BTC-PERP",
        baseAsset: "BTC",
        quoteAsset: "USDC",
        tickSize: 0.1,
        lotSize: 0.001,
        maxLeverage: 20,
        initialMarginRate: 0.05,
        maintenanceMarginRate: 0.005,
        makerFeeRate: 0.0002,
        takerFeeRate: 0.0005,
        fundingIntervalHours: 8,
        fundingRateCap: 0.00375,
        status: "ACTIVE",
      },
    ];

    for (const market of markets) {
      this.markets.set(market.marketId, market);
    }
  }
}

export function balanceKey(userId: string, asset: string): string {
  return `${userId}:${asset}`;
}

export function positionKey(userId: string, marketId: string): string {
  return `${userId}:${marketId}`;
}
