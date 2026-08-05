import { ZERO, toDecimalString, type Money } from "../../risk/src/index";
import type { DurableLiquidationStatus, LiquidationWrite } from "./records";

export interface LiquidationLike {
  eventId: string;
  userId: string;
  marketId: string;
  positionQuantity: Money;
  markPrice: Money;
  maintenanceMargin: Money;
  accountEquity: Money;
  status: DurableLiquidationStatus;
  createdAt: number;
}

export interface LiquidationSettlementLike {
  insuranceFundUsed: Money;
  adlUsed: Money;
  status?: DurableLiquidationStatus;
}

export function toLiquidationWrite(
  liquidation: LiquidationLike,
  settlement: LiquidationSettlementLike = {
    insuranceFundUsed: ZERO,
    adlUsed: ZERO,
  },
): LiquidationWrite {
  const createdAt = new Date(liquidation.createdAt);

  return {
    id: liquidation.eventId,
    userId: liquidation.userId,
    marketId: liquidation.marketId,
    positionQuantity: toDecimalString(liquidation.positionQuantity),
    markPrice: toDecimalString(liquidation.markPrice),
    maintenanceMargin: toDecimalString(liquidation.maintenanceMargin),
    accountEquity: toDecimalString(liquidation.accountEquity),
    status: settlement.status ?? liquidation.status,
    insuranceFundUsed: toDecimalString(settlement.insuranceFundUsed),
    adlUsed: toDecimalString(settlement.adlUsed),
    eventId: liquidation.eventId,
    createdAt,
    updatedAt: createdAt,
  };
}
