-- The withdraw path (prisma-api-runtime.ts) writes a WITHDRAW ledger entry, but the enum never
-- had that value, so every withdrawal failed at the insert and rolled back.
ALTER TYPE "LedgerEntryType" ADD VALUE 'WITHDRAW';

-- Repair any rows that already violate the invariant, or the constraint cannot be added.
UPDATE "balances" SET "locked" = 0 WHERE "locked" < 0;

-- `locked` only ever increases through the conditional lock statement, whose
-- `WHERE "total" - "locked" >= amount` enforces `locked <= total` structurally. A
-- `CHECK ("locked" <= "total")` cannot be used here: a realized loss legitimately drops `total`
-- below the collateral still reserved for other open orders, and it would also forbid the
-- negative totals that record bad debt.
ALTER TABLE "balances" ADD CONSTRAINT "balances_locked_non_negative"
  CHECK ("locked" >= 0);
