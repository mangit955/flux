import { createOutboxEvent, type JsonValue } from "../../db/src/index";
import {
  ZERO,
  checkOrderMargin,
  money,
  moneyOr,
  roundUpMoney,
  toDecimalString,
  toNumber,
  type Money,
  type Position,
} from "../../risk/src/index";
import {
  hashPassword,
  issueJwt,
  validateEmail,
  verifyJwt,
  verifyPassword,
} from "./auth";
import type { ApiRuntime } from "./api-runtime";
import type { SubmitOrderInput } from "./exchange-runtime";
import type {
  RuntimeBalance,
  RuntimeFill,
  RuntimeMarket,
  RuntimeOrder,
  RuntimePosition,
  RuntimeUser,
} from "./types";
import { toRiskConfig, type RuntimeCommand } from "./types";
import type { OrderBookCache } from "./orderbook-cache";
import type { PriceCache } from "./price-cache";
import { estimateMarketOrderRiskPrice, type MarketOrderRiskPrice } from "./market-order-risk";

/** Leverage assumed when the caller does not specify one. */
const DEFAULT_LEVERAGE = 10;

export interface PrismaApiRuntimeOptions {
  client: PrismaApiClient;
  jwtSecret: string;
  clock?: () => number;
  orderBookCache?: OrderBookCache;
  priceCache?: PriceCache;
  marketOrderSlippageBufferRate?: number;
  maxMarketDataAgeMs?: number;
}

export interface PrismaApiClient {
  $transaction<T>(callback: (tx: PrismaApiTransaction) => Promise<T>): Promise<T>;
  user: PrismaApiTransaction["user"];
  market: PrismaApiTransaction["market"];
  balance: PrismaApiTransaction["balance"];
  order: PrismaApiTransaction["order"];
  fill: PrismaApiTransaction["fill"];
  position: PrismaApiTransaction["position"];
}

export interface PrismaApiTransaction {
  /** Returns the number of affected rows. Available on Prisma's interactive transaction client. */
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  user: {
    create(args: { data: { email: string; passwordHash: string } }): Promise<unknown>;
    findUnique(args: { where: { id?: string; email?: string } }): Promise<unknown | null>;
  };
  market: {
    findMany(args?: unknown): Promise<unknown[]>;
    findUnique(args: { where: { id: string } }): Promise<unknown | null>;
  };
  balance: {
    findMany(args: { where: { userId: string } }): Promise<unknown[]>;
    findUnique(args: {
      where: { userId_asset: { userId: string; asset: string } };
    }): Promise<unknown | null>;
    update(args: unknown): Promise<unknown>;
    upsert(args: unknown): Promise<unknown>;
  };
  ledgerEntry: {
    create(args: { data: unknown }): Promise<unknown>;
  };
  order: {
    create(args: { data: unknown }): Promise<unknown>;
    findUnique(args: { where: { id: string } }): Promise<unknown | null>;
    findMany(args: { where: unknown; orderBy?: unknown }): Promise<unknown[]>;
  };
  fill: {
    findMany(args: { where: { userId: string }; orderBy?: unknown }): Promise<unknown[]>;
  };
  position: {
    findMany(args: { where: { userId: string } }): Promise<unknown[]>;
  };
  outboxEvent: {
    create(args: { data: unknown }): Promise<unknown>;
  };
}

export class PrismaApiRuntime implements ApiRuntime {
  constructor(private readonly options: PrismaApiRuntimeOptions) {}

