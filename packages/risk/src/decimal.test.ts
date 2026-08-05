import { describe, expect, it } from "bun:test";
import {
  Decimal,
  MONEY_SCALE,
  ZERO,
  money,
  moneyOr,
  roundUpMoney,
  toDecimalString,
  toNumber,
} from "./decimal";

describe("money", () => {
  it("is exact where floats are not", () => {
    expect(money(0.1).add(money(0.2)).eq(money("0.3"))).toBe(true);
    expect(0.1 + 0.2 === 0.3).toBe(false);
  });

  it("reads a float as the decimal literal it was written as", () => {
    expect(money(0.1).toFixed()).toBe("0.1");
    expect(money(59.91).mul(money(0.0005)).toFixed()).toBe("0.029955");
  });

  it("rejects non-finite input rather than poisoning later arithmetic", () => {
    expect(() => money(Number.NaN)).toThrow("invalid money value");
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow("invalid money value");
  });

  it("parses a foreign Decimal through its string form", () => {
    // Prisma ships its own decimal.js build, whose Decimal fails `instanceof` here. It is
    // stringified rather than passed to the constructor, so this does not depend on decimal.js
    // duck-typing another library's private `{d, e, s}` internals. Note the exponential form,
    // which is exactly what Prisma emits for small magnitudes.
    const foreignDecimal = { toString: () => "1e-7" };

    expect(money(foreignDecimal as unknown as string).toFixed()).toBe("0.0000001");
    expect(toDecimalString(money(foreignDecimal as unknown as string))).toBe(
      "0.000000100000000000",
    );
  });

  it("treats an absent column as zero", () => {
    expect(moneyOr(null).isZero()).toBe(true);
    expect(moneyOr(undefined).isZero()).toBe(true);
    expect(moneyOr("1.5").toFixed()).toBe("1.5");
  });
});

describe("toDecimalString", () => {
  it("never emits exponential notation", () => {
    // `String(1e-7)` is "1e-7". Postgres accepts that, so this pins the canonical
    // representation rather than guarding against a write error.
    expect(toDecimalString(money("0.0000001"))).toBe("0.000000100000000000");
    expect(toDecimalString(money(1e-7))).not.toContain("e");
    expect(toDecimalString(money("1e30"))).not.toContain("e");
  });

  it("renders at the column scale", () => {
    expect(toDecimalString(ZERO)).toBe("0.000000000000000000");
    expect(toDecimalString(money("1.5")).split(".")[1]).toHaveLength(MONEY_SCALE);
  });
});

describe("roundUpMoney", () => {
  it("never rounds a reservation down", () => {
    const value = money("1").div(money("3"));

    expect(roundUpMoney(value).gte(value)).toBe(true);
    expect(roundUpMoney(value).toFixed()).toBe("0.333333333333333334");
  });

  it("rounds away from zero, so magnitude never shrinks", () => {
    expect(roundUpMoney(money("-0.3333333333333333335")).toFixed()).toBe(
      "-0.333333333333333334",
    );
  });

  it("leaves an already-quantized value alone", () => {
    expect(roundUpMoney(money("5.9955")).toFixed()).toBe("5.9955");
  });
});

describe("toNumber", () => {
  it("converts at the edge", () => {
    expect(toNumber(money("59.91"))).toBe(59.91);
  });
});

describe("configuration", () => {
  it("keeps guard digits past the column scale for division", () => {
    expect(Decimal.precision).toBeGreaterThan(MONEY_SCALE);
  });
});
