# TODO

Engineering backlog from a code review of the exchange backend. Ordered by tier;
Tier 0 and Tier 1 are correctness issues in the money path and block everything else.

File references are `path:line` at the time of review — verify before editing.

---

## Tier 0 — Blockers

- [x] **1. Fix the failing test on `main`**
  `packages/db/src/persistence-service.test.ts:92`. The expected `writes` array was never
  updated when the `balance.unlock_maker` / `balance.unlock_taker` effects were added to
  `persistence-service.ts:236-242`. Fixed by inserting those two entries in emit order.
  `bun test` is the first verification step in the README and was failing on a fresh clone.

- [x] **1b. Fix the failing type check on `main`**
  `apps/workers/src/index.ts:96` — `TS2322: Type 'WorkerPrismaClient' is not assignable to
  type 'OrderRecoveryClient | undefined'`. `WorkerPrismaClient` was
  `PrismaClientLike & OutboxPublisherClient & { market, snapshotMetadata }`, and neither
  `PrismaClientLike` (only `$transaction`) nor `OutboxPublisherClient` (only `outboxEvent`)
  declares a top-level `order` — so the intersection never satisfied `OrderRecoveryClient`'s
  required `order.findMany` (`packages/runtime/src/production-workers.ts:34-41`).
  Bun strips types at runtime so this never crashed, but the startup order-recovery contract
  was unenforced. Fixed by intersecting with the already-exported `OrderRecoveryClient`.
  The other 9 workspaces type-checked clean throughout.

  `bun run check-types` is also listed in the README's Verification section, so like #1 it was
  simply not being run.

- [x] **2. Add CI**
  `.github/workflows/ci.yml` now runs `bun install --frozen-lockfile`, `bun test`,
  `bun run check-types`, and `docker compose config` on push to `main` and on every PR.
  No service containers needed — the suite runs entirely on the in-memory ports.
  This is what stops #1 and #1b from happening again.

---

## Tier 1 — Correctness in the money path

- [ ] **3. Charge fees on fills**
  `packages/db/src/persistence-service.ts:279` (`fee: 0`), `:342`, `:359` (`fee: "0"`).
  Fills are written with a hardcoded zero fee, so the exchange collects nothing while
  `checkOrderMargin` reserves `requiredFee` on every order.
  Compute maker/taker fee from `market.makerFeeRate` / `takerFeeRate`, debit `balance.total`,
  write a `LedgerEntry`.

- [ ] **4. Credit realized PnL to balances**
  `persistence-service.ts:343`, `:359` (`realizedPnl: "0"`).
  `applyFillToPosition` computes realized PnL correctly and the result is discarded, so a user
  can open a position, have it move in their favour, close it, and receive nothing.
  Persist it on the fill and settle it into `balance.total` in the same transaction.

- [ ] **5. Fix the lost-update race on `balance.locked`**
  `packages/runtime/src/prisma-api-runtime.ts:360-392` and
  `packages/db/src/prisma-persistence-store.ts:239-273`.
  Read-modify-write with no row lock, no atomic increment, and default READ COMMITTED
  isolation. Two concurrent orders both read `locked`, both pass the check, second write wins.
  Use `SELECT ... FOR UPDATE` or Prisma `{ increment }`, and add a DB
  `CHECK (locked <= total)` constraint as a backstop.

- [ ] **6. Stop hardcoding `leverage = 10` in the unlock path**
  `persistence-service.ts` ~lines 91, 122, 157, 196 — four duplicated copies, one with a
  comment admitting it should be stored on the order. The lock side uses `input.leverage ?? 10`.
  At 20x the user gets back 2x what was locked; at 5x margin is stranded permanently.
  Store `lockedMargin` on the order row at submit time and release exactly that value.
  This deletes all four reconstructions.

- [ ] **7. Fix market orders leaking 100% of locked margin**
  Same blocks — `Number(order.price || 0)`, and market orders have `price = null`, so
  `totalToUnlock` is always 0. `MARKET_LIQUIDITY_EXHAUSTED` is a routine engine outcome, so
  this fires constantly.
  Resolved by the same fix as #6: release the recorded amount, never a recomputed one.

- [ ] **8. Use `market.quoteAsset` instead of hardcoded `"USDC"`**
  Same blocks. Also remove the duplicate `tx.findMarket(event.market)` call whose result is
  assigned to `marketData` and never used.

