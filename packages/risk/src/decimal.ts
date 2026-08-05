import { Decimal } from "decimal.js";

/**
 * The single money type for the backend.
 *
 * Every monetary column in `prisma/schema.prisma` is `Decimal(36, 18)`. Floats cannot represent
 * those values, and rounding a float result to 12 places (the old `roundFinancial`) does not
 * restore associativity — the drift it leaves is unbounded across lock/unlock cycles. Base-10
 * decimal arithmetic matches the column semantics exactly, so the value written is the value
 * computed.
 *
 * `precision` carries guard digits past the 18 the columns hold, because division (notional over
 * leverage, premium index over price) is non-terminating in general and needs somewhere to land
 * before it is quantized at the write.
 *
 * `toExpNeg`/`toExpPos` are pushed well outside the representable range so no value here ever
 * renders in exponential form. This is normalization, not a crash fix: Postgres `numeric` and
 * the Prisma driver both accept `"1e-7"` — measured against Postgres 16, not assumed. Keeping
 * one plain-decimal representation means stored text can be compared and eyeballed directly,
 * and nothing downstream has to care which notation a value happens to arrive in.
 */
Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});

/** Scale of every monetary column: `Decimal(36, 18)`. */
export const MONEY_SCALE = 18;

export { Decimal };
export type Money = Decimal;

export const ZERO = new Decimal(0);

/**
 * Parse a value into `Money`.
 *
 * Numbers are routed through their string form so the decimal reads the shortest representation
 * that round-trips (`0.1` becomes `0.1`, not the full binary expansion). That is the right
 * reading for a float that originated as a decimal literal — order quantities from JSON, prices
 * from the matching engine — which is the only place numbers enter the money path.
 *
 * Prisma's `Decimal` is a *different* decimal.js build, so it fails `instanceof` here. Objects
 * are stringified explicitly rather than handed to the constructor: decimal.js would otherwise
 * accept a foreign Decimal only by duck-typing its internal `{d, e, s}` fields, which is a
 * private representation that a dependency bump could change without warning. Its `toString`
 * emits exponential notation for small magnitudes (`1e-7`) — parsed correctly here, and
 * normalized on the way out by `toDecimalString`, which is what Postgres `numeric` requires.
 */
export function money(value: Money | string | number): Money {
  if (value instanceof Decimal) {
    return value;
  }

  const parsed = new Decimal(typeof value === "string" ? value : String(value));

  if (!parsed.isFinite()) {
    throw new Error(`invalid money value: ${String(value)}`);
  }

  return parsed;
}

/** Parse a possibly-absent column or field, treating null/undefined as zero. */
export function moneyOr(value: Money | string | number | null | undefined, fallback = ZERO): Money {
  return value == null ? fallback : money(value);
}

/**
 * Render for a `Decimal(36, 18)` column.
 *
 * Always `toFixed`, never `String(d)` or `d.toString()`: those switch to exponential notation
 * for small magnitudes. Postgres accepts that form, so this is about keeping one canonical
 * representation in the column rather than avoiding an error.
 *
 * The scale matters more than the notation. `Decimal(36, 18)` silently truncates anything below
 * 1e-18 to zero and rejects an absolute value at or above 1e18 with a `numeric field overflow`
 * — both verified against Postgres 16.
 */
export function toDecimalString(value: Money): string {
  return value.toFixed(MONEY_SCALE);
}

/**
 * Quantize away from zero, against the user.
 *
 * Used for margin reservations, which are non-negative: rounding a lock down leaves the position
 * a sub-unit under-collateralized and the exchange eats the difference. Away-from-zero rather
 * than toward-positive-infinity, so the magnitude of a negative input never shrinks either.
 */
export function roundUpMoney(value: Money): Money {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_UP);
}

/**
 * Convert to a plain number for the API/websocket edge.
 *
 * Legal only in DTO mappers. Anywhere else this reintroduces exactly the float drift the rest of
 * this module exists to remove.
 */
export function toNumber(value: Money): number {
  return value.toNumber();
}
