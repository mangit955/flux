# TODO

Engineering backlog from a code review of the exchange backend. Ordered by tier;
Tier 0 and Tier 1 are correctness issues in the money path and block everything else.

File references are `path:line` — re-verified against source on 2026-08-05, but they drift with
every edit, so confirm before acting on one.

Every open item below was checked against the code on 2026-08-05. Claims that could not be
verified locally are marked as such inline rather than stated as fact.

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
  `packages/db/src/persistence-service.ts:279` (`fee: 0`), `:342`, `:358` (`fee: "0"`).
  Fills are written with a hardcoded zero fee **in the production path**, so the exchange
  collects nothing while `checkOrderMargin` reserves `requiredFee` on every order.
  Compute maker/taker fee from `market.makerFeeRate` / `takerFeeRate`, debit `balance.total`,
  write a `LedgerEntry`.

  **This is a dual-runtime change.** The in-memory path already charges a fee:
  `packages/runtime/src/workers.ts:294` computes
  `tradeValue * (makerFeeRate | takerFeeRate)` and debits it at `:302`. The two
  implementations must end up agreeing — see the `dual-runtime` skill. Note both paths pass
  `fee: 0` into `applyFillToPosition` (`workers.ts:278`, `persistence-service.ts:279`), so the
  fee is currently excluded from the position's realized-PnL accounting in both.

- [ ] **4. Settle realized PnL into balances**
  `persistence-service.ts:343`, `:359` (`realizedPnl: "0"` on the fill rows).
  `applyFillToPosition` computes realized PnL correctly and it *is* persisted on the position
  row — `next.realizedPnl` accumulates at `packages/risk/src/position-engine.ts:90-92` and is
  written by `positionToWrite` (`persistence-service.ts:419`). What never happens is
  **settlement into `balance.total`**, so a user can open a position, have it move in their
  favour, close it, and receive nothing spendable.
  Persist it on the fill *and* credit `balance.total` in the same transaction.

- [ ] **5. Fix the lost-update race on `balance.locked`**
  `packages/runtime/src/prisma-api-runtime.ts:360-392` and
  `packages/db/src/prisma-persistence-store.ts:239-273`.
  Read-modify-write with no row lock, no atomic increment, and default READ COMMITTED
  isolation. Two concurrent orders both read `locked`, both pass the check, second write wins.
  Use `SELECT ... FOR UPDATE` or Prisma `{ increment }`, and add a DB
  `CHECK (locked <= total)` constraint as a backstop.

- [x] **6. Stop hardcoding `leverage = 10` in the unlock path**
  Fixed together with #7 and #8, since all three lived in the same five blocks. `orders` now
  carries `lockedMargin` and `leverage` (`prisma/schema.prisma:183-184`, migration
  `20260805000000_order_locked_margin`), written at submit time from the value the lock side
  already computed (`prisma-api-runtime.ts:331` → `:400-402`). All five reconstructions are
  replaced by one `releaseOrderMargin()` helper (`persistence-service.ts:199-223`) that
  releases the *recorded* amount and zeroes the column in the same transaction, which also
  makes double-release impossible.

  The two `emptyPosition(userId, market, 10)` sites went with it: both now read the order's
  stored leverage (`persistence-service.ts:252`, `workers.ts:274`). `RuntimeOrder` gained a
  `leverage` field so the in-memory path carries it too.

- [x] **7. Fix market orders leaking 100% of locked margin**
  Same fix — the release no longer touches `order.price`, so a null price is irrelevant.

  Correction to this item's premise: `MARKET_LIQUIDITY_EXHAUSTED` is emitted by `orderExpired`
  (`packages/matching-engine/src/orderbook.ts:97-101`), so the routine leak ran through the
  `order.expired` block, not `order.rejected` — `order.rejected` only comes from
  `validateNewOrder` (`orderbook.ts:77-79`). Both paths are fixed.

- [x] **8. Use `market.quoteAsset` instead of hardcoded `"USDC"`**
  `MarketWrite` had no `quoteAsset` field at all; it was added (`records.ts:73`) and is mapped
  from the row in `PrismaPersistenceStore.findMarket`. The redundant `marketData` lookup in the
  cancel block went with the rest of that block.

  Covered by six tests in `persistence-service.test.ts`, each verified to fail against the old
  reconstruction before being kept. `InMemoryPersistenceStore` now tracks balances for real
  (it previously stubbed the unlock with a `console.log`), so the `locked <= total` invariant is
  actually asserted. `PrismaApiRuntime`'s lock-write half remains untested — see #37.

