---
name: dual-runtime
description: Checklists for changes that must be applied to BOTH the in-memory and production implementations in this repo. Read before adding or changing an API endpoint, a matching-engine event, a stream operation, a persistence operation, or a worker behavior. Triggers on "add endpoint", "new route", "new event", "engine event", "stream", "persistence", "worker", or any edit to api-runtime.ts, stream.ts, persistence-store.ts, or workers.ts.
---

# Dual-runtime changes

Nearly every subsystem here has **two implementations** — one in-memory for local dev and
tests, one backed by Postgres/Redis for production. `RUNTIME_MODE` picks between them at
startup (`apps/api/src/index.ts:6`).

This is a deliberate, good design: it is why the whole test suite runs with no Docker. It is
also the repo's single most error-prone pattern, because **updating one side and not the other
produces a bug that only appears in the environment you did not test.**

## The pairs

| Contract | In-memory | Production |
|---|---|---|
| `ApiRuntime` (17 methods) | `InMemoryApiRuntime` — `packages/runtime/src/api-runtime.ts` | `PrismaApiRuntime` — `packages/runtime/src/prisma-api-runtime.ts` |
| `StreamBus` / `AckingStreamBus` | `InMemoryStreamBus` — `packages/runtime/src/stream.ts` | `RedisStreamBus` — `packages/runtime/src/redis-stream-bus.ts` |
| `PersistenceStore` | `InMemoryPersistenceStore` — `packages/db/src/testing/in-memory-persistence-store.ts` | `PrismaPersistenceStore` — `packages/db/src/prisma-persistence-store.ts` |
| Workers | `MatchingWorker`, `RuntimePersistenceWorker` — `packages/runtime/src/workers.ts` | `ProductionMatchingWorker`, `ProductionPersistenceWorker` — `packages/runtime/src/production-workers.ts` |
| API app | `createApiApp()` — `apps/api/src/app.ts` | `createProductionApiApp()` — `apps/api/src/production.ts` |

Note the worker pair has already drifted: the production matching worker acks failed messages
and drops them (`production-workers.ts:255-270`), which the in-memory one does not do. Assume
drift exists; check both sides rather than trusting symmetry.

---

## Adding or changing an API endpoint

1. Route in `apps/api/src/app.ts` — match on `method` + `url.pathname`, return via the local
   `json()` / `jsonError()` helpers.
2. Method signature on the `ApiRuntime` interface (`api-runtime.ts:10-27`).
3. Implement in `InMemoryApiRuntime` (same file — delegates to `ExchangeRuntime` + `RuntimeStore`).
4. Implement in `PrismaApiRuntime` (`prisma-api-runtime.ts`) — and add any new Prisma model
   methods to the hand-rolled `PrismaApiClient` / `PrismaApiTransaction` interfaces at the top
   of that file, or the call will not type-check.
5. Test in `apps/api/src/app.test.ts`.

**Auth:** every user-scoped route must call `runtime.authenticate(authToken(request))` and scope
the query by that user id. `getOrder` / `listFills` show the ownership-check pattern.

**Watch out:** route matching is ordered `if` statements, so a regex like
`/^\/orders\/([^/]+)$/` will shadow a later literal path. Put literals before patterns.

## Adding a matching-engine event

1. Add the event type to `packages/matching-engine/types/event.ts` and to the `EngineEvent` union.
2. Emit it from the relevant path in `packages/matching-engine/src/orderbook.ts`.
3. **Add a case to `applyReplayEvent` in the same file.** This is the easiest step to miss and
   the most damaging: the switch is exhaustive over the event union, so a missing case may
   type-error — but if you add it to a catch-all `return`, crash recovery silently diverges
   from live state and you will not notice until a restart.
4. Handle it in `packages/db/src/persistence-service.ts`.
5. Add any new store operation to **both** `PersistenceStore` implementations.
6. Tests: `packages/matching-engine/index.test.ts`, `recovery.test.ts` (assert replay
   reproduces live state), and `packages/db/src/persistence-service.test.ts`.

The engine's recovery guarantee depends on `snapshot → replay` reproducing an identical book,
including identical treap shape (`priorityForPrice` is a deterministic hash of the price, not
`Math.random()`, precisely so this holds). Do not break that.

## Adding a stream operation

1. Add to `StreamBus` or `AckingStreamBus` in `packages/runtime/src/stream.ts`.
2. Implement in `InMemoryStreamBus` (same file).
3. Implement in `RedisStreamBus` (`redis-stream-bus.ts`).

Keep the in-memory version faithful to Redis Streams semantics — ordering, `readAfter` cursor
behavior, consumer-group delivery. The whole point of the abstraction is that code cannot tell
which one it is talking to.

If you find yourself reaching for `(bus as any).trimStream(...)` — as
`production-workers.ts` currently does — add the method to the interface instead.

## Adding a persistence operation

1. Add to the `PersistenceStore` interface (`packages/db/src/persistence-store.ts`).
2. Implement in `InMemoryPersistenceStore` and `PrismaPersistenceStore`.
3. All writes for one engine event go in a single transaction — `PersistenceService` owns that
   boundary; do not open your own.

---

## Before you finish

- [ ] Both implementations of every contract you touched are updated.
- [ ] New Prisma model access is declared on `PrismaApiClient` / `PrismaApiTransaction`.
- [ ] New engine events have an `applyReplayEvent` case.
- [ ] A test exercises the in-memory path; note in the PR/commit if the Prisma path is untested
      (it usually is — `PrismaApiRuntime` has no test file).
- [ ] Run the `verify` skill.
- [ ] If the change touches money, also read the `money-path` skill.

## Import convention

Backend cross-package imports use **relative paths into `src/index`**, not workspace package
specifiers:

```ts
import { ExchangeRuntime } from "../../../packages/runtime/src/index";
```

Match the surrounding files rather than introducing `import ... from "runtime"`.
