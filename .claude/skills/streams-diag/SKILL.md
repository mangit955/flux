---
name: streams-diag
description: Diagnose Redis Streams and outbox problems in this exchange - orders or cancels not processing, stuck messages, PEL limit errors, outbox events stuck PENDING or FAILED, broken consumer groups, orderbook not updating. Maps symptoms to the correct script in scripts/. Triggers on "orders not processing", "stuck", "PEL", "pending entry list", "consumer group", "outbox", "stream", "worker not picking up".
---

# Redis Streams & outbox diagnostics

The order pipeline is:

```
POST /orders → outbox row → OutboxPublisher → engine.commands.<market>
  → matching worker → engine.events.<market> → persistence worker → Postgres
```

A stall at any hop looks the same from the frontend: the order never appears. Find the hop
before changing code.

Full runbook with example output and thresholds: `scripts/README.md`.

## Start here

```bash
bun run diag          # outbox counts + stream lengths + consumer groups + PEL size
bun run diag:full     # deeper snapshot
```

Production needs the connection strings prefixed:

```bash
DATABASE_URL="..." REDIS_URL="..." bun run diag
```

## Symptom → action

| Symptom | Likely cause | Action |
|---|---|---|
| Orders or cancels not processing | Stuck messages in the Pending Entry List | `REDIS_URL="..." bun run cleanup:pel` |
| `diag` shows PEL `pending > 100` | PEL building up; Upstash caps at 1000/consumer | `bun run cleanup:pel` |
| Worker logs show a PEL limit error | Same | `bun run cleanup:pel`, then check why acks are lagging |
| Outbox `PENDING > 10` | `OutboxPublisher` stuck or not running | Check worker logs; confirm `WORKER_ROLE` includes outbox |
| Outbox `FAILED > 5` | Publish repeatedly erroring | Check worker error logs before retrying |
| Consumer group missing or broken | Group never created, or reset needed | `bun run init:redis`, then `bun run reset:consumers` |
| Messages delivered but never acked | Consumer died mid-processing | `bun run claim:pending` |
| Need to see raw stream contents | — | `bun run debug:streams` |
| Orderbook not updating in the UI | Matching worker not publishing to the Redis cache | Check `publishOrderBookToCache` runs; `bun run check:redis` |
| Redis connectivity unclear | — | `bun run test:redis` |
| DB state unclear | — | `bun run verify:db` |
| Live incident, want a running view | — | `bun run monitor` |
| Verify the fix end to end | — | `bun run test:production`, `bun run test:cancel <url> <token>` |

## Red flags from `diag`

- `PENDING > 10` — publisher stuck
- `FAILED > 5` — check error logs
- `pending > 100` — PEL building up

## Known traps

**Failed commands are acked and dropped.** `production-workers.ts:255-270` places the `ack()`
outside the try/catch, so a command that throws is acknowledged anyway. There is no DLQ. If an
order vanished with no trace in the event stream, this is why — and its collateral is still
locked. Search worker logs for `[MATCHING] Error processing message`. Fixing this is
`TODO.md` #11.

**`cleanupPendingEntries()` is a stub.** `production-workers.ts:212-222` logs
`"Skipping pending entries cleanup (disabled)"` and reports success. The PEL-limit error
handler calls it, so automatic recovery does nothing. Run `cleanup:pel` manually.
(`TODO.md` #17.)

**Snapshots are disabled in production.** Commit `75e509b` turned off file snapshots, so the
matching worker recovers by replaying from the database rather than snapshot+replay. Recovery
is slower than the design intends and gets slower as history grows. (`TODO.md` #36.)

**Never run two matching workers on the same market.** The orderbook is in process memory and
the consumer name defaults to a constant, so replicas split the command stream and build
divergent books that both write to the same Redis cache key. If the book looks impossible,
check the replica count first. (`TODO.md` #16.)

## Debugging is harder than it should be

There is no correlation ID threading an order through API → stream → worker → persistence, and
logging is unstructured `console.log` at ~10 lines/sec/market. Tracing one order currently
means grepping by order id across services and hoping it was logged. `TODO.md` #30 and #31
address this; do them before any deep investigation.
