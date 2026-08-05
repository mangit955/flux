import { describe, expect, it } from "bun:test";
import { money } from "../../risk/src/index";
import { toLiquidationWrite } from "./liquidation-mapper";

describe("toLiquidationWrite", () => {
  it("maps liquidation risk records to decimal-string persistence records", () => {
    const record = toLiquidationWrite(
      {
        eventId: "liq-1:BTC-PERP",
        userId: "user-1",
        marketId: "BTC-PERP",
        positionQuantity: money("2"),
        markPrice: money("94"),
        maintenanceMargin: money("0.94"),
        accountEquity: money("-12.5"),
        status: "TRIGGERED",
        createdAt: 1_700_000_000_000,
      },
      {
        insuranceFundUsed: money("50"),
        adlUsed: money("25"),
        status: "ADL_USED",
      },
    );

    expect(record).toEqual({
      id: "liq-1:BTC-PERP",
      userId: "user-1",
      marketId: "BTC-PERP",
      positionQuantity: "2.000000000000000000",
      markPrice: "94.000000000000000000",
      maintenanceMargin: "0.940000000000000000",
      accountEquity: "-12.500000000000000000",
      status: "ADL_USED",
      insuranceFundUsed: "50.000000000000000000",
      adlUsed: "25.000000000000000000",
      eventId: "liq-1:BTC-PERP",
      createdAt: new Date(1_700_000_000_000),
      updatedAt: new Date(1_700_000_000_000),
    });
  });
});
