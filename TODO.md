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

- [x] **2b. Fix `RedisStreamBus.readGroup` silently discarding every message**
  **Production could not match a single order.** `XREADGROUP` is the one stream reply whose
  shape depends on the protocol version: RESP2 returns `[[stream, entries], ...]`, RESP3 returns
  a map keyed by stream name. Bun's Redis client negotiates RESP3, and `decodeXReadGroupRows`
  began with `if (!Array.isArray(rows)) return result` — so it returned zero messages for
  commands Redis had already delivered into the PEL. Symptom: `last-delivered-id` advances, the
  PEL grows, `[MATCHING] Read 0 messages` forever, no errors, and no engine events; submitted
  orders locked margin and then vanished.
  The decoder now accepts both shapes. `XRANGE` and `XAUTOCLAIM` return arrays under both
  protocols and were unaffected — verified against a live Redis 7.

  The existing test passed throughout because it hand-fed the RESP2 array form; there is now a
  RESP3 case alongside it. Found while running the end-to-end verification for #3/#4/#5, which
  could not otherwise get a single fill.

---

## Tier 1 — Correctness in the money path

- [x] **3. Charge fees on fills**
  Fees are now computed per liquidity role in `applyRoleFillToPosition`
  (`persistence-service.ts`) — maker at `makerFeeRate`, taker at `takerFeeRate` — written to the
  fill row, debited from `balance.total`, and recorded as a `TRADING_FEE` ledger entry, all in
  the transaction `PersistenceService` already owns. Both runtimes now pass the real fee into
  `applyFillToPosition`, so the position's realized PnL is net of fees in both.

  The in-memory pair (`workers.ts`) was reworked to match, including its `fee: 0` placeholder on
  the fill row. `apps/api/src/app.test.ts` asserts the in-memory numbers, which is the guard
  against the two runtimes drifting again.

  Verified against live Postgres: on a 1 @ 59.91 trade the maker paid 0.011982 (× 0.0002) and
  the taker 0.029955 (× 0.0005), with matching `TRADING_FEE` rows.

