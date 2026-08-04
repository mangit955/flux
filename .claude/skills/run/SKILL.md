---
name: run
description: Launch the Flux exchange locally or with full production wiring. Use when asked to run, start, boot, or demo the app, the API, the workers, the frontend, or the whole stack, or to verify a change works in the real app. Covers the RUNTIME_MODE split, Prisma setup, required env vars, and ports.
---

# Running Flux

Two modes, selected by `RUNTIME_MODE`. Default to **local** unless the task specifically needs
Postgres, Redis, or real market data.

---

## Local mode (default) — no infrastructure needed

`createApiApp()` uses `InMemoryApiRuntime` + `InMemoryStreamBus`, and `apps/api/src/index.ts`
drives `runtime.drain()` on a `setInterval`, so matching and persistence run in-process.

```bash
bun run --filter api dev     # http://localhost:3000, ws://localhost:3000/ws
bun run --filter web dev     # http://localhost:3001
```

The API dev script loads `../../.env` explicitly (`bun --env-file=../../.env`). There is no
root `.env.example` despite the README referencing one; local mode runs without it.

Worker cadence: `WORKER_INTERVAL_MS` (default 50ms for the API's in-process loop).

Frontend env — `apps/web/.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_WS_URL=ws://localhost:3000/ws
```
Without these it warns and falls back to those same defaults.

---

## Production wiring

### 1. Infrastructure
```bash
docker compose up -d postgres redis
```
Postgres `perp:perp@localhost:5432/perp_v3`, Redis `localhost:6379`. Both have healthchecks.

### 2. Database

The schema lives at the **repo root** (`prisma/schema.prisma`) but the scripts live in
`packages/db` and pass `--schema ../../prisma/schema.prisma`. Run them from there:

```bash
cd packages/db
bun run prisma:generate
bun run prisma:deploy      # or prisma:migrate for dev
bun run db:seed            # psql "$DATABASE_URL" -f ../../prisma/seed.sql — needs psql on PATH
```

### 3. Environment
```bash
RUNTIME_MODE=production
DATABASE_URL=postgresql://perp:perp@localhost:5432/perp_v3
REDIS_URL=redis://localhost:6379
JWT_SECRET=dev-secret-change-me
SNAPSHOT_DIR=./snapshots
BINANCE_WS_URL=wss://fstream.binance.com
```
`DATABASE_URL`, `JWT_SECRET`, and `REDIS_URL` are hard-required — `createProductionApiApp()`
throws on startup if any is missing. The rest have defaults.

### 4. Three processes
```bash
bun run --filter api dev            # API only; does NOT run workers in this mode
bun run --filter workers dev        # matching + persistence + outbox
bun run --filter market-data dev    # Binance mark prices → Redis
```

`WORKER_ROLE` selects which workers run (`matching`, `persistence`, `outbox`, or `all` —
default `all`).

**Run exactly one matching worker per market.** The orderbook is in process memory and the
consumer name defaults to the constant `"matching-engine-1"`, so two replicas split the command
stream and build divergent books writing to the same Redis cache key. Nothing prevents this
(`TODO.md` #16).

If Redis groups have not been created yet: `bun run init:redis`.

---

## Verifying it works

```bash
curl localhost:3000/health                        # {"ok":true}
curl localhost:3000/markets
curl -X POST localhost:3000/auth/guest            # returns { token, userId }
curl localhost:3000/markets/BTC-PERP/orderbook
```

Authenticated calls take `Authorization: Bearer <token>`.

In local mode, `POST /deposits` is enabled only when `NODE_ENV=development` — use it to fund a
test account before submitting orders.

Submit an order:
```bash
curl -X POST localhost:3000/orders \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"marketId":"BTC-PERP","side":"BUY","type":"LIMIT","quantity":1,"price":65000,"timeInForce":"GTC"}'
```
Returns 202 on accept, 400 on reject. Orders are matched asynchronously — poll `GET /orders`
or subscribe over the websocket.

## Load testing

```bash
brew install k6
k6 run load-tests/perpetual-futures-load-test.js   # API must already be running
```
Measures the HTTP submission path. Note it asserts latency, not correctness — it does not check
balance invariants, and the balance race (`TODO.md` #5) passes it.

## When things do not start

- API exits immediately in production mode → a required env var is missing; the error names it.
- `db:seed` fails → `psql` not on PATH.
- Orders accepted but never fill → workers not running, or Redis groups missing
  (`bun run init:redis`). See the `streams-diag` skill.
- Frontend shows no data → check `NEXT_PUBLIC_API_URL`; `/debug` renders the resolved config.