  async register(email: string, password: string): Promise<{ id: string }> {
    validateEmail(email);

    const passwordHash = await hashPassword(password);

    try {
      const user = await this.options.client.user.create({
        data: { email, passwordHash },
      });

      return { id: String(field(user, "id")) };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error("email already registered");
      }

      throw error;
    }
  }

  async login(email: string, password: string): Promise<{ token: string; userId: string }> {
    const user = await this.options.client.user.findUnique({ where: { email } });

    if (!user) {
      throw new Error("invalid credentials");
    }

    const storedHash = String(field(user, "passwordHash"));
    const isValid = await verifyPassword(password, storedHash);

    if (!isValid) {
      throw new Error("invalid credentials");
    }

    const userId = String(field(user, "id"));
    const token = await issueJwt({
      userId,
      email,
      secret: this.options.jwtSecret,
      now: this.now(),
    });

    return { token, userId };
  }

  async loginAsGuest(): Promise<{ token: string; userId: string }> {
    const guestId = crypto.randomUUID();
    const email = `guest-${guestId}@guest.flux.local`;
    const passwordHash = await hashPassword(`guest-${guestId}`);

    const user = await this.options.client.user.create({
      data: { email, passwordHash },
    });

    const userId = String(field(user, "id"));
    const token = await issueJwt({
      userId,
      email,
      secret: this.options.jwtSecret,
      now: this.now(),
    });

    return { token, userId };
  }

  async authenticate(
    token: string | undefined,
  ): Promise<Pick<RuntimeUser, "id" | "email">> {
    if (!token) {
      throw new Error("unauthenticated");
    }

    const claims = await verifyJwt(token, this.options.jwtSecret, this.now());
    const user = await this.options.client.user.findUnique({
      where: { id: claims.sub },
    });

    if (!user) {
      throw new Error("unauthenticated");
    }

    return {
      id: String(field(user, "id")),
      email: String(field(user, "email")),
    };
  }

  async listMarkets(): Promise<RuntimeMarket[]> {
    const rows = await this.options.client.market.findMany({
      orderBy: { id: "asc" },
    });

    return rows.map(mapMarket);
  }

  async getMarket(marketId: string): Promise<RuntimeMarket | null> {
    const market = await this.options.client.market.findUnique({
      where: { id: marketId },
    });

    return market ? mapMarket(market) : null;
  }

  async deposit(
    userId: string,
    asset: string,
    amount: number,
  ): Promise<RuntimeBalance> {
    if (amount <= 0) {
      throw new Error("deposit amount must be positive");
    }

    return this.options.client.$transaction(async (tx) => {
      const existing = await tx.balance.findUnique({
        where: { userId_asset: { userId, asset } },
      });
      const deposited = money(amount);
      const nextTotal = decimalOf(existing, "total").add(deposited);
      const balance = await tx.balance.upsert({
        where: { userId_asset: { userId, asset } },
        create: {
          userId,
          asset,
          total: toDecimalString(deposited),
          locked: toDecimalString(ZERO),
        },
        update: {
          total: toDecimalString(nextTotal),
        },
      });

      await tx.ledgerEntry.create({
        data: {
          userId,
          asset,
          type: "DEPOSIT",
          amount: toDecimalString(deposited),
          balanceAfter: toDecimalString(nextTotal),
        },
      });

      return mapBalance(balance);
    });
  }

  async withdraw(
    userId: string,
    asset: string,
    amount: number,
  ): Promise<RuntimeBalance> {
    if (amount <= 0) {
      throw new Error("withdraw amount must be positive");
    }

    return this.options.client.$transaction(async (tx) => {
      const existing = await tx.balance.findUnique({
        where: { userId_asset: { userId, asset } },
      });
      
      const withdrawn = money(amount);
      const total = decimalOf(existing, "total");
      const locked = decimalOf(existing, "locked");

      if (total.sub(locked).lt(withdrawn)) {
        throw new Error("insufficient available balance");
      }

      const nextTotal = total.sub(withdrawn);
      const balance = await tx.balance.update({
        where: { userId_asset: { userId, asset } },
        data: {
          total: toDecimalString(nextTotal),
        },
      });

      await tx.ledgerEntry.create({
        data: {
          userId,
          asset,
          type: "WITHDRAW",
          amount: toDecimalString(withdrawn),
          balanceAfter: toDecimalString(nextTotal),
        },
      });

      return mapBalance(balance);
    });
  }

  async submitOrder(input: SubmitOrderInput): Promise<RuntimeOrder> {
    const market = await this.getMarket(input.marketId);

    if (!market) {
      throw new Error("market not found");
    }

    const marketOrderRisk = input.type === "MARKET"
      ? await this.resolveMarketOrderRisk(input)
      : undefined;
    const riskPrice = marketOrderRisk?.marginPrice ?? input.price;

    if (riskPrice == null || !Number.isFinite(riskPrice) || riskPrice <= 0) {
      throw new Error("invalid order price");
    }

    const balance = await this.getBalance(input.userId, market.quoteAsset);
    const positions = await this.options.client.position.findMany({
      where: { userId: input.userId },
    });
    const openOrders = await this.options.client.order.findMany({
      where: {
        userId: input.userId,
        marketId: input.marketId,
        status: { in: ["OPEN", "PARTIALLY_FILLED", "PENDING"] },
      },
    });
    const check = checkOrderMargin(
      {
        userId: input.userId,
        collateralAsset: market.quoteAsset,
        walletBalance: money(balance.total),
        positions: positions.map(riskPosition),
        openOrders: openOrders.map((order) => ({
          marketId: String(field(order, "marketId")),
          side: field(order, "side") as "BUY" | "SELL",
          price: decimalOf(order, "price"),
          quantity: decimalOf(order, "remainingQuantity"),
          reduceOnly: Boolean(field(order, "reduceOnly")),
          estimatedFeeRate: money(market.takerFeeRate),
          leverage: input.leverage ?? DEFAULT_LEVERAGE,
        })),
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
      throw new Error(check.reason ?? "order rejected");
    }

    // Round the reservation away from zero: a lock quantized down leaves the position a
    // sub-unit under-collateralized and the exchange absorbs the difference.
    const marginToLock = roundUpMoney(
      check.requiredInitialMargin.add(check.requiredFee),
    );

    const now = this.now();
    const orderId = `order_${crypto.randomUUID()}`;
    const order = runtimeOrderFromInput(orderId, input, now);
    const command: RuntimeCommand = {
      type: "order.created",
      command: {
        commandId: `cmd-${orderId}`,
        orderId,
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
      },
    };

    await this.options.client.$transaction(async (tx) => {
      // Lock the required margin in the user's balance.
      //
      // Check and write are one statement on purpose: reading `locked`, checking availability
      // in JS, then writing it back leaves a window in which a concurrent order reads the same
      // value, so both pass the check and the second write silently overwrites the first. The
      // arithmetic also stays in Postgres `numeric` rather than round-tripping through a float.
      if (marginToLock.gt(ZERO) && !input.reduceOnly) {
        const locked = await tx.$executeRawUnsafe(
          `UPDATE "balances"
              SET "locked" = "locked" + $1::numeric, "updatedAt" = NOW()
            WHERE "userId" = $2 AND "asset" = $3
              AND "total" - "locked" >= $1::numeric`,
          toDecimalString(marginToLock),
          input.userId,
          market.quoteAsset,
        );

        if (locked === 0) {
          // Zero rows means either no balance row or not enough available; only now is it worth
          // a read to tell the two apart, since app.ts maps these messages to status codes.
          const currentBalance = await tx.balance.findUnique({
            where: {
              userId_asset: { userId: input.userId, asset: market.quoteAsset },
            },
          });

          throw new Error(
            currentBalance ? "insufficient available balance" : "balance not found",
          );
        }

        console.log(`🔒 Locked ${marginToLock.toFixed(2)} ${market.quoteAsset} for order ${orderId}`);
      }

      await tx.order.create({
        data: {
          id: order.id,
          userId: order.userId,
          marketId: order.marketId,
          side: order.side,
          type: order.type,
          timeInForce: order.timeInForce,
          price: order.price == null ? null : toDecimalString(money(order.price)),
          quantity: toDecimalString(money(order.quantity)),
          remainingQuantity: toDecimalString(money(order.remainingQuantity)),
          // Record what was actually locked so the release path never has to reconstruct it.
          lockedMargin: toDecimalString(input.reduceOnly ? ZERO : marginToLock),
          leverage: order.leverage,
          reduceOnly: order.reduceOnly,
          postOnly: order.postOnly,
          status: order.status,
          createdAt: new Date(order.createdAt),
          updatedAt: new Date(order.updatedAt),
        },
      });
      await tx.outboxEvent.create({
        data: createOutboxEvent({
          aggregateType: "order",
          aggregateId: order.id,
          type: command.type,
          payload: toJsonValue(command),
          now: new Date(now),
        }),
      });
    });

    return order;
  }

  async cancelOrder(
    userId: string,
    marketId: string,
    orderId: string,
  ): Promise<void> {
    const order = await this.options.client.order.findUnique({
      where: { id: orderId },
    });

    if (!order || String(field(order, "userId")) !== userId) {
      throw new Error("order not found");
    }

    if (!isCancellableOrderStatus(String(field(order, "status")))) {
      throw new Error("order not open");
    }

    const command: RuntimeCommand = {
      type: "order.cancelled",
      command: {
        commandId: `cmd-cancel-${orderId}`,
        userId,
        market: marketId,
        orderId,
      },
    };

    await this.options.client.$transaction(async (tx) => {
      await tx.outboxEvent.create({
        data: createOutboxEvent({
          aggregateType: "order",
          aggregateId: orderId,
          type: command.type,
          payload: toJsonValue(command),
        }),
      });
    });
  }

  async listBalances(userId: string): Promise<RuntimeBalance[]> {
    return (await this.options.client.balance.findMany({ where: { userId } }))
      .map(mapBalance);
  }

  async listPositions(userId: string): Promise<RuntimePosition[]> {
    return (await this.options.client.position.findMany({ where: { userId } }))
      .map(mapPosition);
  }

  async listOrders(userId: string): Promise<RuntimeOrder[]> {
    return (await this.options.client.order.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    })).map(mapOrder);
  }

  async getOrder(userId: string, orderId: string): Promise<RuntimeOrder | null> {
    const order = await this.options.client.order.findUnique({
      where: { id: orderId },
    });

    return order && String(field(order, "userId")) === userId
      ? mapOrder(order)
      : null;
  }

  async listFills(userId: string): Promise<RuntimeFill[]> {
    return (await this.options.client.fill.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    })).map(mapFill);
  }

  async drain(): Promise<number> {
    return 0;
  }

  async getOrderBook(marketId: string, depth?: number) {
    // Try to get orderbook from Redis cache
    if (this.options.orderBookCache) {
      try {
        const snapshot = await this.options.orderBookCache.get(marketId);
        
        if (snapshot) {
          // Limit depth if requested
          const limitedSnapshot = depth ? {
            ...snapshot,
            bids: snapshot.bids.slice(0, depth),
            asks: snapshot.asks.slice(0, depth),
          } : snapshot;
          
          return limitedSnapshot;
        }
      } catch (error) {
        console.error(`Failed to fetch orderbook from Redis cache for ${marketId}:`, error);
      }
    }
    
    // Fallback to empty orderbook if cache miss or error
    return {
      market: marketId,
      sequence: 0,
      bids: [],
      asks: [],
    };
  }

  private async getBalance(
    userId: string,
    asset: string,
  ): Promise<RuntimeBalance> {
    const balance = await this.options.client.balance.findUnique({
      where: { userId_asset: { userId, asset } },
    });

    return balance ? mapBalance(balance) : { userId, asset, total: 0, locked: 0 };
  }

  private now(): number {
    return this.options.clock?.() ?? Date.now();
  }

  private async resolveMarketOrderRisk(
    input: SubmitOrderInput,
  ): Promise<MarketOrderRiskPrice> {
    if (!this.options.orderBookCache || !this.options.priceCache) {
      throw new Error("market order risk data unavailable");
    }

    const [orderBook, price] = await Promise.all([
      this.options.orderBookCache.get(input.marketId),
      this.options.priceCache.get(input.marketId),
    ]);

    const maxAgeMs = this.options.maxMarketDataAgeMs ?? 10_000;
    if (!orderBook || !price || this.now() - price.timestamp > maxAgeMs) {
      throw new Error("market order risk data unavailable");
    }

    return estimateMarketOrderRiskPrice({
      side: input.side,
      quantity: input.quantity,
      orderBook,
      markPrice: price.markPrice,
      slippageBufferRate: this.options.marketOrderSlippageBufferRate,
    });
  }
}

