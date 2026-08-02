export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";
export type TimeInForce = "GTC" | "IOC";

export interface NewOrderCommand {
  commandId: string;
  orderId: string;
  userId: string;
  market: string;
  side: Side;
  type: OrderType;
  qtyLots: number;
  priceTicks?: number;
  minPriceTicks?: number;
  maxPriceTicks?: number;
  timeInForce: TimeInForce;
  reduceOnly?: boolean;
  postOnly?: boolean;
  createdAt: number;
}

export interface CancelOrderCommand {
  commandId: string;
  userId: string;
  market: string;
  orderId: string;
}
