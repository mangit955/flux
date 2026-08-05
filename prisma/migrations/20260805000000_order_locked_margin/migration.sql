-- Record the collateral reserved for an order at submit time, so the release path can
-- return exactly that amount instead of reconstructing it (TODO #6, #7, #8).
ALTER TABLE "orders" ADD COLUMN "lockedMargin" DECIMAL(36, 18) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "leverage" INTEGER NOT NULL DEFAULT 10;

-- Best-effort backfill for orders that are still holding collateral, using the formula the
-- lock side actually used (leverage 10, taker fee rate). Open MARKET orders have a NULL price
-- and cannot be backfilled -- that is TODO #7 itself -- so they release 0 once.
UPDATE "orders" o
SET "lockedMargin" = (o."price" * o."quantity" / 10) * (1 + m."takerFeeRate")
FROM "markets" m
WHERE m."id" = o."marketId"
  AND o."status" IN ('PENDING', 'OPEN', 'PARTIALLY_FILLED')
  AND o."reduceOnly" = false
  AND o."price" IS NOT NULL;
