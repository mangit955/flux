# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Flux — a centralized perpetual futures exchange. Turborepo + Bun workspaces monorepo: TypeScript
backend packages (matching engine, risk, persistence, websocket, runtime wiring), Bun-served API,
worker processes, and a Next.js trading frontend.

## Toolchain

Bun is the runtime, package manager, and test runner (see `packages/matching-engine/.cursor/rules/`).
Use `bun <file>`, `bun test`, `bun install`, `bunx`, `bun run <script>` — not node/npm/pnpm/vite/jest.
Backend code uses Bun built-ins (`Bun.serve`, `Bun.env`, `Bun.file`) rather than express/dotenv.
Exception: `ioredis` is used deliberately in `packages/runtime` for Redis Streams consumer groups.

## Commands

```bash
bun test                              # all tests (bun:test, colocated *.test.ts)
bun test packages/risk/src/margin.test.ts   # single file
bun test -t "partial fill"            # by test name

bun run check-types                   # turbo: tsc --noEmit across workspaces
bunx tsc --noEmit -p packages/risk/tsconfig.json   # one workspace
bun run lint                          # turbo lint (only web/ui/docs have eslint)
bun run format                        # prettier

docker compose up -d postgres redis
cd packages/db && bun run prisma:generate && bun run prisma:deploy && bun run db:seed

bun run --filter api dev              # API on :3000 (loads ../../.env)
bun run --filter web dev              # frontend on :3001
bun run --filter workers dev          # standalone workers
bun run --filter market-data dev      # Binance mark-price ingestion
```

Operational scripts live in `scripts/` and are exposed as root package scripts:
`bun run diag`, `diag:full`, `monitor`, `verify:db`, `check:redis`, `init:redis`,
`cleanup:pel`, `reset:consumers`, `claim:pending`, `debug:streams`, `test:production`.
Load tests: `k6 run load-tests/perpetual-futures-load-test.js` (API must be running).

## Verification rules — non-negotiable

`.github/workflows/ci.yml` runs `bun test`, `bun run check-types`, and `docker compose config`
on push to `main` and every PR. Green baseline: **108 tests pass, 10/10 workspaces type-check.**
The `verify` skill wraps the full gate.

1. **Run the gate before saying a change is done**, and run it *after* the last edit — not
   before. A change is not complete because it looks right; it is complete when the gate is
   green.

2. **Never carry a red gate.** There is no "pre-existing failure" exemption. `main` previously
   accumulated both a stale assertion and a type error precisely because the gate was optional,
   and once it was red every later green result became meaningless. If you cannot fix a failure
   now, say so explicitly and do not commit.

3. **Verify claims against source before asserting them.** Read the code that produces the
   behavior — do not infer it from a test diff, a log line, a stack trace, or memory of how a
   library works. State findings as `file:line`. If something cannot be checked locally (a
   GitHub Action version, a hosted service), say so explicitly rather than asserting it.

4. **Do not hand-manipulate generated or gitignored directories** — `.next/`, `dist/`,
   `.turbo/`, `node_modules/`, `snapshots/`. They are build output: regenerate them, never
   shuffle them with `mv`/`rm`. In particular `mv <dir> <existing-dir>` nests instead of
   replacing, which silently corrupts state and produces failures that look like real bugs.
   To test a clean checkout, use an isolated copy:

   ```bash
   git worktree add /tmp/flux-clean HEAD    # or: git clone . /tmp/flux-clean
   ```

   Never simulate one by deleting parts of the working tree.

5. **After replacing a block with Edit, confirm the old text is gone and not duplicated.**
   Block replacements in files with repeated phrasing silently leave two copies.

6. **A failure caused by your own scratch state is not a finding.** Clean up, re-run, and only
   then report.

7. **Changes to paired subsystems must touch both implementations** — see the two runtime modes
   below and the `dual-runtime` skill. Type checks alone will not catch a missed one, because
   the Prisma adapters are typed through `unknown`.

