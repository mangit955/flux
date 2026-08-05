import { describe, expect, it } from "bun:test";
import { money } from "../../risk/src/index";
import { toFundingPaymentWrite } from "./funding-payment-mapper";

describe("toFundingPaymentWrite", () => {
  it("maps funding payments to fixed-scale decimal-string persistence records", () => {
    const record = toFundingPaymentWrite(
      {
        id: "funding-1:long:BTC-PERP",
        eventId: "funding-1",
        userId: "long",
        marketId: "BTC-PERP",
        positionQuantity: money("2"),
        markPrice: money("101"),
        indexPrice: money("100"),
        fundingRate: money("0.00375"),
        paymentAmount: money("-0.7575"),
        fundingTime: 1_700_000_000_000,
      },
      new Date(1_700_000_000_500),
    );

    expect(record).toEqual({
      id: "funding-1:long:BTC-PERP",
      eventId: "funding-1",
      userId: "long",
      marketId: "BTC-PERP",
      positionQuantity: "2.000000000000000000",
      markPrice: "101.000000000000000000",
      indexPrice: "100.000000000000000000",
      fundingRate: "0.003750000000000000",
      paymentAmount: "-0.757500000000000000",
      fundingTime: new Date(1_700_000_000_000),
      createdAt: new Date(1_700_000_000_500),
    });
  });
});
