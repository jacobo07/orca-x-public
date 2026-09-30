# RESUMPTION — Universal Backlog / Intent Ledger (Orca X)

**Identity.** Worktree `C:\Users\User\Apps\orca-backlog-wt`, branch `orca-x/universal-backlog`, base main
`49b1415e7`. Workstream `ub` (`.planning/workstreams/ub/`, git-excluded). Architecture:
`docs/reference/universal-backlog.md`. InfinityOps side: `docs/reference/backlog-infinityops-contract.md`.
Thesis: a cross-project, provenance-aware, evidence-reconciled system of record for unfinished intent,
sitting ABOVE Tasks and linking to execution owners.

**State (2026-09-30, epoch 8).** Phases 1 and 2 COMPLETE and verified. Phase 3 (candidate inbox and
harvesters) is PLANNED as 10 plans; 03-01..03-05 are executed (HEAD `21a4f83f6`), 03-06..03-10 are NOT.
Phase **3.1 INSERTED** ahead of 03-06 by Owner priority (mission directives #5/#6): the ChatGPT capture
relay, Orca side, slice 1, against InfinityOps spec `c3b3b4df` (connection token, stateless cursor, one
drainer per account, 409 `relay_owned_elsewhere`, per-item ack, 24 h text purge). `03.1-CONTEXT.md` holds
the locked decisions D-01..D-17 (deferred ack, local host only, `backlog.relay.v1`, no persisted cursor,
input-only rejections, project hint never bound on plain accept). Research, then plan, then execute.
Coherence anchor: `git log --oneline 14ca2070e..HEAD` lists only `backlog` commits; STATE.md "Current
Position" ends at the epoch 8 entry.

**Then.** Resume Phase 3 at 03-06 (its plans are amended so the relay shows as a fourth unit), then
inserted Phase 2.1 (labelled nav + Backlog restyle; mission directive #3), then Phases 4-8.

**Host rules that bit.**
- GSD specialists have no PowerShell: dispatch researchers, planners, executors, checkers and verifiers
  as `general-purpose` following the agent definition file.
- git is `& 'C:\Program Files\Git\cmd\git.exe'`. vitest is `node node_modules/vitest/vitest.mjs run
  --config config/vitest.config.ts`. pnpm scripts go through `cmd /c`. On a memory-starved host one
  vitest file takes ~10 min (import); budget for it.
- `.husky/_` is missing, so no pre-commit hook runs. Executors run `oxfmt --write`, oxlint and the
  react-doctor oxlint on their files. `oxfmt --check` on the CRLF working copy is blind; check LF blobs.
- Never run `sync:localization-catalog`. Never `pnpm install` (node_modules is a junction).
- Pre-existing reds are baselined in `phases/02-*/baselines/`, plus `register-core-handlers.test.ts`
  "passes the store through" (red at base main; unmocked presence handler).
- Real-app runs: `--mode e2e` build + SKIP_BUILD=1, `orcaPage`, rebuild after the final commit, check
  that timestamps chain. Playwright runs as `node node_modules/@playwright/test/cli.js test …`, and
  `C:\Program Files\Git\cmd` must be prepended to PATH or global setup fails at `git init`.

**Active decisions.** See STATE.md Decisions. Never write in any InfinityOps checkout. Push is
Owner-only. OWNER DECISION pending (non-blocking): regenerate husky hooks.

**Start.** Run `/gsd-autonomous --ws ub` from the worktree root (set the workstream first); update this
file after every sealed unit.
