import type {
  RuntimeBalance,
  RuntimeFill,
  RuntimeMarket,
  RuntimeOrder,
  RuntimePosition,
  RuntimeStateSnapshot,
  RuntimeUser,
} from "./types";
import {
  ZERO,
  money,
  toNumber,
  type Money,
  type Position,
} from "../../risk/src/index";

/**
 * The in-memory balance state.
 *
 * Separate from `RuntimeBalance` on purpose: this is money and is held exactly, while
 * `RuntimeBalance` is the DTO the API serializes and must stay plain numbers.
 */
interface StoredBalance {
  userId: string;
  asset: string;
  total: Money;
  locked: Money;
}

export class RuntimeStore {
  readonly users = new Map<string, RuntimeUser>();
  readonly sessions = new Map<string, string>();
  private readonly storedBalances = new Map<string, StoredBalance>();
  readonly markets = new Map<string, RuntimeMarket>();
  readonly orders = new Map<string, RuntimeOrder>();
  readonly fills = new Map<string, RuntimeFill>();
  readonly positions = new Map<string, Position>();
  readonly processedEvents = new Set<string>();
  /**
   * Last traded price per market.
   *
   * Local mode has no mark-price feed — `apps/market-data` only runs against Redis — so this is
   * what the liquidation scan marks positions to, falling back to the book mid.
   */
  private readonly lastTradePrices = new Map<string, Money>();

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
    const current = this.storedBalance(userId, asset);
    const next: StoredBalance = {
      ...current,
      total: current.total.add(money(amount)),
    };

    if (next.total.isNegative()) {
      throw new Error("insufficient balance");
    }

    this.storedBalances.set(key, next);
    return toRuntimeBalance(next);
  }

  /**
   * Applies a settlement delta (realized PnL, trading fee) to a balance.
   *
   * Unlike `adjustBalance` this permits a negative result: losses exceeding collateral are real
   * bad debt, and refusing to record them would silently forgive the shortfall. `adjustBalance`
   * keeps its guard for deposits and withdrawals, where a negative result means a bug.
   */
  settleBalance(userId: string, asset: string, amount: Money): RuntimeBalance {
    const key = balanceKey(userId, asset);
    const current = this.storedBalance(userId, asset);
    const next: StoredBalance = {
      ...current,
      total: current.total.add(amount),
    };

    if (next.total.isNegative()) {
      console.error(
        `balance went negative for user ${userId} ${asset}: ${next.total.toFixed()} after ${amount.toFixed()}`,
      );
    }

    this.storedBalances.set(key, next);
    return toRuntimeBalance(next);
  }

  getBalance(userId: string, asset: string): RuntimeBalance {
    return toRuntimeBalance(this.storedBalance(userId, asset));
  }

  /** Every balance a user holds, as the API DTO. */
  balancesFor(userId: string): RuntimeBalance[] {
    return [...this.storedBalances.values()]
      .filter((balance) => balance.userId === userId)
      .map(toRuntimeBalance);
  }

  /** Exact balance, for the margin path. Never crosses the API edge. */
  storedBalance(userId: string, asset: string): StoredBalance {
    return (
      this.storedBalances.get(balanceKey(userId, asset)) ?? {
        userId,
        asset,
        total: ZERO,
        locked: ZERO,
      }
    );
  }

  setLocked(userId: string, asset: string, locked: Money): void {
    const current = this.storedBalance(userId, asset);

    this.storedBalances.set(balanceKey(userId, asset), { ...current, locked });
  }

  /** Every position a user holds, as the API DTO. */
  positionsFor(userId: string): RuntimePosition[] {
    return [...this.positions.values()]
      .filter((position) => position.userId === userId)
      .map(toRuntimePosition);
  }

  getPosition(userId: string, marketId: string): Position | undefined {
    return this.positions.get(positionKey(userId, marketId));
  }

  setPosition(position: Position): void {
    this.positions.set(positionKey(position.userId, position.marketId), position);
  }

  setLastTradePrice(marketId: string, price: Money): void {
    this.lastTradePrices.set(marketId, price);
  }

  getLastTradePrice(marketId: string): Money | undefined {
    return this.lastTradePrices.get(marketId);
  }

  snapshot(): RuntimeStateSnapshot {
    return {
      users: [...this.users.values()],
      balances: [...this.storedBalances.values()].map(toRuntimeBalance),
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

/**
 * Drop a position to plain numbers for the API and websocket.
 *
 * Without this a `Decimal` reaches `JSON.stringify`, which renders it as a *string* via
 * `toJSON()` — silently changing `1.5` to `"1.5"` on the wire.
 */
function toRuntimePosition(position: Position): RuntimePosition {
  return {
    userId: position.userId,
    marketId: position.marketId,
    quantity: toNumber(position.quantity),
    entryPrice: toNumber(position.entryPrice),
    realizedPnl: toNumber(position.realizedPnl),
    leverage: position.leverage,
  };
}

function toRuntimeBalance(balance: StoredBalance): RuntimeBalance {
  return {
    userId: balance.userId,
    asset: balance.asset,
    total: toNumber(balance.total),
    locked: toNumber(balance.locked),
  };
}

export function balanceKey(userId: string, asset: string): string {
  return `${userId}:${asset}`;
}

export function positionKey(userId: string, marketId: string): string {
  return `${userId}:${marketId}`;
}
