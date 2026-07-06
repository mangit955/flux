import type {
  FillWrite,
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

    const balance = await this.tx.balance.findUnique({
      where: {
        userId_asset: {
          userId,
          asset,
        },
      },
    });

    if (!balance) {
      console.warn(`⚠️  Balance not found for user ${userId}, asset ${asset}`);
      return;
    }

    const currentLocked = Number((balance as { locked: unknown }).locked);
    const newLocked = Math.max(0, currentLocked - amount);

    await this.tx.balance.update({
      where: {
        userId_asset: {
          userId,
          asset,
        },
      },
      data: {
        locked: String(newLocked),
      },
    });

    console.log(`🔓 Unlocked ${amount.toFixed(2)} ${asset} for user ${userId} (remaining locked: ${newLocked.toFixed(2)})`);
  }
}
