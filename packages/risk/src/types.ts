import type { Money } from "./decimal";

export type PositionSide = "LONG" | "SHORT" | "FLAT";
export type TradeSide = "BUY" | "SELL";
export type LedgerEntryType =
  | "DEPOSIT"
  | "TRADING_FEE"
  | "REALIZED_PNL"
  | "FUNDING_PAYMENT"
  | "LIQUIDATION_LOSS"
  | "INSURANCE_FUND_TRANSFER"
  | "INSURANCE_FUND_CREDIT"
  | "ADL_SETTLEMENT";
export type LiquidationStatus =
  | "TRIGGERED"
  | "LIQUIDATING"
  | "CLOSED"
  | "INSURANCE_FUND_USED"
  | "ADL_USED"
  | "FAILED";

export interface MarketRiskConfig {
  marketId: string;
  tickSize: Money;
  lotSize: Money;
  maxLeverage: number;
  initialMarginRate: Money;
  maintenanceMarginRate: Money;
  makerFeeRate: Money;
  takerFeeRate: Money;
}

export interface FundingMarketConfig {
  marketId: string;
  fundingIntervalHours: number;
  fundingRateCap: Money;
}

export interface Position {
  userId: string;
  marketId: string;
  quantity: Money;
  entryPrice: Money;
  realizedPnl: Money;
  leverage: number;
}

export interface PositionView extends Position {
  side: PositionSide;
  notional: Money;
  unrealizedPnl: Money;
  initialMargin: Money;
  maintenanceMargin: Money;
}

export interface FillInput {
  userId: string;
  marketId: string;
  side: TradeSide;
  price: Money;
  quantity: Money;
  fee: Money;
}

export interface PositionUpdateResult {
  previous: Position;
  next: Position;
  closedQuantity: Money;
  openedQuantity: Money;
  realizedPnlDelta: Money;
  feePaid: Money;
}

export interface Balance {
  userId: string;
  asset: string;
  total: Money;
  locked: Money;
}

export interface LedgerEntry {
  id: string;
  userId: string;
  asset: string;
  type: LedgerEntryType;
  amount: Money;
  balanceAfter: Money;
  referenceId?: string;
  createdAt: number;
}

export interface AccountState {
  userId: string;
  collateralAsset: string;
  walletBalance: Money;
  positions: Position[];
  openOrders: OpenOrderRisk[];
}

export interface OpenOrderRisk {
  marketId: string;
  side: TradeSide;
  price: Money;
  quantity: Money;
  reduceOnly: boolean;
  estimatedFeeRate: Money;
  leverage: number;
}

export interface MarkPrice {
  marketId: string;
  price: Money;
}

export interface FundingPriceInput {
  marketId: string;
  markPrice: Money;
  indexPrice: Money;
  timestamp: number;
}

export interface FundingPayment {
  id: string;
  eventId: string;
  userId: string;
  marketId: string;
  positionQuantity: Money;
  markPrice: Money;
  indexPrice: Money;
  fundingRate: Money;
  paymentAmount: Money;
  fundingTime: number;
}

export interface FundingExecution {
  eventId: string;
  marketId: string;
  markPrice: Money;
  indexPrice: Money;
  premiumIndex: Money;
  fundingRate: Money;
  fundingTime: number;
  payments: FundingPayment[];
}

export interface MarginSummary {
  userId: string;
  collateralAsset: string;
  walletBalance: Money;
  unrealizedPnl: Money;
  accountEquity: Money;
  initialMargin: Money;
  maintenanceMargin: Money;
  openOrderInitialMargin: Money;
  openOrderFees: Money;
  availableMargin: Money;
  marginRatio: Money | null;
}

export interface OrderMarginCheck {
  ok: boolean;
  requiredInitialMargin: Money;
  requiredFee: Money;
  availableMargin: Money;
  reason?: "INSUFFICIENT_MARGIN" | "INVALID_LEVERAGE" | "UNKNOWN_MARKET";
}

export interface LiquidationOrder {
  orderId: string;
  userId: string;
  marketId: string;
  side: TradeSide;
  quantity: Money;
  limitPrice: Money;
  reduceOnly: true;
}

export interface LiquidationTrigger {
  eventId: string;
  userId: string;
  marketId: string;
  positionQuantity: Money;
  markPrice: Money;
  maintenanceMargin: Money;
  accountEquity: Money;
  status: LiquidationStatus;
  order: LiquidationOrder;
  createdAt: number;
}

export interface InsuranceFund {
  asset: string;
  balance: Money;
}

export interface InsuranceFundUsage {
  asset: string;
  requested: Money;
  used: Money;
  remainingDeficit: Money;
  nextFundBalance: Money;
}

export interface AdlCandidate {
  userId: string;
  position: Position;
  markPrice: Money;
  accountEquity: Money;
}

export interface AdlAction {
  userId: string;
  marketId: string;
  side: TradeSide;
  quantity: Money;
  price: Money;
  score: Money;
}

export interface DeficitSettlement {
  insuranceFund: InsuranceFundUsage;
  adlActions: AdlAction[];
  unresolvedDeficit: Money;
  status: "INSURANCE_FUND_USED" | "ADL_USED" | "FAILED";
}
