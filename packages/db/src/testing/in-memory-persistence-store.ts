import { Decimal, ZERO, type Money } from "../../../risk/src/index";
import type {
  FillWrite,
  LedgerEntryWrite,
  MarketWrite,
  OrderStatusUpdate,
  OrderWrite,
  PositionWrite,
  ProcessedEventWrite,
} from "../records";
import type {
  PersistenceStore,
  PersistenceTransaction,
} from "../persistence-store";

export interface InMemoryBalance {
  userId: string;
  asset: string;
  total: Money;
  locked: Money;
}

export interface InMemoryPersistenceState {
  orders: Map<string, OrderWrite>;
  fills: Map<string, FillWrite>;
  processedEvents: Map<string, ProcessedEventWrite>;
  markets: Map<string, MarketWrite>;
  positions: Map<string, PositionWrite>;
  balances: Map<string, InMemoryBalance>;
  ledgerEntries: Map<string, LedgerEntryWrite>;
}

export class InMemoryPersistenceStore implements PersistenceStore {
  readonly state: InMemoryPersistenceState = {
    orders: new Map(),
    fills: new Map(),
    processedEvents: new Map(),
    markets: new Map([
      [
        "BTC-PERP",
        {
          marketId: "BTC-PERP",
          quoteAsset: "USDC",
          tickSize: "0.1",
          lotSize: "0.001",
          maxLeverage: 20,
          initialMarginRate: "0.05",
          maintenanceMarginRate: "0.005",
          makerFeeRate: "0.0002",
          takerFeeRate: "0.0005",
        },
      ],
    ]),
    positions: new Map(),
    balances: new Map(),
    ledgerEntries: new Map(),
  };

  async transaction<T>(
    callback: (tx: PersistenceTransaction) => Promise<T>,
  ): Promise<T> {
    const draft = cloneState(this.state);
    const result = await callback(new InMemoryPersistenceTransaction(draft));

    this.state.orders = draft.orders;
    this.state.fills = draft.fills;
    this.state.processedEvents = draft.processedEvents;
    this.state.markets = draft.markets;
    this.state.positions = draft.positions;
    this.state.balances = draft.balances;
    this.state.ledgerEntries = draft.ledgerEntries;

    return result;
  }

  seedOrder(order: OrderWrite): void {
    this.state.orders.set(order.id, cloneOrder(order));
  }

  seedMarket(market: MarketWrite): void {
    this.state.markets.set(market.marketId, { ...market });
  }

  seedBalance(balance: InMemoryBalance): void {
    this.state.balances.set(balanceKey(balance.userId, balance.asset), {
      ...balance,
    });
  }

  getBalance(userId: string, asset: string): InMemoryBalance | undefined {
    const balance = this.state.balances.get(balanceKey(userId, asset));
    return balance ? { ...balance } : undefined;
  }
}

class InMemoryPersistenceTransaction implements PersistenceTransaction {
  constructor(private readonly state: InMemoryPersistenceState) {}

  async findProcessedEvent(
    eventId: string,
  ): Promise<ProcessedEventWrite | null> {
    return this.state.processedEvents.get(eventId) ?? null;
  }

  async createProcessedEvent(event: ProcessedEventWrite): Promise<void> {
    if (this.state.processedEvents.has(event.eventId)) {
      throw new Error(`Processed event already exists: ${event.eventId}`);
    }

    this.state.processedEvents.set(event.eventId, cloneProcessedEvent(event));
  }

  async findMarket(marketId: string): Promise<MarketWrite | null> {
    const market = this.state.markets.get(marketId);
    return market ? { ...market } : null;
  }

  async findPosition(
    userId: string,
    marketId: string,
  ): Promise<PositionWrite | null> {
    const position = this.state.positions.get(positionKey(userId, marketId));
    return position ? clonePosition(position) : null;
  }

  async upsertOrder(order: OrderWrite): Promise<void> {
    this.state.orders.set(order.id, cloneOrder(order));
  }

  async updateOrderStatus(update: OrderStatusUpdate): Promise<void> {
    const existing = this.state.orders.get(update.orderId);

    if (!existing) {
      return;
    }

    this.state.orders.set(update.orderId, {
      ...existing,
      status: update.status,
      remainingQuantity:
        update.remainingQuantity ?? existing.remainingQuantity,
      rejectionReason:
        update.rejectionReason === undefined
          ? existing.rejectionReason
          : update.rejectionReason,
      updatedAt: new Date(update.updatedAt),
    });
  }