- [x] **4. Settle realized PnL into balances**
  `settleRoleFill` credits the gross `realizedPnlDelta` to `balance.total` and writes a
  `REALIZED_PNL` ledger entry; the fill row carries the delta instead of `"0"`. No double
  counting: the balance receives gross PnL minus fee, and the position row records the same net
  figure via `applyFillToPosition`.

  A loss exceeding collateral now drives the balance negative and logs, rather than being
  clamped away (which silently forgives the shortfall) or thrown (which the persistence worker
  would swallow, dropping the fill — see #11). Bad debt is #12's to resolve.

  Verified against live Postgres: closing a long from 59.91 to 99.23 moved the balance
  9999.970045 → 10039.240430 (+39.32 gross, −0.049615 fee), left the position FLAT with
  `realizedPnl` 39.240430 net of both fees, and the counterparty took the exact mirror.

- [x] **5. Fix the lost-update race on `balance.locked`**
  The lock is a single conditional statement — `UPDATE ... SET locked = locked + $1 WHERE total
  - locked >= $1` — so check and write cannot be separated by a concurrent transaction; rowcount
  0 means insufficient funds. The unlock side uses a `FOR UPDATE` CTE that still returns the
  previous value, keeping the over-release check. Both keep the arithmetic in Postgres `numeric`
  instead of round-tripping through a float, which is a step toward #9.

  The DB backstop is `CHECK ("locked" >= 0)`, **not** `CHECK (locked <= total)`. The latter
  aborts legitimate settlement: total 1000, `locked` 900 for other open orders, a realized loss
  of 200 → total 800 < locked 900 → the transaction rolls back and the worker drops the fill.
  It would also forbid the negative totals that record bad debt. `locked` only ever increases in
  the conditional lock statement above, which enforces `locked <= total` structurally.

  Verified against live Postgres: 20 concurrent submissions against a 10 USDC balance produced
  exactly 9 accepted and 11 `INSUFFICIENT_AVAILABLE_BALANCE`, with `locked` 9.045 — exactly the
  sum of the 9 orders' recorded `lockedMargin`. Neither raw statement is reachable from
  `bun test`, which runs on the in-memory store; #38 is the automated version of that check.

- [x] **5b. Add the missing `WITHDRAW` ledger enum value**
  `LedgerEntryType` had no `WITHDRAW` member, but `prisma-api-runtime.ts` writes
  `type: "WITHDRAW"` — so against a real Postgres every withdrawal failed at the ledger insert
  and rolled the whole transaction back. Added in the same migration; a live withdrawal now
  succeeds and writes its ledger row. Found while verifying #3/#4.

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

- [ ] **8b. Stop reserving the taker fee on orders that can only be makers**
  `estimatedFeeForOpenOrder` (`packages/risk/src/margin.ts:143`) uses `order.estimatedFeeRate`,
  and both submit paths pass `market.takerFeeRate` unconditionally
  (`prisma-api-runtime.ts:309, 319`; `exchange-runtime.ts:147`). A post-only order can never be
  a taker, so it over-reserves margin — at the seeded rates, 2.5x the fee it will actually pay.
  Harmless to correctness now that the release returns the recorded amount (#6), but it is
  collateral held for no reason on exactly the orders that provide liquidity.
  Found while implementing #3.

- [x] **9. Get money off floats** — done.
  Money is now `Decimal` (decimal.js) from the Postgres column through the risk calculations and
  back. One shared module, `packages/risk/src/decimal.ts`, replaces all **eight** private
  helpers: five `roundFinancial` (`margin.ts`, `liquidation.ts`, `ledger.ts`, `funding.ts`,
  `position-engine.ts`) and three `decimalString` (`persistence-service.ts`,
  `funding-payment-mapper.ts`, `liquidation-mapper.ts`). Writes go through
  `toDecimalString` (`toFixed(18)`), so every column holds one canonical representation.

  **Correction to this item's original premise.** It claimed `String(1e-7)` → `"1e-7"` was
  "exponential notation Prisma can't parse". That is false, measured against Postgres 16 and
  Prisma 6.19: both accept `"1e-7"` and store it correctly. `toFixed(18)` is normalization, not
  a crash fix. The real `Decimal(36, 18)` edges are that values below 1e-18 truncate silently to
  zero and values at or above 1e18 raise `numeric field overflow` — neither notation-related.

  Not `Prisma.Decimal`: CI never runs `prisma generate` (`.github/workflows/ci.yml`) and the
  Prisma adapters are typed through `unknown` precisely so packages never import
  `@prisma/client`.

  Scope was the money core. `Decimal` is converted back to `number` at the API/websocket edge,
  so the HTTP contract and `apps/web` are unchanged. Two leaks found and closed while doing it:
  `RuntimeMarket extends MarketRiskConfig` put Decimal rates on `GET /markets`
  (`types.ts:60`), and `store.positions` reached the websocket `positions` channel and
  `GET /positions` — the latter typed `Promise<unknown[]>`, so tsc could not have caught it.
  `RuntimeMarket` now stands alone with a `toRiskConfig()` converter, and both position paths
  go through `RuntimePosition` DTO mappers.

  Verified end to end against Postgres 16 on a clean database, workers in `RUNTIME_MODE=production`:
  a 0.1 @ 59.91 limit order at 3x locked `1.999995500000000000` with `orders.lockedMargin` and
  `balances.locked` byte-identical (exactly `5.991/3 + 5.991 x 0.0005`); cancelling returned
  `locked` to `0.000000000000000000` with `total` unchanged; a 1 @ 59.91 fill charged maker
  0.011982 and taker 0.029955; closing at 99.23 left the taker at 10039.240430 with
  `realizedPnl` 39.240430 and the maker at the exact mirror. Books conserved to the digit —
  deposits 30000 minus fees 0.111398 equalled total balances 29999.888602 — with every money
  column at scale 18 and zero exponential values. `GET /markets` still returns plain JSON
  numbers, which is the regression the `RuntimeMarket` decoupling exists to prevent.

  Also corrected: `roundFinancial(12)` masked drift better than the original note implied — it
  holds up under symmetric lock/release at small magnitudes. The demonstrable defects it could
  *not* cover are the exponential-notation write above, and precision loss once a balance is
  large enough to exhaust a float's ~15-17 significant digits (a 1e9 balance debited 100 × 1e-7
  lands on 999999999.9999881 instead of 999999999.99999). Both are pinned by tests in
  `packages/db/src/money-invariants.test.ts`.

- [ ] **9c. Engine event IDs collide after recovery, stranding margin**
  Found while running #9's end-to-end verification. `eventId` is `${market}-${sequence}` and the
  engine's sequence counter restarts from zero when `recovery.ts` rebuilds the book, so a fresh
  event can reuse an ID that `processed_events` already holds. `PersistenceService.persistEvent`
  treats that as a duplicate and returns `status: "skipped"`, silently dropping the write.
  Observed live: a rejected order emitted `BTC-PERP-20`, which matched a row processed four
  hours earlier, so the order stayed `PENDING` and its `1.9999955` stayed locked with no error
  logged anywhere. Unrelated to the Decimal work — it predates it and would strand collateral on
  any event type. Make the ID unique per run (include the recovery epoch or a ULID).

- [ ] **9d. Recovery loads `PENDING` orders into the book before they are matched**
  Also found during #9 verification. `recoverOrderBook` pulled 24 orders where only 9 were
  `OPEN`, including `PENDING` ones whose `order.created` command had not been consumed yet. When
  the command then arrived the engine rejected it `DUPLICATE_ORDER_ID`, because recovery had
  already inserted that order id. Any restart between an order's DB write and its command being
  consumed loses that order. Recovery should load only orders the engine has actually accepted.

- [ ] **9b. The matching engine still does float arithmetic**
  Out of scope for #9 by decision, and worth its own item. `orderbook.ts:285-287` subtracts fill
  quantities in float (`maker.remainingQtyLots -= qtyLots`), and `PriceLevelTree` keys levels on
  `number` (`price-level-tree.ts:2-6`). Despite the `Ticks`/`Lots` naming these carry raw human
  quantities (`prisma-api-runtime.ts` passes `input.quantity` and `input.price` straight
  through), so partial fills can leave a residue rather than closing to exactly zero.
  Persistence parses these values exactly at the boundary (`persistence-service.ts`,
  `workers.ts`), so the drift cannot spread past the engine, and `isDust`
  (`position-engine.ts`) still exists to absorb it — but the engine's own books remain
  approximate. Fixing it means converting the matching hot path, the price-keyed tree, and the
  snapshot/recovery format together.

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

**Week 1 — credibility floor** — done.
~~#1, #1b, #2~~ → ~~#6, #7, #8~~ (one change fixed all three across the same five blocks)
→ ~~#5~~ → ~~#3, #4~~. Outcome: green CI, and money that actually moves correctly.
Tier 1 now has #10, #11 and the newly found #8b left; #9 is done, and surfaced #9b.

**Week 2 — close the domain gaps**
~~#9 (Decimal migration — after the logic is right, not before)~~ → #12 (liquidation worker) →
#11 (DLQ) → #14 (tick/lot conversion). #9b (engine floats) pairs naturally with #14, since both
are about the engine's tick/lot representation.

**Week 3 — API and operability**
#20 (errors) → #21-#26 (security) → #30, #31 (logging and correlation IDs).

**Week 4 — prove it**
#37-#39 (the tests that would have caught Week 1's bugs) → #41-#45 (docs and hygiene).

Two sequencing notes:

- Pull #30 and #31 forward if #5 or #11 give trouble — those races are hard to diagnose
  without correlation IDs.
- #9 was correctly sequenced after #3-#8: the release path had to record `lockedMargin` before
  the migration, or the exactness work would have been redone.
