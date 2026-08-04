---
name: money-path
description: Mandatory invariants for any change touching balances, margin, locking/unlocking collateral, fills, positions, realized/unrealized PnL, fees, or the ledger. Read BEFORE editing prisma-api-runtime.ts, persistence-service.ts, prisma-persistence-store.ts, or anything in packages/risk. Triggers on "balance", "margin", "locked", "collateral", "fill", "settle", "PnL", "fee", "ledger", "deposit", "withdraw", "position", "liquidation", "funding payment".
---

# Money path invariants

This exchange moves user funds. The rules below are not style preferences — each one
corresponds to a real defect currently in this repo (tracked in `TODO.md`, Tier 1). When you
touch this code, move it *toward* these invariants; never add a new violation.

## Guarded files

| File | What lives there |
|---|---|
| `packages/runtime/src/prisma-api-runtime.ts` | `submitOrder`, margin check, balance lock, `deposit`, `withdraw` |
| `packages/db/src/persistence-service.ts` | fill settlement, margin unlock on cancel/expire/reject/fill |
| `packages/db/src/prisma-persistence-store.ts` | `unlockBalanceForOrder` |
| `packages/risk/src/margin.ts` | `checkOrderMargin`, `calculateMarginSummary` |
| `packages/risk/src/ledger.ts` | `applyLedgerEntry`, `lockBalance`, `unlockBalance` |
| `packages/risk/src/position-engine.ts` | `applyFillToPosition`, realized PnL |

---

## 1. Money is never a JS `number`

The schema is `Decimal(36, 18)` on every monetary column (`prisma/schema.prisma`). Keep it
that way end to end — `Prisma.Decimal` or fixed-point integers.

**Banned:**
```ts
Number(field(row, "total"))        // loses precision immediately
String(currentLocked + amount)      // float math, then String(1e-7) → "1e-7", unparseable
value.toFixed(12)                   // patches the symptom, not the cause
```

The current `decimal()` helper (`prisma-api-runtime.ts:695`) and `roundFinancial()`
(`risk/margin.ts:200`) are the anti-examples. Both are slated for removal (TODO #9).

Rounding to 12 decimals does not restore associativity. Accumulated drift across thousands of
lock/unlock cycles is unbounded.

## 2. Never read-modify-write a balance row

Postgres defaults to READ COMMITTED. Two concurrent orders both read `locked`, both pass the
check, and the second write silently overwrites the first — the user ends up with leveraged
exposure exceeding their collateral.

**Anti-example — do not copy this shape** (`prisma-api-runtime.ts:360-392`):
```ts
const currentBalance = await tx.balance.findUnique({ ... });
const currentLocked = Number(field(currentBalance, "locked"));
if (currentTotal - currentLocked < marginToLock) throw new Error("insufficient");
await tx.balance.update({ data: { locked: String(currentLocked + marginToLock) } });
```

**Required instead:** `SELECT ... FOR UPDATE` on the balance row, or Prisma's atomic
`{ locked: { increment: amount } }`. Back it with a DB constraint so the invariant is enforced
even if application logic regresses:

```sql
ALTER TABLE balances ADD CONSTRAINT locked_within_total CHECK (locked <= total);
```

The same broken shape exists in `prisma-persistence-store.ts:239-273`. Fix both together.

## 3. Release the recorded lock, never a recomputed one

Collateral released must equal collateral locked, exactly. The only safe way is to **record
`lockedMargin` on the order row at submit time and release that stored value**.

**Anti-example** (`persistence-service.ts`, four duplicated copies at ~91, ~122, ~157, ~196):
```ts
const leverage = 10; // Default leverage, should ideally be stored with order
const price = Number(order.price || 0);
const totalToUnlock = (price * qty) / leverage + (price * qty) * takerFeeRate;
```

Three independent bugs in that block:
- Hardcoded `leverage = 10` while the lock uses the user's actual leverage → at 20x the user
  gets back **2×** what was locked; at 5x margin is stranded permanently.
- `order.price` is `null` for market orders → `totalToUnlock` is `0` → every cancelled or
  expired market order leaks 100% of its collateral.
- Hardcoded `"USDC"` instead of `market.quoteAsset`.

Reconstruct-instead-of-record is how exchanges lose money. If you find yourself deriving an
amount that was already known at write time, stop.

Also: `Math.max(0, currentLocked - amount)` in `unlockBalanceForOrder` silently swallows the
corruption. Surface it — throw or alert — rather than clamping.

## 4. Every fill settles fee *and* realized PnL

A fill row written with `fee: 0` / `realizedPnl: "0"` is incomplete. Currently hardcoded at
`persistence-service.ts:279`, `:342`, `:359`, which means the exchange collects no fees and
**users never receive their P&L**.

In the same transaction as the fill:
1. Debit the fee (`market.makerFeeRate` / `takerFeeRate` by liquidity role — not always taker).
2. Credit or debit realized PnL from `applyFillToPosition` into `balance.total`.
3. Write a `LedgerEntry` for each movement.

Note `estimatedFeeForOpenOrder` (`risk/margin.ts:143`) reserves at the **taker** rate for every
order, including post-only orders that can only ever be makers. That over-reserves margin on
exactly the orders that provide liquidity.

## 5. Check and lock share one transaction

`checkOrderMargin` currently reads balance, positions, and open orders in three separate
un-transacted queries (`prisma-api-runtime.ts:283-320`), then locks in a *later* transaction.
The decision is stale before it is acted on. Read and write inside the same transaction.

## 6. Fail closed on risk inputs

`getOrderBook` (`prisma-api-runtime.ts:520-533`) swallows Redis errors and returns
`{ bids: [], asks: [] }`. `resolveMarketOrderRisk` depends on that data to price margin, so a
cache outage silently becomes "no liquidity". Risk-input paths return 503; they do not
fabricate an empty book.

---

## Before you finish

- [ ] No new `Number()` on a Decimal column; no `String(number)` writes.
- [ ] No read-modify-write on `balances`. Atomic increment or `FOR UPDATE`.
- [ ] Lock and release are symmetric and use the *stored* amount.
- [ ] Asset comes from `market.quoteAsset`, never a literal.
- [ ] Fee and realized PnL settled, with `LedgerEntry` rows.
- [ ] A test asserts `locked <= total` after the change.
- [ ] Run the `verify` skill. A red suite blocks the commit.

## Tests that actually catch these

Unit tests on pure functions will not find bugs 2 or 3. Add:
- **Property test:** N random lock/unlock cycles at mixed leverage → assert `locked <= total`
  and `locked === 0` once all orders are terminal. Catches bugs 3 and the leverage asymmetry.
- **Concurrency test:** fire concurrent `submitOrder` calls for one user against real Postgres
  → assert total locked never exceeds balance. Catches bug 2.

Note that `PrismaApiRuntime` (718 lines, the entire money path) currently has **zero** tests.
