import type { EngineEvent, NewOrderCommand, CancelOrderCommand } from "../../matching-engine/index";
import { money, type MarketRiskConfig, type Position } from "../../risk/src/index";

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

/** A position as the HTTP API exposes it: plain numbers, for JSON. */
export interface RuntimePosition {
  userId: string;
  marketId: string;
  quantity: number;
  entryPrice: number;
  realizedPnl: number;
  leverage: number;
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

/**
 * A market as the HTTP and websocket APIs expose it.
 *
 * Deliberately *not* `extends MarketRiskConfig`: that type carries `Decimal` money now, and
 * `GET /markets` serializes this straight to the browser, where a `Decimal` renders as
 * `{"s":1,"e":1,"d":[…]}`. The rates are held as plain numbers here and converted back into
 * exact money with `toRiskConfig` at the risk-calculation boundary.
 */
export interface RuntimeMarket {
  marketId: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
  lotSize: number;
  maxLeverage: number;
  initialMarginRate: number;
  maintenanceMarginRate: number;
  makerFeeRate: number;
  takerFeeRate: number;
  fundingIntervalHours: number;
  fundingRateCap: number;
  status: "ACTIVE" | "PAUSED";
}

/** Lift an API market into the exact-money config the risk package works in. */
export function toRiskConfig(market: RuntimeMarket): MarketRiskConfig {
  return {
    marketId: market.marketId,
    tickSize: money(market.tickSize),
    lotSize: money(market.lotSize),
    maxLeverage: market.maxLeverage,
    initialMarginRate: money(market.initialMarginRate),
    maintenanceMarginRate: money(market.maintenanceMarginRate),
    makerFeeRate: money(market.makerFeeRate),
    takerFeeRate: money(market.takerFeeRate),
  };
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
