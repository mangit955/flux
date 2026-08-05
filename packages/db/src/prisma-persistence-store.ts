import type {
  FillWrite,
  LedgerEntryWrite,
  MarketWrite,
  OrderStatusUpdate,
  OrderWrite,
  PositionWrite,
  ProcessedEventWrite,
} from "./records";
import type {
  PersistenceStore,
  PersistenceTransaction,
} from "./persistence-store";

export interface PrismaClientLike {
  $transaction<T>(
    callback: (tx: PrismaTransactionLike) => Promise<T>,
  ): Promise<T>;
}

export interface PrismaTransactionLike {
  /** Returns the number of affected rows. */
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T[]>;
  processedEvent: {
    findUnique(args: { where: { eventId: string } }): Promise<unknown | null>;
    create(args: { data: ProcessedEventWrite }): Promise<unknown>;
  };
  order: {
    findUnique(args: { where: { id: string } }): Promise<unknown | null>;
    upsert(args: {
      where: { id: string };
      create: OrderWrite;
      update: Partial<OrderWrite>;
    }): Promise<unknown>;
    updateMany(args: {
      where: { id: string };
      data: Partial<OrderWrite> & { updatedAt: Date };
    }): Promise<unknown>;
  };
  market: {
    findUnique(args: { where: { id: string } }): Promise<unknown | null>;
  };
  position: {
    findUnique(args: {
      where: { userId_marketId: { userId: string; marketId: string } };
    }): Promise<unknown | null>;
    upsert(args: {
      where: { userId_marketId: { userId: string; marketId: string } };
      create: PositionWrite;
      update: Omit<PositionWrite, "userId" | "marketId">;
    }): Promise<unknown>;
  };
  fill: {
    createMany(args: {
      data: FillWrite[];
      skipDuplicates: boolean;
    }): Promise<unknown>;
  };
  balance: {
    findUnique(args: {
      where: { userId_asset: { userId: string; asset: string } };
    }): Promise<unknown | null>;
    update(args: unknown): Promise<unknown>;
  };
  ledgerEntry: {
    create(args: { data: LedgerEntryWrite }): Promise<unknown>;
  };
}

export class PrismaPersistenceStore implements PersistenceStore {
  constructor(private readonly client: PrismaClientLike) {}

  transaction<T>(
    callback: (tx: PersistenceTransaction) => Promise<T>,
  ): Promise<T> {
    return this.client.$transaction((tx) =>
      callback(new PrismaPersistenceTransaction(tx)),
    );
  }
}

class PrismaPersistenceTransaction implements PersistenceTransaction {
  constructor(private readonly tx: PrismaTransactionLike) {}

  async findProcessedEvent(
    eventId: string,
  ): Promise<ProcessedEventWrite | null> {
    const row = await this.tx.processedEvent.findUnique({
      where: { eventId },
    });

    return row as ProcessedEventWrite | null;
  }

  async createProcessedEvent(event: ProcessedEventWrite): Promise<void> {
    await this.tx.processedEvent.create({
      data: event,
    });
  }

  async findMarket(marketId: string): Promise<MarketWrite | null> {
    const row = await this.tx.market.findUnique({
      where: { id: marketId },
    });

    if (!row) {
      return null;
    }

    const market = row as {
      id: string;
      quoteAsset: string;
      tickSize: unknown;
      lotSize: unknown;
      maxLeverage: number;
      initialMarginRate: unknown;
      maintenanceMarginRate: unknown;
      makerFeeRate: unknown;
      takerFeeRate: unknown;
    };

    return {
      marketId: market.id,
      quoteAsset: market.quoteAsset,
      tickSize: String(market.tickSize),
      lotSize: String(market.lotSize),
      maxLeverage: market.maxLeverage,
      initialMarginRate: String(market.initialMarginRate),
      maintenanceMarginRate: String(market.maintenanceMarginRate),
      makerFeeRate: String(market.makerFeeRate),
      takerFeeRate: String(market.takerFeeRate),
    };
  }

  async findPosition(
    userId: string,
    marketId: string,
  ): Promise<PositionWrite | null> {
    const row = await this.tx.position.findUnique({
      where: { userId_marketId: { userId, marketId } },
    });

    if (!row) {
      return null;
    }

    const position = row as {
      userId: string;
      marketId: string;
      side: PositionWrite["side"];
      quantity: unknown;
      entryPrice: unknown;
      realizedPnl: unknown;
      leverage: number;
      updatedAt: Date;
    };

    return {
      userId: position.userId,
      marketId: position.marketId,
      side: position.side,
      quantity: String(position.quantity),
      entryPrice: String(position.entryPrice),
      realizedPnl: String(position.realizedPnl),
      leverage: position.leverage,
      updatedAt: position.updatedAt,
    };
  }

