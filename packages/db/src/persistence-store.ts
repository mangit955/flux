import type { Money } from "../../risk/src/index";
import type {
  FillWrite,
  LedgerEntryWrite,
  MarketWrite,
  OrderStatusUpdate,
  OrderWrite,
  PositionWrite,
  ProcessedEventWrite,
} from "./records";

export interface PersistenceStore {
  transaction<T>(
    callback: (tx: PersistenceTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface PersistenceTransaction {
  findProcessedEvent(eventId: string): Promise<ProcessedEventWrite | null>;
  createProcessedEvent(event: ProcessedEventWrite): Promise<void>;
  findMarket(marketId: string): Promise<MarketWrite | null>;
  findPosition(userId: string, marketId: string): Promise<PositionWrite | null>;
  upsertOrder(order: OrderWrite): Promise<void>;
  updateOrderStatus(update: OrderStatusUpdate): Promise<void>;
  createFills(fills: FillWrite[]): Promise<void>;
  upsertPosition(position: PositionWrite): Promise<void>;
  findOrder(orderId: string): Promise<OrderWrite | null>;
  unlockBalanceForOrder(userId: string, asset: string, amount: Money): Promise<void>;
  clearOrderLockedMargin(orderId: string, updatedAt: Date): Promise<void>;
  /** Applies a signed delta to `balance.total`, creating the row if absent. Returns the new total. */
  adjustBalanceTotal(userId: string, asset: string, delta: Money): Promise<Money>;
  createLedgerEntry(entry: LedgerEntryWrite): Promise<void>;
}