- [ ] **9. Get money off floats**
  `prisma-api-runtime.ts:681` (`decimal()` → `Number`), writes via `String(number)`.
  `roundFinancial` (= `toFixed(12)`) patches the symptom.
  The schema is correctly `Decimal(36,18)` and every boundary throws that away.
  `String(1e-7)` also emits exponential notation Prisma can't parse.
  Move to `Prisma.Decimal` or fixed-point integers end-to-end; delete `roundFinancial`.
  **Do this after #3-#8** — migrating while the logic is still wrong means doing it twice.

  `roundFinancial` is copy-pasted into **five** files, each a private definition, so this is
  five deletions and not one: `margin.ts:185`, `liquidation.ts:285`, `ledger.ts:84`,
  `funding.ts:200`, `position-engine.ts:189`.

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
  `createAdlActions`, plus `isMaintenanceMarginViolated` (which lives in
  `packages/risk/src/margin.ts:116`, not in `liquidation.ts`), have **zero production
  callers** — verified: no references outside `packages/risk`. The system offers 20x
  leverage with no mechanism to close underwater positions, and the insurance fund table is
  never written to. README claims Phase 5 is implemented.
  A worker that scans positions against mark price and submits liquidation orders is roughly
  200 lines; the functions are already written and unit-tested.

- [ ] **13. Wire up funding**
  `packages/risk/src/funding.ts` — `applyFundingPayments`, `shouldExecuteFunding`,
  `calculateFundingRate` have zero production callers. README claims Phase 4 is implemented.
  Add a scheduled worker on the `fundingIntervalHours` cadence.

- [ ] **14. Convert floats to ticks/lots at the API boundary**
  `prisma-api-runtime.ts:345-346` — `qtyLots: input.quantity`, `priceTicks: input.price` pass
  raw floats straight from JSON into the engine's integer domain. `market.tickSize` and
  `market.lotSize` are loaded in `mapMarket` (`:606-607`) and never used for conversion
  anywhere.
  This voids every guarantee the engine's integer design provides and makes the type names lie.
  Convert: `qtyLots = round(qty / lotSize)`, `priceTicks = round(price / tickSize)`.
  Reject non-aligned input with a 400.

- [ ] **15. Resolve the duplicate margin-rate source of truth**
  `prisma/schema.prisma:123` defines `initialMarginRate` per market;
  `initialMarginForOpenOrder` (`packages/risk/src/margin.ts:130-141`) uses
  `price * qty / leverage` and never reads it. Pick one and delete the other.

- [ ] **16. Prevent matching-engine split brain**
  `production-workers.ts` holds the orderbook in process memory and reads with
  `consumerName ?? "matching-engine-1"` (`:230`) — a constant default. Two replicas share a
  consumer group, so Redis splits commands between them and each builds a different book from
  a different subset of orders, both writing to the same Redis cache key.
  Add leader election (Redis lock with a fencing token) or explicit market partitioning, plus
  a startup guard that refuses to run if the lock is held.

  The persistence worker has the same defect and is worse: `:362` hardcodes
  `consumerName = "persistence-worker-1"` as a constructor default with no option to override
  it at all.

- [ ] **17. Fix or delete `cleanupPendingEntries()`**
  `production-workers.ts:215-222` is a stub that logs `"Skipping pending entries cleanup
  (disabled)"` and sets `pendingCleanupComplete = true`. Both `recover()` (`:69`) and the
  PEL-limit error handler (`:288`) call it, so the recovery path is a no-op that reports
  success.
  Implement with `XAUTOCLAIM` or remove it and the call site.

- [ ] **18. Stop failing open on orderbook reads**
  `prisma-api-runtime.ts:520-533` — a Redis error logs and returns
  `{ bids: [], asks: [] }`. Clients can't distinguish "no liquidity" from "cache is down", and
  `resolveMarketOrderRisk` depends on this data to price margin. Fail closed (503) on
  risk-input paths.

- [ ] **19. Add graceful shutdown**
  `setInterval` loops in `apps/api/src/index.ts:51` and `apps/workers/src/index.ts:27` with no
  SIGTERM handler — there is no `process.on(...)` signal handler anywhere in the backend.
  Railway sends SIGTERM on every deploy, which can kill the process between
  "engine applied the command" and "events appended to the stream", losing fills silently.

---

## Tier 3 — API, security, and interface quality

- [ ] **20. Fix error handling**
  `apps/api/src/app.ts:196-200`. Every error except the single literal message
  `"unauthenticated"` becomes a 400 (`:198` is `message === "unauthenticated" ? 401 : 400`),
  with the internal message string-mangled into an error code via
  `toUpperCase().replaceAll(" ", "_")`.
  `"invalid credentials"` (`prisma-api-runtime.ts:107, 114`) therefore returns 400 instead of
  401; adding a period to a message is a breaking API change. A Prisma connection failure is
  expected to surface as a mangled 400 too, but the exact code depends on Prisma's runtime
  error text and has not been reproduced against a live DB.
  Use typed error classes with explicit status mapping — reuse the rejection-reason union
  pattern already used in the matching engine.