  async upsertOrder(order: OrderWrite): Promise<void> {
    await this.tx.order.upsert({
      where: { id: order.id },
      create: order,
      update: {
        userId: order.userId,
        marketId: order.marketId,
        side: order.side,
        type: order.type,
        timeInForce: order.timeInForce,
        price: order.price,
        quantity: order.quantity,
        remainingQuantity: order.remainingQuantity,
        reduceOnly: order.reduceOnly,
        postOnly: order.postOnly,
        status: order.status,
        rejectionReason: order.rejectionReason ?? null,
        updatedAt: order.updatedAt,
      },
    });
  }

  async updateOrderStatus(update: OrderStatusUpdate): Promise<void> {
    await this.tx.order.updateMany({
      where: { id: update.orderId },
      data: {
        status: update.status,
        remainingQuantity: update.remainingQuantity,
        rejectionReason: update.rejectionReason,
        updatedAt: update.updatedAt,
      },
    });
  }

  async createFills(fills: FillWrite[]): Promise<void> {
    if (fills.length === 0) {
      return;
    }

    await this.tx.fill.createMany({
      data: fills,
      skipDuplicates: true,
    });
  }

  async upsertPosition(position: PositionWrite): Promise<void> {
    await this.tx.position.upsert({
      where: {
        userId_marketId: {
          userId: position.userId,
          marketId: position.marketId,
        },
      },
      create: position,
      update: {
        side: position.side,
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        realizedPnl: position.realizedPnl,
        leverage: position.leverage,
        updatedAt: position.updatedAt,
      },
    });
  }

  async findOrder(orderId: string): Promise<OrderWrite | null> {
    const row = await this.tx.order.findUnique({
      where: { id: orderId },
    });

    if (!row) {
      return null;
    }

    return row as OrderWrite;
  }

  async unlockBalanceForOrder(userId: string, asset: string, amount: number): Promise<void> {
    if (amount <= 0) {
      return;
    }

    // Read and write in one statement, for the same reason the lock side does: a
    // read-modify-write on `locked` loses concurrent updates. The CTE takes the row lock and
    // still hands back the previous value, which is what makes the drift check below possible.
    const rows = await this.tx.$queryRawUnsafe<{ lockedBefore: unknown }>(
      `WITH prev AS (
         SELECT "id", "locked" FROM "balances"
          WHERE "userId" = $2 AND "asset" = $3
          FOR UPDATE
       )
       UPDATE "balances" b
          SET "locked" = GREATEST(0, prev."locked" - $1::numeric), "updatedAt" = NOW()
         FROM prev
        WHERE b."id" = prev."id"
       RETURNING prev."locked" AS "lockedBefore"`,
      String(amount),
      userId,
      asset,
    );

    if (rows.length === 0) {
      console.warn(`⚠️  Balance not found for user ${userId}, asset ${asset}`);
      return;
    }

    const lockedBefore = Number(rows[0]?.lockedBefore ?? 0);

    if (amount > lockedBefore) {
      // The release amount is the value recorded on the order, so a mismatch means the locked
      // column drifted from the orders that own it. Clamping hides that; log it loudly.
      // Throwing would be better, but the persistence worker acks on failure (TODO #11), so a
      // throw drops the event and strands the margin with no alarm at all.
      console.error(
        `margin release exceeds locked balance for user ${userId} ${asset}: releasing ${amount}, locked ${lockedBefore}`,
      );
    }

    console.log(`🔓 Unlocked ${amount.toFixed(2)} ${asset} for user ${userId}`);
  }

  async adjustBalanceTotal(
    userId: string,
    asset: string,
    delta: number,
  ): Promise<number> {
    // Upsert, because a user can be credited before ever holding a row for the asset. Raw SQL
    // cannot lean on Prisma's @default(cuid()), so the id is supplied here.
    const rows = await this.tx.$queryRawUnsafe<{ total: unknown }>(
      `INSERT INTO "balances" ("id","userId","asset","total","locked","createdAt","updatedAt")
       VALUES ($1, $2, $3, $4::numeric, 0, NOW(), NOW())
       ON CONFLICT ("userId","asset")
       DO UPDATE SET "total" = "balances"."total" + EXCLUDED."total", "updatedAt" = NOW()
       RETURNING "total"`,
      crypto.randomUUID(),
      userId,
      asset,
      String(delta),
    );

    const total = Number(rows[0]?.total ?? 0);

    if (total < 0) {
      // Bad debt: losses exceeded collateral. Recorded rather than refused — clamping would
      // silently forgive the shortfall, and throwing would drop the fill entirely (TODO #11).
      // The liquidation engine and insurance fund (TODO #12) are what resolve this.
      console.error(
        `balance went negative for user ${userId} ${asset}: ${total} after ${delta}`,
      );
    }

    return total;
  }

  async createLedgerEntry(entry: LedgerEntryWrite): Promise<void> {
    await this.tx.ledgerEntry.create({ data: entry });
  }

  async clearOrderLockedMargin(orderId: string, updatedAt: Date): Promise<void> {
    await this.tx.order.updateMany({
      where: { id: orderId },
      data: {
        lockedMargin: "0",
        updatedAt,
      },
    });
  }
}