function runtimeOrderFromInput(
  id: string,
  input: SubmitOrderInput,
  now: number,
): RuntimeOrder {
  return {
    id,
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
}

function mapMarket(row: unknown): RuntimeMarket {
  return {
    marketId: String(field(row, "id")),
    symbol: String(field(row, "symbol")),
    baseAsset: String(field(row, "baseAsset")),
    quoteAsset: String(field(row, "quoteAsset")),
    tickSize: decimal(row, "tickSize"),
    lotSize: decimal(row, "lotSize"),
    maxLeverage: Number(field(row, "maxLeverage")),
    initialMarginRate: decimal(row, "initialMarginRate"),
    maintenanceMarginRate: decimal(row, "maintenanceMarginRate"),
    makerFeeRate: decimal(row, "makerFeeRate"),
    takerFeeRate: decimal(row, "takerFeeRate"),
    fundingIntervalHours: Number(field(row, "fundingIntervalHours")),
    fundingRateCap: decimal(row, "fundingRateCap"),
    status: field(row, "status") === "ACTIVE" ? "ACTIVE" : "PAUSED",
  };
}

function mapBalance(row: unknown): RuntimeBalance {
  return {
    userId: String(field(row, "userId")),
    asset: String(field(row, "asset")),
    total: decimal(row, "total"),
    locked: decimal(row, "locked"),
  };
}

/** The API DTO: plain numbers, for JSON. */
function mapPosition(row: unknown): RuntimePosition {
  return {
    userId: String(field(row, "userId")),
    marketId: String(field(row, "marketId")),
    quantity: decimal(row, "quantity"),
    entryPrice: decimal(row, "entryPrice"),
    realizedPnl: decimal(row, "realizedPnl"),
    leverage: Number(field(row, "leverage")),
  };
}

/** The exact form, for the margin calculation. */
function riskPosition(row: unknown): Position {
  return {
    userId: String(field(row, "userId")),
    marketId: String(field(row, "marketId")),
    quantity: decimalOf(row, "quantity"),
    entryPrice: decimalOf(row, "entryPrice"),
    realizedPnl: decimalOf(row, "realizedPnl"),
    leverage: Number(field(row, "leverage")),
  };
}

function mapOrder(row: unknown): RuntimeOrder {
  return {
    id: String(field(row, "id")),
    userId: String(field(row, "userId")),
    marketId: String(field(row, "marketId")),
    side: field(row, "side") as RuntimeOrder["side"],
    type: field(row, "type") as RuntimeOrder["type"],
    quantity: decimal(row, "quantity"),
    remainingQuantity: decimal(row, "remainingQuantity"),
    price: nullableDecimal(row, "price"),
    timeInForce: field(row, "timeInForce") as RuntimeOrder["timeInForce"],
    leverage: Number(field(row, "leverage") ?? DEFAULT_LEVERAGE),
    reduceOnly: Boolean(field(row, "reduceOnly")),
    postOnly: Boolean(field(row, "postOnly")),
    status: field(row, "status") as RuntimeOrder["status"],
    rejectionReason: nullableString(row, "rejectionReason"),
    createdAt: dateMs(field(row, "createdAt")),
    updatedAt: dateMs(field(row, "updatedAt")),
  };
}

function mapFill(row: unknown): RuntimeFill {
  return {
    id: String(field(row, "id")),
    tradeId: String(field(row, "tradeId")),
    orderId: String(field(row, "orderId")),
    userId: String(field(row, "userId")),
    marketId: String(field(row, "marketId")),
    side: field(row, "side") as RuntimeFill["side"],
    liquidityRole: field(row, "liquidityRole") as RuntimeFill["liquidityRole"],
    price: decimal(row, "price"),
    quantity: decimal(row, "quantity"),
    notional: decimal(row, "notional"),
    fee: decimal(row, "fee"),
    realizedPnl: decimal(row, "realizedPnl"),
    createdAt: dateMs(field(row, "createdAt")),
  };
}

function field(row: unknown, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

/** Exact money from a `Decimal(36, 18)` column. Use this for anything that is computed. */
function decimalOf(row: unknown | null, key: string): Money {
  return row ? moneyOr(field(row, key) as string | null | undefined) : ZERO;
}

/**
 * A column as a plain number, for the API DTOs only.
 *
 * This is the one place precision is deliberately dropped, because `RuntimeBalance` and friends
 * are serialized to JSON for the browser. Never feed the result back into a calculation.
 */
function decimal(row: unknown | null, key: string): number {
  return toNumber(decimalOf(row, key));
}

function nullableDecimal(row: unknown, key: string): number | undefined {
  const value = field(row, key);
  return value == null ? undefined : toNumber(money(value as string));
}

function nullableString(row: unknown, key: string): string | undefined {
  const value = field(row, key);
  return value == null ? undefined : String(value);
}

function dateMs(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isCancellableOrderStatus(status: string): boolean {
  return status === "PENDING" || status === "OPEN" || status === "PARTIALLY_FILLED";
}