Money-path changes carry additional invariants; see the `money-path` skill before editing
balances, margin, fills, PnL, fees, or the ledger.

## Two runtime modes — the central architectural fact

`RUNTIME_MODE` switches the entire wiring, and nearly every subsystem has paired
in-memory and production implementations. Changing behavior usually means touching both.

**Local (default):** `apps/api/src/index.ts` → `createApiApp()` uses `InMemoryApiRuntime` +
`InMemoryStreamBus`, and drives `runtime.drain()` on a `setInterval` so matching and persistence
run in-process. No Postgres/Redis needed.

**Production (`RUNTIME_MODE=production`):** `apps/api/src/production.ts` → `PrismaApiRuntime`
backed by Postgres, with `RedisPriceCache` / `RedisOrderBookCache`. Workers run as a separate
process (`apps/workers`) using `RedisStreamBus` consumer groups; `WORKER_ROLE` selects
matching / persistence / outbox / `all`.

The in-memory `StreamBus` interface deliberately mirrors Redis Streams semantics
(`append` / `readAfter`, plus `AckingStreamBus.readGroup` / `ack`) so the adapters are swappable.

## Order flow

1. `POST /orders` → `ApiRuntime` validates auth and margin (`packages/runtime/market-order-risk.ts`),
   persists the order, and appends a command to `engine.commands.<market>`.
2. Matching worker consumes commands, applies them to the `MatchingEngine`
   (`packages/matching-engine` — per-market `OrderBook` over a `PriceLevelTree`), and appends
   resulting `EngineEvent`s to `engine.events.<market>`.
3. Persistence worker consumes events and writes fills/positions/balances via
   `PersistenceService` (`packages/db`), plus outbox rows.
4. `OutboxPublisher` drains `PENDING` outbox rows and fans them out to the websocket hub.
5. `apps/market-data` ingests Binance mark prices into the `price.updated` stream / Redis price cache.

Recovery: `packages/matching-engine/src/recovery.ts` + `FileSnapshotStore` rebuild books from
snapshots in `SNAPSHOT_DIR` (`./snapshots`) replayed forward with the event stream.

## Package map

- `packages/matching-engine` — pure in-memory orderbook, price-time priority, snapshots/recovery. No I/O.
- `packages/risk` — margin, positions/ledger, funding, liquidation, ADL. Pure functions, heavily tested.
- `packages/db` — Prisma-schema-derived record types, mappers, `PersistenceService` over a
  `PersistenceStore` port (`PrismaPersistenceStore` in prod, `InMemoryPersistenceStore` in `src/testing/`).
- `packages/websocket` — subscription hub, `Bun.serve` websocket handlers, topic naming
  (`topics.ts`; `positions`/`balances`/`orders` are private and require an authenticated user).
- `packages/runtime` — the wiring layer where the two modes converge: stream buses, caches,
  API runtimes, workers, JWT auth.
- `apps/web` — Next.js trading UI; talks to `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL`.

Note that backend cross-package imports use relative paths into `../../../packages/<name>/src/index`,
not workspace package specifiers.

## Conventions

- Prisma schema and migrations live at repo root (`prisma/`), but the scripts that operate on them
  are in `packages/db` and pass `--schema ../../prisma/schema.prisma`.
- Tests are colocated `*.test.ts` next to the module and use in-memory ports rather than live
  Postgres/Redis — keep new subsystems testable that way.
- The style favors explicit modules and small service boundaries over abstraction layers;
  match the surrounding code rather than introducing frameworks or DI.
- Root markdown is deliberately limited to three files: `README.md` (setup and verification),
  `CLAUDE.md` (this file), and `TODO.md` (the engineering backlog). The previous eight
  overlapping design docs were removed. Do not reintroduce root-level `*.md` — this file and
  the package READMEs (`packages/*/README.md`, `scripts/README.md`) are where architecture and
  runbook detail belongs.
