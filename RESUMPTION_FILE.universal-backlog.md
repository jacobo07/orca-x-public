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
`phases/02-*/02-VERIFICATION.md` status is `passed`.
Phase 2 post-execution hooks were closed in epoch 6:
- review: 1 warning (WR-01), fixed in `d06b80679`/`c23b4bc0c`; IN-01..04 left open as info;
- validation: `nyquist_compliant` true, with the es/en parity test `cb2640aa5`;
- security: 31/31 threats closed;
- UI review: skipped because the agent guard refused it;
- the real-app restart spec passed again ("2 passed") on a bundle that includes the WR-01 fix.
Phase 3 has `03-CONTEXT.md` (D-01..D-21) and `03-UI-SPEC.md` (draft, U3-01..U3-14). It is NOT planned
yet; the next step is plan-phase 3. The real-app check of "refuse dismissal while submitting" (WR-01) is
owed to the Phase 3 real-app plan.

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
  check that timestamps chain. Playwright runs as `node node_modules/@playwright/test/cli.js test …`
  (npx dies), and `C:\Program Files\Git\cmd` must be prepended to PATH, or global setup fails at
  `git init`.
- The agent-solo guard's tracker is machine-wide, so another pane's dispatch blocks yours for 30 s. Do
  other work, then retry once. On the second refusal, do the work inline or skip it if its hook
  allows skipping.

**Active decisions.** See STATE.md Decisions. Never write in `Apps\io-chatgpt-plugin`. Never
`pnpm install` (node_modules is a junction). Push is Owner-only. OWNER DECISION pending (non-blocking):
regenerate husky hooks.

**Next 3 actions.** 1) Phase 3 plan-phase: research, plan, check, then execute. The context and UI spec
are already written, so do NOT re-discuss. 2) Phase 4 (reconciliation and merge).
3) Phase 5 (executor lanes).

**Start.** Run `/gsd-autonomous --ws ub` from the worktree root (set the workstream first); update
this file after every sealed unit.
