---
description: Verify, branch if needed, commit, push, and open a PR
argument-hint: [optional PR title or context]
allowed-tools: Bash(git:*), Bash(gh:*), Bash(bun:*), Bash(docker compose config:*), Read
---

## Current state

- Branch: !`git branch --show-current`
- Status: !`git status --porcelain`
- Recent commits: !`git log --oneline -10`
- Diff vs HEAD: !`git diff HEAD --stat`

## Task

Ship the current working-tree changes as a pull request. Extra context from the user
(may be empty — treat it as the intended PR title or a note about scope): $ARGUMENTS

Work through these in order. Do not skip ahead.

### 1. Run the verification gate

`.claude/skills/verify/SKILL.md` is the source of truth for the gate — read it and run its
commands from the repo root, **after** any edits are finished:

```bash
bun test
bun run check-types
docker compose config --quiet
git diff --check
```

**If any of them fails: stop.** Report the failure output verbatim, say plainly that the gate
is red, and do not commit, push, or open a PR. There is no "pre-existing failure" exemption —
`.github/workflows/ci.yml` runs this same gate on every PR, so a red gate here is a red PR
there.

### 2. Get onto a branch

If the current branch is `main`, infer a branch name from the diff in `type/short-kebab-summary`
form (e.g. `fix/market-order-margin`, `feat/redis-orderbook-cache`), tell the user the name you
picked, then `git checkout -b <name>`.

If already on a feature branch, stay on it.

### 3. Commit

Review the diff and stage only what belongs in this PR — do **not** `git add -A` blindly. The
working tree may hold unrelated deletions, scratch files, or untracked directories; if something
looks out of scope, ask before including it.

Write a conventional-commit subject matching the style already in `git log`
(`fix: ...`, `feat: ...`), plus a short body saying *why* the change was made.

### 4. Push

```bash
git push -u origin <branch>
```

### 5. Open the PR

```bash
gh pr create --base main --title "<title>" --body "$(cat <<'EOF'
## Summary
<1-3 bullets: what changed and why>

## Test plan
<the actual gate results from step 1 — test counts, workspace count, exit statuses>
EOF
)"
```

If `gh` reports a PR already exists for this branch, that is fine: the push in step 4 updated
it. Fetch its URL with `gh pr view --json url` instead of erroring out.

### 6. Report

Give the user the PR URL and a one-line summary of what was pushed.

## Guardrails

- Never `git push --force`, `git commit --amend`, or rebase.
- Never commit or push directly to `main`.
- Never pass `--no-verify` or otherwise skip hooks.
- Never change git config or the remote.
- If the working tree is clean and there is nothing to commit, say so and stop.
