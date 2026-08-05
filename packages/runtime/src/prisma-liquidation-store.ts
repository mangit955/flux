import type { DurableLiquidationStatus, LiquidationWrite } from "../../db/src/index";
import {
  ZERO,
  money,
  moneyOr,
  toDecimalString,
  type InsuranceFund,
  type InsuranceFundUsage,
  type MarkPrice,
  type Money,
  type OpenOrderRisk,
  type Position,
} from "../../risk/src/index";
import type {
  LiquidationAccount,
  LiquidationSettlementState,
  LiquidationStore,
  MarkPriceSource,
  OpenLiquidation,
} from "./liquidation-store";
import type { PriceCache } from "./price-cache";

const WORKING_ORDER_STATUSES = ["PENDING", "OPEN", "PARTIALLY_FILLED"];

/**
 * Prisma access for the liquidation worker.
 *
 * Hand-rolled like `PrismaApiClient`, for the same reason: the packages never import
 * `@prisma/client`, because CI does not run `prisma generate`.
 */
export interface PrismaLiquidationClient {
  $transaction<T>(callback: (tx: PrismaLiquidationTransaction) => Promise<T>): Promise<T>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T[]>;
  market: {
    findMany(args?: unknown): Promise<unknown[]>;
  };
  balance: {
    findMany(args: unknown): Promise<unknown[]>;
    findUnique(args: {
      where: { userId_asset: { userId: string; asset: string } };
    }): Promise<unknown | null>;
  };
  order: {
    findMany(args: unknown): Promise<unknown[]>;
  };
  position: {
    findMany(args: unknown): Promise<unknown[]>;
    findUnique(args: {
      where: { userId_marketId: { userId: string; marketId: string } };
    }): Promise<unknown | null>;
  };
  liquidation: {
    findMany(args: unknown): Promise<unknown[]>;
    upsert(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
  insuranceFund: {
    findUnique(args: { where: { asset: string } }): Promise<unknown | null>;
  };
}

export interface PrismaLiquidationTransaction {
  /** Returns the number of affected rows. */
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T[]>;
  ledgerEntry: {
    create(args: { data: unknown }): Promise<unknown>;
  };
}

export class PrismaLiquidationStore implements LiquidationStore {
  constructor(private readonly client: PrismaLiquidationClient) {}

  async accountsWithOpenPositions(markets: string[]): Promise<LiquidationAccount[]> {
    if (markets.length === 0) {
      return [];
    }

    const [marketRows, positionRows] = await Promise.all([
      this.client.market.findMany({ where: { id: { in: markets } } }),
      this.client.position.findMany({
        where: { marketId: { in: markets }, NOT: { quantity: 0 } },
      }),
    ]);

    if (positionRows.length === 0) {
      return [];
    }

    const quoteAssetByMarket = new Map(
      marketRows.map((row) => [String(field(row, "id")), String(field(row, "quoteAsset"))]),
    );
    const takerFeeRateByMarket = new Map(
      marketRows.map((row) => [
        String(field(row, "id")),
        decimalOf(field(row, "takerFeeRate")),
      ]),
    );
    const userIds = [...new Set(positionRows.map((row) => String(field(row, "userId"))))];
    const [balanceRows, orderRows] = await Promise.all([
      this.client.balance.findMany({ where: { userId: { in: userIds } } }),
      this.client.order.findMany({
        where: {
          userId: { in: userIds },
          marketId: { in: markets },
          status: { in: WORKING_ORDER_STATUSES },
        },
      }),
    ]);
    const totalByUserAsset = new Map(
      balanceRows.map((row) => [
        `${String(field(row, "userId"))}:${String(field(row, "asset"))}`,
        decimalOf(field(row, "total")),
      ]),
    );
    const accounts = new Map<string, LiquidationAccount>();

    for (const row of positionRows) {
      const userId = String(field(row, "userId"));
      const marketId = String(field(row, "marketId"));
      const collateralAsset = quoteAssetByMarket.get(marketId);

      if (!collateralAsset) {
        continue;
      }

      const position: Position = {
        userId,
        marketId,
        quantity: decimalOf(field(row, "quantity")),
        entryPrice: decimalOf(field(row, "entryPrice")),
        realizedPnl: decimalOf(field(row, "realizedPnl")),
        leverage: Number(field(row, "leverage")),
      };
      const existing = accounts.get(userId);

      if (existing) {
        existing.positions.push(position);
        continue;
      }

      accounts.set(userId, {
        userId,
        collateralAsset,
        walletBalance: totalByUserAsset.get(`${userId}:${collateralAsset}`) ?? ZERO,
        positions: [position],
        openOrders: orderRows
          .filter((order) => String(field(order, "userId")) === userId)
          .map((order) => toOpenOrderRisk(order, takerFeeRateByMarket)),
      });
    }

    return [...accounts.values()];
  }

  async workingOrders(
    userId: string,
    marketId: string,
  ): Promise<{ liquidation: string[]; other: string[] }> {
    const rows = await this.client.order.findMany({
      where: { userId, marketId, status: { in: WORKING_ORDER_STATUSES } },
    });
    const liquidation: string[] = [];
    const other: string[] = [];

    for (const row of rows) {
      const id = String(field(row, "id"));

      (Boolean(field(row, "reduceOnly")) ? liquidation : other).push(id);
    }

    return { liquidation, other };
  }

  async recordLiquidation(write: LiquidationWrite): Promise<void> {
    await this.client.liquidation.upsert({
      where: { id: write.id },
      create: write,
      update: {
        positionQuantity: write.positionQuantity,
        markPrice: write.markPrice,
        maintenanceMargin: write.maintenanceMargin,
        accountEquity: write.accountEquity,
        status: write.status,
        updatedAt: write.updatedAt,
      },
    });
  }

  async findOpenLiquidations(): Promise<OpenLiquidation[]> {
    const rows = await this.client.liquidation.findMany({
      where: { status: "LIQUIDATING" },
      orderBy: { createdAt: "asc" },
    });

    if (rows.length === 0) {
      return [];
    }

    const marketIds = [...new Set(rows.map((row) => String(field(row, "marketId"))))];
    const marketRows = await this.client.market.findMany({
      where: { id: { in: marketIds } },
    });
    const quoteAssetByMarket = new Map(
      marketRows.map((row) => [String(field(row, "id")), String(field(row, "quoteAsset"))]),
    );
    const open: OpenLiquidation[] = [];

    for (const row of rows) {
      const marketId = String(field(row, "marketId"));
      const asset = quoteAssetByMarket.get(marketId);

      if (!asset) {
        continue;
      }

      open.push({
        id: String(field(row, "id")),
        userId: String(field(row, "userId")),
        marketId,
        asset,
      });
    }

    return open;
  }

  async settlementState(
    userId: string,
    marketId: string,
    asset: string,
  ): Promise<LiquidationSettlementState> {
    const [position, balance] = await Promise.all([
      this.client.position.findUnique({
        where: { userId_marketId: { userId, marketId } },
      }),
      this.client.balance.findUnique({
        where: { userId_asset: { userId, asset } },
      }),
    ]);

    return {
      positionQuantity: position ? decimalOf(field(position, "quantity")) : ZERO,
      total: balance ? decimalOf(field(balance, "total")) : ZERO,
      locked: balance ? decimalOf(field(balance, "locked")) : ZERO,
    };
  }

  async readInsuranceFund(asset: string): Promise<InsuranceFund> {
    const row = await this.client.insuranceFund.findUnique({ where: { asset } });

    return {
      asset,
      balance: row ? decimalOf(field(row, "balance")) : ZERO,
    };
  }

  async applyInsuranceFundUsage(input: {
    userId: string;
    asset: string;
    usage: InsuranceFundUsage;
    referenceId: string;
    now: Date;
  }): Promise<{ applied: Money; balanceAfter: Money }> {
    if (!input.usage.used.gt(ZERO)) {
      return { applied: ZERO, balanceAfter: await this.balanceTotal(input.userId, input.asset) };
    }

    return this.client.$transaction(async (tx) => {
      // One conditional statement, like the balance lock in `PrismaApiRuntime`: reading the fund,
      // checking it in JS and writing it back would let two draws both pass the check and pay out
      // more than the fund holds.
      const debited = await tx.$executeRawUnsafe(
        `UPDATE "insurance_funds"
            SET "balance" = "balance" - $1::numeric, "updatedAt" = NOW()
          WHERE "asset" = $2 AND "balance" >= $1::numeric`,
        toDecimalString(input.usage.used),
        input.asset,
      );

      if (debited === 0) {
        // The fund moved between the read and here, or holds less than the deficit. Report zero
        // applied; the worker records FAILED and the next cycle retries against the new balance.
        console.error(
          `[LIQUIDATION] insurance fund ${input.asset} could not cover ` +
            `${toDecimalString(input.usage.used)} for ${input.userId}`,
        );
        return { applied: ZERO, balanceAfter: ZERO };
      }

      const balanceRows = await tx.$queryRawUnsafe<{ total: unknown }>(
        `INSERT INTO "balances" ("id","userId","asset","total","locked","createdAt","updatedAt")
         VALUES ($1, $2, $3, $4::numeric, 0, NOW(), NOW())
         ON CONFLICT ("userId","asset")
         DO UPDATE SET "total" = "balances"."total" + EXCLUDED."total", "updatedAt" = NOW()
         RETURNING "total"`,
        crypto.randomUUID(),
        input.userId,
        input.asset,
        toDecimalString(input.usage.used),
      );
      const balanceAfter = moneyOr(balanceRows[0]?.total as string | null | undefined);
      const fundRows = await tx.$queryRawUnsafe<{ balance: unknown }>(
        `SELECT "balance" FROM "insurance_funds" WHERE "asset" = $1`,
        input.asset,
      );

      await tx.ledgerEntry.create({
        data: {
          id: `${input.referenceId}:insurance-fund`,
          userId: null,
          asset: input.asset,
          type: "INSURANCE_FUND_TRANSFER",
          amount: toDecimalString(input.usage.used.neg()),
          balanceAfter: toDecimalString(
            moneyOr(fundRows[0]?.balance as string | null | undefined),
          ),
          referenceId: input.referenceId,
          createdAt: input.now,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          id: `${input.referenceId}:liquidation-loss`,
          userId: input.userId,
          asset: input.asset,
          type: "LIQUIDATION_LOSS",
          amount: toDecimalString(input.usage.used),
          balanceAfter: toDecimalString(balanceAfter),
          referenceId: input.referenceId,
          createdAt: input.now,
        },
      });

      return { applied: input.usage.used, balanceAfter };
    });
  }

  async updateLiquidationSettlement(input: {
    id: string;
    status: DurableLiquidationStatus;
    insuranceFundUsed: Money;
    adlUsed: Money;
    updatedAt: Date;
  }): Promise<void> {
    await this.client.liquidation.update({
      where: { id: input.id },
      data: {
        status: input.status,
        insuranceFundUsed: toDecimalString(input.insuranceFundUsed),
        adlUsed: toDecimalString(input.adlUsed),
        updatedAt: input.updatedAt,
      },
    });
  }

  private async balanceTotal(userId: string, asset: string): Promise<Money> {
    const row = await this.client.balance.findUnique({
      where: { userId_asset: { userId, asset } },
    });

    return row ? decimalOf(field(row, "total")) : ZERO;
  }
}

/**
 * Mark prices from the Redis cache `apps/market-data` writes.
 *
 * A quote older than `maxAgeMs` is dropped rather than used: pricing a position off a stale feed is
 * how an exchange liquidates accounts that were never actually underwater. The worker skips markets
 * with no price, so this fails closed.
 */
export class PriceCacheMarkPriceSource implements MarkPriceSource {
  constructor(
    private readonly priceCache: PriceCache,
    private readonly options: { maxAgeMs?: number; clock?: () => number } = {},
  ) {}

  async markPrices(markets: string[]): Promise<MarkPrice[]> {
    const wanted = new Set(markets);
    const maxAgeMs = this.options.maxAgeMs ?? 10_000;
    const now = this.options.clock?.() ?? Date.now();
    const prices: MarkPrice[] = [];

    for (const price of await this.priceCache.getAll()) {
      if (!wanted.has(price.marketId) || !(price.markPrice > 0)) {
        continue;
      }

      if (now - price.timestamp > maxAgeMs) {
        console.warn(
          `[LIQUIDATION] skipping ${price.marketId}: mark price is ${now - price.timestamp}ms old`,
        );
        continue;
      }

      prices.push({ marketId: price.marketId, price: money(price.markPrice) });
    }

    return prices;
  }
}

function toOpenOrderRisk(
  row: unknown,
  takerFeeRateByMarket: Map<string, Money>,
): OpenOrderRisk {
  const marketId = String(field(row, "marketId"));

  return {
    marketId,
    side: field(row, "side") as OpenOrderRisk["side"],
    price: decimalOf(field(row, "price")),
    quantity: decimalOf(field(row, "remainingQuantity")),
    reduceOnly: Boolean(field(row, "reduceOnly")),
    estimatedFeeRate: takerFeeRateByMarket.get(marketId) ?? ZERO,
    leverage: Number(field(row, "leverage")),
  };
}

function field(row: unknown, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

/** Exact money from a `Decimal(36, 18)` column. */
function decimalOf(value: unknown): Money {
  return value == null ? ZERO : moneyOr(String(value));
}
