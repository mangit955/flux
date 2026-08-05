import type { EngineEvent, NewOrderCommand, CancelOrderCommand } from "../../matching-engine/index";
import type { MarketRiskConfig, Position } from "../../risk/src/index";

export interface RuntimeUser {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: number;
}

export interface RuntimeBalance {
  userId: string;
  asset: string;
  total: number;
  locked: number;
}

export interface RuntimeOrder {
  id: string;
  userId: string;
  marketId: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  quantity: number;
  remainingQuantity: number;
  price?: number;
  timeInForce: "GTC" | "IOC";
  leverage: number;
  reduceOnly: boolean;
  postOnly: boolean;
  status:
    | "PENDING"
    | "OPEN"
    | "PARTIALLY_FILLED"
    | "FILLED"
    | "CANCELLED"
    | "REJECTED"
    | "EXPIRED";
  rejectionReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeFill {
  id: string;
  tradeId: string;
  orderId: string;
  userId: string;
  marketId: string;
  side: "BUY" | "SELL";
  liquidityRole: "MAKER" | "TAKER";
  price: number;
  quantity: number;
  notional: number;
  fee: number;
  realizedPnl: number;
  createdAt: number;
}

export interface RuntimeMarket extends MarketRiskConfig {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  fundingIntervalHours: number;
  fundingRateCap: number;
  status: "ACTIVE" | "PAUSED";
}

export interface RuntimeStateSnapshot {
  users: RuntimeUser[];
  balances: RuntimeBalance[];
  markets: RuntimeMarket[];
  orders: RuntimeOrder[];
  fills: RuntimeFill[];
  positions: Position[];
}

export type RuntimeCommand =
  | { type: "order.created"; command: NewOrderCommand }
  | { type: "order.cancelled"; command: CancelOrderCommand };

export type RuntimeEvent =
  | { type: "engine.event"; event: EngineEvent }
  | { type: "position.updated"; userId: string; marketId: string; position: Position };

export interface StreamMessage<T> {
  id: string;
  stream: string;
  payload: T;
}