- [ ] **9. Get money off floats**
  `prisma-api-runtime.ts:695` (`decimal()` → `Number`), writes via `String(number)`.
  `packages/risk/src/margin.ts:200` (`roundFinancial` = `toFixed(12)`) patches the symptom.
  The schema is correctly `Decimal(36,18)` and every boundary throws that away.
  `String(1e-7)` also emits exponential notation Prisma can't parse.
  Move to `Prisma.Decimal` or fixed-point integers end-to-end; delete `roundFinancial`.
  **Do this after #3-#8** — migrating while the logic is still wrong means doing it twice.

- [ ] **10. Move the margin check inside the transaction**
  `prisma-api-runtime.ts:283-320`. Balance, positions, and open orders are read in three
  un-transacted queries, then the lock happens in a later transaction, so the decision is
  based on state that may already have changed.

- [ ] **11. Add a DLQ; stop acking failed commands**
  `packages/runtime/src/production-workers.ts:255-270`. The `ack()` is outside the try/catch,
  so a command that throws is acknowledged and dropped — the order vanishes and its margin
  stays locked forever. The comment says this was done to stay under Upstash's 1000-message
  PEL limit; that trades at-least-once delivery on financial commands for an ops alarm.
  Route failures to a dead-letter stream with bounded retry; ack only on success or after the
  DLQ write.

---

## Tier 2 — Broken invariants and missing subsystems

- [ ] **12. Wire up the liquidation engine**
  `packages/risk/src/liquidation.ts` — `createLiquidationTriggers`, `useInsuranceFund`,
  `calculateAdlScore`, `createLiquidationOrder`, `settleLiquidationDeficit`, and
  `isMaintenanceMarginViolated` have **zero production callers**. The system offers 20x
  leverage with no mechanism to close underwater positions, and the insurance fund table is
  never written to. README claims Phase 5 is implemented.
  A worker that scans positions against mark price and submits liquidation orders is roughly
  200 lines; the functions are already written and unit-tested.

- [ ] **13. Wire up funding**
  `packages/risk/src/funding.ts` — `applyFundingPayments`, `shouldExecuteFunding`,
  `calculateFundingRate` have zero production callers. README claims Phase 4 is implemented.
  Add a scheduled worker on the `fundingIntervalHours` cadence.

- [ ] **14. Convert floats to ticks/lots at the API boundary**
  `prisma-api-runtime.ts:340-343` — `qtyLots: input.quantity`, `priceTicks: input.price` pass
  raw floats straight from JSON into the engine's integer domain. `market.tickSize` and
  `market.lotSize` are loaded in `mapMarket` and never used.
  This voids every guarantee the engine's integer design provides and makes the type names lie.
  Convert: `qtyLots = round(qty / lotSize)`, `priceTicks = round(price / tickSize)`.
  Reject non-aligned input with a 400.

- [ ] **15. Resolve the duplicate margin-rate source of truth**
  `prisma/schema.prisma:123` defines `initialMarginRate` per market;
  `initialMarginForOpenOrder` (`packages/risk/src/margin.ts:130-141`) uses
  `price * qty / leverage` and never reads it. Pick one and delete the other.

- [ ] **16. Prevent matching-engine split brain**
  `production-workers.ts` holds the orderbook in process memory and reads with
  `consumerName ?? "matching-engine-1"` — a constant default. Two replicas share a consumer
  group, so Redis splits commands between them and each builds a different book from a
  different subset of orders, both writing to the same Redis cache key.
  Add leader election (Redis lock with a fencing token) or explicit market partitioning, plus
  a startup guard that refuses to run if the lock is held.

- [ ] **17. Fix or delete `cleanupPendingEntries()`**
  `production-workers.ts:212-222` is a stub that logs `"Skipping pending entries cleanup
  (disabled)"` and sets `pendingCleanupComplete = true`. The PEL-limit error handler calls it,
  so the recovery path is a no-op that reports success.
  Implement with `XAUTOCLAIM` or remove it and the call site.

- [ ] **18. Stop failing open on orderbook reads**
  `prisma-api-runtime.ts:520-533` — a Redis error logs and returns
  `{ bids: [], asks: [] }`. Clients can't distinguish "no liquidity" from "cache is down", and
  `resolveMarketOrderRisk` depends on this data to price margin. Fail closed (503) on
  risk-input paths.