  async createFills(fills: FillWrite[]): Promise<void> {
    for (const fill of fills) {
      if (!this.state.fills.has(fill.id)) {
        this.state.fills.set(fill.id, cloneFill(fill));
      }
    }
  }

  async upsertPosition(position: PositionWrite): Promise<void> {
    this.state.positions.set(
      positionKey(position.userId, position.marketId),
      clonePosition(position),
    );
  }

  async findOrder(orderId: string): Promise<OrderWrite | null> {
    const order = this.state.orders.get(orderId);
    return order ? cloneOrder(order) : null;
  }

  async unlockBalanceForOrder(userId: string, asset: string, amount: Money): Promise<void> {
    if (amount.lte(ZERO)) {
      return;
    }

    const balance = this.state.balances.get(balanceKey(userId, asset));

    if (!balance) {
      return;
    }

    if (amount.gt(balance.locked)) {
      console.error(
        `margin release exceeds locked balance for user ${userId} ${asset}: releasing ${amount}, locked ${balance.locked}`,
      );
    }

    this.state.balances.set(balanceKey(userId, asset), {
      ...balance,
      locked: Decimal.max(ZERO, balance.locked.sub(amount)),
    });
  }

  async adjustBalanceTotal(
    userId: string,
    asset: string,
    delta: Money,
  ): Promise<Money> {
    const key = balanceKey(userId, asset);
    const existing = this.state.balances.get(key) ?? {
      userId,
      asset,
      total: ZERO,
      locked: ZERO,
    };
    const total = existing.total.add(delta);

    if (total.isNegative()) {
      console.error(
        `balance went negative for user ${userId} ${asset}: ${total} after ${delta}`,
      );
    }

    this.state.balances.set(key, { ...existing, total });

    return total;
  }

  async createLedgerEntry(entry: LedgerEntryWrite): Promise<void> {
    this.state.ledgerEntries.set(entry.id, {
      ...entry,
      createdAt: new Date(entry.createdAt),
    });
  }

  async clearOrderLockedMargin(orderId: string, updatedAt: Date): Promise<void> {
    const existing = this.state.orders.get(orderId);

    if (!existing) {
      return;
    }

    this.state.orders.set(orderId, {
      ...existing,
      lockedMargin: "0",
      updatedAt: new Date(updatedAt),
    });
  }
}

function cloneState(state: InMemoryPersistenceState): InMemoryPersistenceState {
  return {
    orders: new Map(
      [...state.orders.entries()].map(([id, order]) => [id, cloneOrder(order)]),
    ),
    fills: new Map(
      [...state.fills.entries()].map(([id, fill]) => [id, cloneFill(fill)]),
    ),
    processedEvents: new Map(
      [...state.processedEvents.entries()].map(([id, event]) => [
        id,
        cloneProcessedEvent(event),
      ]),
    ),
    markets: new Map(
      [...state.markets.entries()].map(([id, market]) => [id, { ...market }]),
    ),
    positions: new Map(
      [...state.positions.entries()].map(([id, position]) => [
        id,
        clonePosition(position),
      ]),
    ),
    balances: new Map(
      [...state.balances.entries()].map(([id, balance]) => [id, { ...balance }]),
    ),
    ledgerEntries: new Map(
      [...state.ledgerEntries.entries()].map(([id, entry]) => [
        id,
        { ...entry, createdAt: new Date(entry.createdAt) },
      ]),
    ),
  };
}

function cloneOrder(order: OrderWrite): OrderWrite {
  return {
    ...order,
    createdAt: new Date(order.createdAt),
    updatedAt: new Date(order.updatedAt),
  };
}

function cloneFill(fill: FillWrite): FillWrite {
  return {
    ...fill,
    createdAt: new Date(fill.createdAt),
  };
}

function cloneProcessedEvent(event: ProcessedEventWrite): ProcessedEventWrite {
  return {
    ...event,
    processedAt: new Date(event.processedAt),
  };
}

function clonePosition(position: PositionWrite): PositionWrite {
  return {
    ...position,
    updatedAt: new Date(position.updatedAt),
  };
}

function positionKey(userId: string, marketId: string): string {
  return `${userId}:${marketId}`;
}

function balanceKey(userId: string, asset: string): string {
  return `${userId}:${asset}`;
}
