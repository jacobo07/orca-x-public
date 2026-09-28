# RESUMPTION — Orca X convergence (integration-2)

## 1. Identity
Worktree `C:\Users\User\Apps\orca-integration-wt`, branch `orca-x/integration-2`, cut from the pushed
`orca-x/integration` a3445471e (left untouched). Owner-approved 2026-09-28. Thesis: stop stranding
proven work — one integration candidate, then the multi-window freeze verdict and Resume Center P4.
Plan of record: `.planning/ROADMAP.md` (6 GSD phases, git-excluded) + `.planning/STATE.md`; per-phase
verdicts in `.planning/phases/0N-VERIFICATION.md`. Other branches' `RESUMPTION_FILE*.md` belong to
their programs — never edit them.

## 2. State (2026-09-28, HEAD 31d883b09, NOT pushed)
- Integrated, every pin contained (`node config/scripts/integration-frontier.mjs --target HEAD
  <branch>=<pin> ...` → rc=0): origin/main 14dfd2d560, reload-authority f534630a1b,
  agent-federation 71dd7bc979, stability-closure 1cc677202c, cogws-shell-reality 37c98a8609,
  continuity-resume-center 144d2b6d59, w0-durability-repros 4347bb2d50.
- Already inside a3445471e: aeos, cognitive-workspace, cogws-product-surface, ipc-message-listener-floor,
  mobile-relay-investigation, mobile-workstation-runtime, w21-sleep.
- Phases 1–5 PASSED. P4: multi-window freeze NOT reproduced on HEAD (Windows, 4 conditions); the spec
  reds on a return-path gate mutant. P5: Resume Center P4 merged from continuity, 3/3 specs on
  Windows, two mutants red. Open leads: P4 L1 (foreign foreground window + already-focused window
  going hidden), L2 (setup precondition flakes).
- Excluded: distributed-workstation (live Ralph), gex44 agent-federation-p8 (halted), mobile-workstation.

## 3. Decisions
- Push / merge-to-main / branch or worktree deletion: Owner only.
- A line's owner wins inside its own files at merge; integration-2 adds only what is missing (see
  31d883b09: continuity's specs + resume spec skip lifted here).
- `resume-center-restore-no-wake.spec.ts` is not oxfmt-clean at continuity's tip; left for its owner.

## 4. Next
1. Owner: push `orca-x/integration-2`; decide whether to merge to main.
2. Before any new merge: re-run the frontier with current tips; lines keep moving.
3. P4 L1 needs a spec phase with a third foreground window; not started.

## 5. Start
Open in this worktree; prove `git rev-parse --abbrev-ref HEAD` = orca-x/integration-2; read
`.planning/STATE.md` then ROADMAP.