- [ ] **19. Add graceful shutdown**
  `setInterval` loops in `apps/api/src/index.ts:56` and `apps/workers/src/index.ts` with no
  SIGTERM handler. Railway sends SIGTERM on every deploy, which can kill the process between
  "engine applied the command" and "events appended to the stream", losing fills silently.

---

## Tier 3 — API, security, and interface quality

- [ ] **20. Fix error handling**
  `apps/api/src/app.ts:190-194`. Every error becomes a 400 with the internal message
  string-mangled into an error code via `toUpperCase().replaceAll(" ", "_")`.
  A Prisma connection failure returns `400 CONNECT_ECONNREFUSED_...`; `"invalid credentials"`
  returns 400 instead of 401; adding a period to a message is a breaking API change.
  Use typed error classes with explicit status mapping — reuse the rejection-reason union
  pattern already used in the matching engine.

- [ ] **21. Authenticate `POST /admin/drain`**
  `app.ts:190` — no auth check at all. Add an admin token or remove it from the production app.

- [ ] **22. Harden `POST /auth/guest`**
  `prisma-api-runtime.ts:126-147` creates a real user row and runs a password hash,
  unauthenticated and unrate-limited — unbounded table growth plus deliberate CPU burn,
  trivially scripted. Rate limit by IP, sign a stateless ephemeral guest token instead of
  persisting a user, and TTL-expire guests.

- [ ] **23. Add rate limiting**
  Nothing exists anywhere. Login is unlimited credential stuffing. Also register, guest, and
  order submission. Per-IP and per-user limits, tightest on auth.

- [ ] **24. Fix CORS and add body size limits**
  `app.ts:45` — `Access-Control-Allow-Origin: "*"` hardcoded, with a comment saying to replace
  it in production, in production. Make it an env-driven allowlist.

- [ ] **25. Add idempotency to `POST /orders`**
  A client retry on timeout creates a duplicate order. The engine already has
  `DUPLICATE_ORDER_ID` but can't help because the API generates the ID server-side.
  Accept an `Idempotency-Key` / `clientOrderId`, unique-indexed per user.

- [ ] **26. Validate order payloads with a schema**
  `app.ts:220-240` (`normalizeOrderInput`) uses bare `Number()` coercion, so `Number("abc")`
  → `NaN` reaches the engine. Add Zod or equivalent at the boundary.

- [ ] **27. Restore type safety in the Prisma adapter**
  `prisma-api-runtime.ts:34-77` hand-rolls an interface where every method returns `unknown`,
  read through `field()` casts at `:695`. Also `listPositions(): Promise<unknown[]>` in the
  public `ApiRuntime` interface, and `(this.options.bus as any).trimStream` in
  `production-workers.ts`.
  This means zero compile-time checking in the file that computes margin — a field typo
  silently yields `Number(undefined ?? 0) === 0`.
  Use generated Prisma types, or parse rows at the boundary so a mismatch throws.

- [ ] **28. Document or replace the dynamic-import hack**
  `apps/api/src/production.ts:32` — `new Function("specifier", "return import(specifier)")`
  to smuggle an import past the bundler. Undocumented and will confuse the next reader.

- [ ] **29. Add pagination**
  `GET /orders` and `GET /fills` return unbounded result sets.

---

## Tier 4 — Observability and performance

- [ ] **30. Replace `console.log` with a structured logger**
  58 call sites across backend packages. Emoji logs per order (`🔒 Locked ...`) and
  `[MATCHING] Reading from ...` on every 100ms poll per market — roughly 10 lines/sec/market
  of noise with no levels, no structure, no sampling. Real errors are unfindable.
  (Commit `8a8bc5f` fixing plaintext password logging has the same root cause.)

- [ ] **31. Thread a correlation ID through the pipeline**
  API → stream → worker → persistence currently share no request or order ID, which is exactly
  why the Tier 1 bugs are hard to see in logs. Do this **before** debugging #5 and #11.

- [ ] **32. Add metrics**
  No counters, no histograms, no `/metrics` endpoint. There's currently no way to answer
  "how many orders failed today".

- [ ] **33. Stop publishing a full orderbook snapshot every 100ms**
  `production-workers.ts` — `publishOrderBookToCache` runs unconditionally on every poll per
  market, serializing and writing the whole book regardless of whether anything changed.
  This is the real scaling bottleneck, well before matching throughput.
  Publish on change and use the sequence numbers already present in the snapshot type for
  incremental diffs.

