import { describe, expect, it } from "bun:test";
import { money } from "./decimal";
import {
  applyLedgerEntry,
  availableBalance,
  lockBalance,
  unlockBalance,
} from "./ledger";
import type { Balance } from "./types";

const m = money;

describe("balance ledger", () => {
  it("applies deposits and records balanceAfter", () => {
    const result = applyLedgerEntry({
      id: "ledger-1",
      balance: balance({ total: 100 }),
      type: "DEPOSIT",
      amount: m(50),
      referenceId: "deposit-1",
      createdAt: 1,
    });

    expect(result.balance.total.toFixed()).toBe("150");
    expect(result.balance.locked.toFixed()).toBe("0");
    expect(result.entry.amount.toFixed()).toBe("50");
    expect(result.entry.balanceAfter.toFixed()).toBe("150");
    expect(result.entry).toMatchObject({
      id: "ledger-1",
      userId: "user-1",
      asset: "USDC",
      type: "DEPOSIT",
      referenceId: "deposit-1",
      createdAt: 1,
    });
  });

  it("applies trading fees as negative ledger entries", () => {
    const result = applyLedgerEntry({
      id: "ledger-1",
      balance: balance({ total: 100 }),
      type: "TRADING_FEE",
      amount: m(-0.25),
      referenceId: "fill-1",
      createdAt: 1,
    });

    expect(result.balance.total.toFixed()).toBe("99.75");
    expect(result.entry.balanceAfter.toFixed()).toBe("99.75");
  });

  it("rejects ledger entries that would make total balance negative", () => {
    expect(() =>
      applyLedgerEntry({
        id: "ledger-1",
        balance: balance({ total: 10 }),
        type: "TRADING_FEE",
        amount: m(-11),
        createdAt: 1,
      }),
    ).toThrow("balance negative");
  });

  it("locks and unlocks available balance", () => {
    const locked = lockBalance(balance({ total: 100, locked: 10 }), m(30));

    expect(availableBalance(locked).toFixed()).toBe("60");
    expect(locked.locked.toFixed()).toBe("40");

    const unlocked = unlockBalance(locked, m(15));

    expect(unlocked.locked.toFixed()).toBe("25");
    expect(availableBalance(unlocked).toFixed()).toBe("75");
  });

  it("rejects locking more than available balance", () => {
    expect(() =>
      lockBalance(balance({ total: 100, locked: 90 }), m(20)),
    ).toThrow("insufficient available");
  });

  it("returns collateral exactly, with no drift across many cycles", () => {
    // Locking and releasing must be exactly symmetric. `roundFinancial` happened to hold this
    // together at small magnitudes; exact arithmetic makes it true by construction, including
    // at the balance sizes where 12-place rounding no longer has the digits to work with.
    let current = balance({ total: 100 });

    for (let i = 0; i < 1000; i += 1) {
      current = lockBalance(current, m("0.1"));
      current = unlockBalance(current, m("0.1"));
    }

    expect(current.locked.isZero()).toBe(true);
    expect(current.locked.toFixed()).toBe("0");
  });
});

function balance(
  overrides: { total?: number | string; locked?: number | string } = {},
): Balance {
  return {
    userId: "user-1",
    asset: "USDC",
    total: m(overrides.total ?? 0),
    locked: m(overrides.locked ?? 0),
  };
}