- [ ] **21. Authenticate `POST /admin/drain`**
  `app.ts:190` — no auth check at all. Add an admin token or remove it from the production app.

- [ ] **22. Harden `POST /auth/guest`**
  `prisma-api-runtime.ts:128-146` creates a real user row and runs a password hash,
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
  `DUPLICATE_ORDER_ID` (`packages/matching-engine/src/orderbook.ts:226`) but can't help
  because the API generates the ID server-side.

  **The schema half is already done** — `clientOrderId String?` exists at
  `prisma/schema.prisma:174` with `@@unique([userId, clientOrderId])` at `:193`. No migration
  needed. What's missing is entirely in the API: accept `Idempotency-Key` / `clientOrderId`,
  persist it, and return the existing order on a repeat.

- [ ] **26. Validate order payloads with a schema**
  `app.ts:239-254` (`normalizeOrderInput`) uses bare `Number()` coercion, so `Number("abc")`
  → `NaN` reaches the engine. Only `riskPrice` is finite-checked
  (`prisma-api-runtime.ts:282`); `input.quantity` is never validated on the submit path.
  Add Zod or equivalent at the boundary.

- [ ] **27. Restore type safety in the Prisma adapter**
  `prisma-api-runtime.ts:34-77` hand-rolls an interface where every method returns `unknown`,
  read through `field()` casts at `:681`. Also `listPositions(): Promise<unknown[]>` in the
  public `ApiRuntime` interface (`packages/runtime/src/api-runtime.ts:22`), and
  `(this.options.bus as any).trimStream` in `production-workers.ts:281`.
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
  72 `console.*` call sites across backend packages (44 of them `console.log`), excluding
  `apps/web` and tests. Emoji logs per order (`🔒 Locked ...`) and
  `[MATCHING] Reading from ...` on every 100ms poll per market — roughly 10 lines/sec/market
  of noise with no levels, no structure, no sampling. Real errors are unfindable.
  (Commit `8a8bc5f` fixing plaintext password logging has the same root cause.)

- [ ] **31. Thread a correlation ID through the pipeline**
  API → stream → worker → persistence currently share no request or order ID, which is exactly
  why the Tier 1 bugs are hard to see in logs. Do this **before** debugging #5 and #11.

- [ ] **32. Add metrics**
  No counters, no histograms, no `/metrics` endpoint. There's currently no way to answer
  "how many orders failed today".

- [ ] **33. Stop republishing the orderbook snapshot every 100ms**
  `production-workers.ts:298-315` — `publishOrderBookToCache` runs unconditionally on every
  poll per market, serializing and writing a **top-20** snapshot
  (`getBookSnapshot(market, 20)`, `:304`) regardless of whether anything changed.
  Not the whole book, so the per-call cost is bounded — but it is still a serialize plus a
  Redis round trip per market per 100ms with no change detection.
  Publish on change and use the sequence numbers already present in the snapshot type for
  incremental diffs.

- [ ] **34. Bound the tree traversal recursion**
  `packages/matching-engine/src/price-level-tree.ts:171-205` — the private `visitAscending` /
  `visitDescending` methods recurse with no depth bound (self-calls at `:181`, `:187`, `:199`,
  `:205`). A degenerate treap shape means stack depth proportional to price-level count.
  Note the matching worker is *not* an unbounded caller: it goes through
  `getBookSnapshot(market, 20)` → `snapshot(20)` → `valuesBestFirst(20)`. The unbounded risk
  is `valuesBestFirst()` / `snapshot()` called with no `depth` argument — both parameters are
  optional (`price-level-tree.ts:78`, `orderbook.ts:155`).

- [ ] **35. Add timeouts**
  No HTTP request timeout, no DB statement timeout, no Redis command timeout.

- [ ] **36. Re-enable snapshot-based recovery in production**
  Commit `75e509b` ("Disable file snapshots completely in production - use Redis cache only")
  disabled file snapshots in production. The recovery system is designed, implemented, and
  tested — and then switched off where it actually matters.
  `ProductionMatchingWorker` is constructed without `snapshotStore`
  (`apps/workers/src/index.ts:93-98`), so `maybeSnapshot` returns early forever. The
  `FileSnapshotStore` import at `apps/workers/src/index.ts:13` is now dead and type-checks
  clean only because `noUnusedLocals` is `false`.

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
  52 occurrences of `: any` / `as any` / `@ts-ignore` / `@ts-expect-error`.

- [ ] **47. Add an app Dockerfile and a backup procedure**
  Deployment relies on Railway's Nixpacks autodetect; `docker-compose.yml` covers only
  Postgres and Redis. No documented Postgres backup/restore.

---

## Suggested execution order

**Week 1 — credibility floor**
~~#1, #1b, #2~~ → ~~#6, #7, #8~~ (done — one change fixed all three across the same five blocks)
→ #5 → #3, #4. Outcome: green CI, and money that actually moves correctly.

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