- [ ] **34. Bound the tree traversal recursion**
  `packages/matching-engine/src/price-level-tree.ts:171-205` — `visitAscending` /
  `visitDescending` recurse with no depth bound, and `valuesBestFirst()` with no limit is
  called on every worker iteration.

- [ ] **35. Add timeouts**
  No HTTP request timeout, no DB statement timeout, no Redis command timeout.

- [ ] **36. Re-enable snapshot-based recovery in production**
  Commit `75e509b` disabled file snapshots completely in production. The recovery system is
  designed, implemented, and tested — and then switched off where it actually matters.

---

## Tier 5 — Testing gaps

- [ ] **37. Test `PrismaApiRuntime`**
  718 lines covering the margin check, balance locking, and order submission, with zero tests.
  Every Tier 1 defect lives in this untested code.

- [ ] **38. Add concurrency tests**
  A concurrent-order test against a real Postgres catches #5.

- [ ] **39. Add invariant / property tests**
  `locked <= total` after N random lock/unlock cycles catches #6 and #7 immediately.
  Also: the book is never crossed; `replay(events)` equals live state.

- [ ] **40. Expand API tests**
  `apps/api/src/app.test.ts` has 4 tests covering in-memory happy paths only.

---

## Tier 6 — Credibility and hygiene

- [ ] **41. Fix broken doc references**
  README points to `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/WEBSOCKETS.md`,
  `docs/RECOVERY.md`, `docs/TESTING.md` — there is no `docs/` directory. It also references a
  root `.env.example` that doesn't exist.

- [ ] **42. Align claims with reality**
  `README.md:127-128` states "Phase 4: Funding implemented" and "Phase 5: Liquidation,
  insurance fund, and simplified ADL implemented". Both are implemented only as tested pure
  functions in `packages/risk` with **zero production callers** — see #12 and #13.
  Either build them or mark them accurately as tested-but-unwired.

  (The "production-grade" claim this item also flagged lived in `DETAILED_ARCHITECTURE.md:5`,
  which has since been deleted.)

- [x] **43. Consolidate the root-level markdown files**
  Done by deletion. `DETAILED_ARCHITECTURE.md`, `BINANCE_INTEGRATION.md`,
  `REDIS_ORDERBOOK_CACHE.md`, `DEPLOYMENT.md`, `DEPLOYMENT_CHECKLIST.md`, `QUICK_START.md`,
  `QUICK_TROUBLESHOOTING.md`, and `URL_CONFIGURATION.md` were removed; root markdown is now
  `README.md`, `CLAUDE.md`, and `TODO.md`. Orphaned links in `scripts/README.md` and
  `apps/web/README.md` were repointed at `CLAUDE.md` / `TODO.md`.

- [ ] **44. Remove the shipped debug page**
  `apps/web/app/debug/page.tsx` exposes env configuration on the deployed site.

- [ ] **45. Remove mock feeds from the live trade page**
  `apps/web/app/trade/page.tsx:13` still starts/stops a mock market feed alongside the real
  one, so a visitor can't tell which numbers are real.

- [ ] **46. Clean up `any` / `@ts-ignore` in `apps/web`**
  44 occurrences.

- [ ] **47. Add an app Dockerfile and a backup procedure**
  Deployment relies on Railway's Nixpacks autodetect; `docker-compose.yml` covers only
  Postgres and Redis. No documented Postgres backup/restore.

---

## Suggested execution order

**Week 1 — credibility floor**
~~#1, #1b, #2~~ (done) → #6, #7, #8 (one change kills four defects) → #5 → #3, #4.
Outcome: green CI, and money that actually moves correctly.

**Week 2 — close the domain gaps**
#9 (Decimal migration — after the logic is right, not before) → #12 (liquidation worker) →
#11 (DLQ) → #14 (tick/lot conversion).

**Week 3 — API and operability**
#20 (errors) → #21-#26 (security) → #30, #31 (logging and correlation IDs).

**Week 4 — prove it**
#37-#39 (the tests that would have caught Week 1's bugs) → #41-#45 (docs and hygiene).

Two sequencing notes:

- Pull #30 and #31 forward if #5 or #11 give trouble — those races are hard to diagnose
  without correlation IDs.
- Don't start #9 before #3-#8. Migrating to Decimal while the underlying arithmetic is still
  wrong means doing the migration twice.
