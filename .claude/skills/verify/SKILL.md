---
name: verify
description: The pre-commit verification gate for this repo. Run before every commit or push, after finishing any change, or when asked "is this ready", "check my work", "can I commit this". Runs the full test suite, type checks every workspace, validates docker compose, and checks for whitespace errors.
---

# Verify

Run this before every commit. No exceptions.

## The gate

Run all four from the repo root, in order:

```bash
bun test                             # full suite, all workspaces
bunx turbo run check-types --force   # tsc --noEmit across every workspace
docker compose config                # validates docker-compose.yml
git diff --check                     # trailing whitespace / conflict markers
```

`--force` is not optional here — see "Turbo will lie to you" below. Plain
`bun run check-types` is fine while iterating, but the gate run must be forced.

## Pass criteria

Everything green. Baseline as of now:

- `bun test` → **75 pass, 0 fail** across 18 files
- `check-types` → **10 of 10 workspaces successful**, and **`Cached: 0 cached, 10 total`**
- `docker compose config --quiet` → exit 0

The cache line is part of the pass criteria, not decoration. `10 successful` with
`10 cached` means tsc never ran.

**Any failure blocks the commit.** `.github/workflows/ci.yml` runs this same gate on push to
`main` and on every PR, so a failure here will fail there too — running it locally just saves
you the round trip.

There is no "the failure is pre-existing" escape hatch. Carrying a red gate is exactly how
`main` previously ended up with both a stale assertion and a type error: nothing was run
before pushing, and every subsequent green result became uninterpretable. If you cannot fix a
failure now, say so explicitly and do not commit.

`bun test` is also the first command in the README's Verification section, so a reviewer
cloning the repo runs it before reading any code.

## Protocol

Follow this order. Most false results come from skipping a step, not from a real defect.

**1. Finish editing first.** Run the gate *after* the last edit. A gate run that predates your
final change proves nothing.

**2. Restore any scratch state before running.** If you moved, renamed, or deleted anything
outside of a normal file edit — build directories, temp copies, env files — put it back first.
A failure caused by your own leftover state is **not a finding**: clean up, re-run, and only
then interpret the result.

Real example this rule comes from: restoring `apps/web/.next` with
`mv /tmp/backup apps/web/.next/types` nested the backup *inside* the existing `types/`
directory instead of replacing it, and `web#check-types` then failed with seven bogus
`TS2307: Cannot find module '../../app/*/page.js'` errors that looked exactly like a real
module-resolution bug.

**3. Never simulate a clean checkout by mutating the working tree.** Use an isolated copy:

```bash
git worktree add /tmp/flux-clean HEAD
cd /tmp/flux-clean && bun install --frozen-lockfile
bun test && bunx turbo run check-types --force    # --force is mandatory: shared worktree cache
git worktree remove /tmp/flux-clean --force && git worktree prune
```

Use `--frozen-lockfile` to match CI, and `--force` because the worktree shares the parent's
turbo cache — without it you are reading the parent repo's results, not the clean checkout's.
A worktree is still a valid clean room for dependency-resolution and install-layout bugs, since
`bun install` genuinely reinstalls; it is *not* a clean room for turbo-cached task results.

This matters here because `apps/web/next-env.d.ts` imports a path under the gitignored
`.next/`, so `web#check-types` behaves differently on a fresh clone than in a working
directory. `apps/web`'s `check-types` runs `next typegen` first to generate it.

**4. Read the actual error before concluding anything.** Turbo truncates and caches. To see a
specific workspace's real output:

```bash
bunx turbo run check-types --force 2>&1 | grep -A 12 "web:check-types"
bunx tsc --noEmit -p apps/workers/tsconfig.json     # bypass turbo entirely
```

Without `--force` you will be grepping replayed logs — see "Turbo will lie to you".

**5. Report exact numbers, never predictions.** "75 pass, 0 fail" and "10 of 10 workspaces" —
not "tests should pass" or "this looks correct". If you did not run it, say you did not run it.

## Turbo will lie to you

This is the single most likely way to report a green gate that is not green.

`bun run check-types` routinely prints `Tasks: 10 successful, 10 total / Cached: 10 cached,
10 total >>> FULL TURBO`. That is **replayed logs from a previous run — tsc did not execute.**
The `$ tsc --noEmit` line appears in the output either way, so a cached replay is visually
almost identical to a real run.

Worse, turbo shares its cache across git worktrees of the same repo, announcing it as
`Remote caching disabled, using shared worktree cache`. A worktree created specifically to
simulate a clean checkout therefore inherits the parent's cache and reports the parent's
results.

Real example this rule comes from: `apps/api` was failing on CI with `TS2688: Cannot find type
definition file for 'bun'` — it set `typeRoots` to a bun hoist artifact
(`packages/node_modules/@types`) that only exists by install-order accident, and setting
`typeRoots` also disables the default `node_modules/@types` walk. Every local
`bun run check-types` reported 10/10 green. So did the same command inside a freshly installed
`/tmp` worktree. Running `bunx tsc --noEmit` directly in `/tmp/flux-clean/apps/api` reproduced
the CI failure instantly.

To get a trustworthy answer:

```bash
bunx turbo run check-types --force        # must report "Cached: 0 cached"
bunx tsc --noEmit -p apps/api/tsconfig.json   # or bypass turbo entirely
```

`bun test` does **not** cache and is trustworthy as-is. This applies only to turbo-run tasks.

## Expected side effect

`apps/web`'s `check-types` runs `next typegen`, which regenerates the tracked file
`apps/web/next-env.d.ts`, flipping line 3 between `./.next/dev/types/routes.d.ts` (written by
`next dev`) and `./.next/types/routes.d.ts` (written by typegen/build). Running `next dev`
flips it back.

This one-line diff is expected and harmless — do not "fix" it, and do not treat it as an
uncommitted change that needs reverting.

## Running a subset while iterating

```bash
bun test packages/risk/src/margin.test.ts    # one file
bun test -t "partial fill"                    # by test name
bunx tsc --noEmit -p packages/db/tsconfig.json   # one workspace
```

Use these while working, but run the **full** gate before committing — the dual-runtime
structure means a change in `packages/runtime` can break `apps/api` type checks.

## What this gate does not catch

Worth stating plainly, so a green run is not over-trusted:

- **No concurrency coverage.** The balance race (`TODO.md` #5) passes every test.
- **`PrismaApiRuntime` has zero tests** — 718 lines covering margin checks, balance locking,
  and order submission. Type checks pass because the adapter returns `unknown` and reads
  fields through casts.
- **No invariant tests.** Nothing asserts `locked <= total`, or that the book is never crossed.

If your change is in the money path, a green gate is necessary but not sufficient — see the
`money-path` skill.

## CI

`.github/workflows/ci.yml` runs this same gate on push to `main` and on every PR, with
`concurrency.cancel-in-progress` so superseded runs are cancelled.

It needs **no Postgres or Redis service containers** — the suite runs entirely on the
in-memory `PersistenceStore` and `InMemoryStreamBus` ports. Keep that true. If a future test
needs a live database, add a separate job rather than slowing this one down; the fast,
infra-free gate is a deliberate payoff of the ports/adapters design.

Running the gate locally is still the norm — it saves a push/wait cycle.

But CI is not merely a slower copy of the local gate: it starts from a bare checkout with no
node_modules and no turbo cache, so it is the only place that reliably catches
install-layout and cache-masked failures. A local green followed by a CI red does **not**
automatically mean the local step was skipped — check whether the failure is one only a cold
environment could surface, and reproduce it with `--force` or a direct `tsc` before assuming
either result is wrong.
