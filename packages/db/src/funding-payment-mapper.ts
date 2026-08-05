import { toDecimalString, type Money } from "../../risk/src/index";
import type { FundingPaymentWrite } from "./records";

export interface FundingPaymentLike {
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

export function toFundingPaymentWrite(
  payment: FundingPaymentLike,
  createdAt = new Date(payment.fundingTime),
): FundingPaymentWrite {
  return {
    id: payment.id,
    userId: payment.userId,
    marketId: payment.marketId,
    positionQuantity: toDecimalString(payment.positionQuantity),
    markPrice: toDecimalString(payment.markPrice),
    indexPrice: toDecimalString(payment.indexPrice),
    fundingRate: toDecimalString(payment.fundingRate),
    paymentAmount: toDecimalString(payment.paymentAmount),
    fundingTime: new Date(payment.fundingTime),
    eventId: payment.eventId,
    createdAt,
  };
}
