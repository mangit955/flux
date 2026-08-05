export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

export type DurableOrderSide = "BUY" | "SELL";
export type DurableOrderType = "MARKET" | "LIMIT";
export type DurableTimeInForce = "GTC" | "IOC";
export type DurableOrderStatus =
  | "PENDING"
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED";
export type DurableLiquidityRole = "MAKER" | "TAKER";
export type DurableLedgerEntryType =
  | "DEPOSIT"
  | "WITHDRAW"
  | "TRADING_FEE"
  | "REALIZED_PNL"
  | "FUNDING_PAYMENT"
  | "LIQUIDATION_LOSS"
  | "INSURANCE_FUND_TRANSFER"
  | "INSURANCE_FUND_CREDIT"
  | "ADL_SETTLEMENT";
export type OutboxEventStatus = "PENDING" | "PUBLISHED" | "FAILED";
export type DurableLiquidationStatus =
  | "TRIGGERED"
  | "LIQUIDATING"
  | "CLOSED"
  | "INSURANCE_FUND_USED"
  | "ADL_USED"
  | "FAILED";

export interface OrderWrite {
  id: string;
  userId: string;
  marketId: string;
  side: DurableOrderSide;
  type: DurableOrderType;
  timeInForce: DurableTimeInForce;
  price: string | null;
  quantity: string;
  remainingQuantity: string;
  /** Collateral reserved for this order at submit time; released verbatim when it terminates. */
  lockedMargin?: string;
  leverage?: number;
  reduceOnly: boolean;
  postOnly: boolean;
  status: DurableOrderStatus;
  rejectionReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderStatusUpdate {
  orderId: string;
  status: DurableOrderStatus;
  remainingQuantity?: string;
  rejectionReason?: string | null;
  updatedAt: Date;
}

export interface FillWrite {
  id: string;
  tradeId: string;
  orderId: string;
  userId: string;
  marketId: string;
  side: DurableOrderSide;
  liquidityRole: DurableLiquidityRole;
  price: string;
  quantity: string;
  notional: string;
  fee: string;
  realizedPnl: string;
  eventId: string;
  createdAt: Date;
}

export interface LedgerEntryWrite {
  id: string;
  /**
   * Null for entries that move exchange money rather than a user's — the insurance-fund side of a
   * liquidation. The column is nullable (`prisma/schema.prisma`, `LedgerEntry.userId String?`).
   */
  userId: string | null;
  asset: string;
  type: DurableLedgerEntryType;
  amount: string;
  balanceAfter: string;
  referenceId?: string | null;
  createdAt: Date;
}

export interface MarketWrite {
  marketId: string;
  quoteAsset: string;
  tickSize: string;
  lotSize: string;
  maxLeverage: number;
  initialMarginRate: string;
  maintenanceMarginRate: string;
  makerFeeRate: string;
  takerFeeRate: string;
}

export interface PositionWrite {
  userId: string;
  marketId: string;
  side: "LONG" | "SHORT" | "FLAT";
  quantity: string;
  entryPrice: string;
  realizedPnl: string;
  leverage: number;
  updatedAt: Date;
}

export interface FundingPaymentWrite {
  id: string;
  userId: string;
  marketId: string;
  positionQuantity: string;
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  paymentAmount: string;
  fundingTime: Date;
  eventId: string;
  createdAt: Date;
}

export interface LiquidationWrite {
  id: string;
  userId: string;
  marketId: string;
  positionQuantity: string;
  markPrice: string;
  maintenanceMargin: string;
  accountEquity: string;
  status: DurableLiquidationStatus;
  insuranceFundUsed: string;
  adlUsed: string;
  eventId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProcessedEventWrite {
  eventId: string;
  eventType: string;
  stream?: string;
  streamId?: string;
  marketId?: string;
  raw: JsonValue;
  processedAt: Date;
}

export interface OutboxEventWrite {
  id: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: JsonValue;
  status: OutboxEventStatus;
  attempts: number;
  lastError: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
