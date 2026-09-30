# RESUMPTION — Universal Backlog / Intent Ledger (Orca X)

**Identity.** Worktree `C:\Users\User\Apps\orca-backlog-wt`, branch `orca-x/universal-backlog`, base main
`49b1415e7`. Workstream `ub` (`.planning/workstreams/ub/`, git-excluded). Architecture:
`docs/reference/universal-backlog.md`. InfinityOps side: `docs/reference/backlog-infinityops-contract.md`.
Thesis: a cross-project, provenance-aware, evidence-reconciled system of record for unfinished intent,
sitting ABOVE Tasks and linking to execution owners.

**State.** Phases 1 and 2 COMPLETE in ROADMAP. Phase 1 (ledger) verified 5/5, head `1b021312b`. Phase 2
(Backlog surface + manual capture) verified 41/41, SC1-3 PASS, head `b057c2481`: 8 plans. It proves
capture, restart, grouping, filters, search, state change and the SC2 count oracle in the REAL Windows
Electron app (LOCAL_RENDER). 7 mutation drills were all caught. Gaps G1/G2 were closed by 02-08.
Coherence anchor: `git log --oneline 14ca2070e..HEAD` lists only `backlog` commits;
`phases/02-*/02-VERIFICATION.md` status is `passed`. Next: Phase 3 (candidate inbox + harvesters), which
has no directory yet.

**Host rules that bit.**
- GSD specialists have no PowerShell, so dispatch executors, checkers and verifiers as `general-purpose`
  following the agent definition. Specialists without Write are refused by the agent-contract guard.
- git is `& 'C:\Program Files\Git\cmd\git.exe'`. vitest is `node node_modules/vitest/vitest.mjs run
  --config config/vitest.config.ts`. pnpm scripts go through `cmd /c`.
- `.husky/_` is missing, so no pre-commit hook runs. Executors run `oxfmt --write`, oxlint and the
  react-doctor oxlint on their files. `oxfmt --check` on the CRLF working copy is blind; check the LF
  blobs instead.
- Never run `sync:localization-catalog`.
- Pre-existing reds (localization x3, mobile-aperture 4 names, type-aware audit 7/12) are baselined in
  `phases/02-*/baselines/`.
- Real-app runs: `--mode e2e` build + SKIP_BUILD=1, `orcaPage`, rebuild after the final commit, and
  check that timestamps chain.

**Active decisions.** See STATE.md Decisions. Never write in `Apps\io-chatgpt-plugin`. Never
`pnpm install` (node_modules is a junction). Push is Owner-only. OWNER DECISION pending (non-blocking):
regenerate husky hooks.

**Next 3 actions.** 1) Phase 3 discuss (smart discuss, unattended: take the recommended answers and
record each), then research, plan, check and execute. 2) Phase 4 (reconciliation and merge).
3) Phase 5 (executor lanes).

**Start.** Run `/gsd-autonomous --ws ub` from the worktree root (set the workstream first); update
this file after every sealed unit.
