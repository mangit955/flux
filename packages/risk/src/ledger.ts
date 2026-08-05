import { ZERO, type Money } from "./decimal";
import type { Balance, LedgerEntry, LedgerEntryType } from "./types";

export interface ApplyLedgerEntryInput {
  id: string;
  balance: Balance;
  type: LedgerEntryType;
  amount: Money;
  referenceId?: string;
  createdAt: number;
}

export interface ApplyLedgerEntryResult {
  balance: Balance;
  entry: LedgerEntry;
}

export function applyLedgerEntry(
  input: ApplyLedgerEntryInput,
): ApplyLedgerEntryResult {
  const nextTotal = input.balance.total.add(input.amount);

  if (nextTotal.isNegative()) {
    throw new Error(
      `ledger entry would make ${input.balance.asset} balance negative`,
    );
  }

  const balance: Balance = {
    ...input.balance,
    total: nextTotal,
  };

  return {
    balance,
    entry: {
      id: input.id,
      userId: input.balance.userId,
      asset: input.balance.asset,
      type: input.type,
      amount: input.amount,
      balanceAfter: nextTotal,
      referenceId: input.referenceId,
      createdAt: input.createdAt,
    },
  };
}

export function availableBalance(balance: Balance): Money {
  return balance.total.sub(balance.locked);
}

export function lockBalance(balance: Balance, amount: Money): Balance {
  assertNonNegative(amount, "lock amount");

  if (availableBalance(balance).lt(amount)) {
    throw new Error(`insufficient available ${balance.asset} balance`);
  }

  return {
    ...balance,
    locked: balance.locked.add(amount),
  };
}

export function unlockBalance(balance: Balance, amount: Money): Balance {
  assertNonNegative(amount, "unlock amount");

  if (balance.locked.lt(amount)) {
    throw new Error(`cannot unlock more ${balance.asset} than is locked`);
  }

  return {
    ...balance,
    locked: balance.locked.sub(amount),
  };
}

function assertNonNegative(value: Money, label: string): void {
  if (!value.isFinite() || value.lt(ZERO)) {
    throw new Error(`${label} must be non-negative`);
  }
}
