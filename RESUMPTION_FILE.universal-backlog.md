# RESUMPTION — Universal Backlog / Intent Ledger (Orca X)

**Identity.** Worktree `C:\Users\User\Apps\orca-backlog-wt`, branch `orca-x/universal-backlog`, base main
`49b1415e7`. Workstream `ub` (`.planning/workstreams/ub/`, git-excluded). Architecture:
`docs/reference/universal-backlog.md`. InfinityOps side: `docs/reference/backlog-infinityops-contract.md`.
Thesis: a cross-project, provenance-aware, evidence-reconciled system of record for unfinished intent,
sitting ABOVE Tasks and linking to execution owners.

**State.** Approved 2026-09-29. W0 sealed. Phase 1 (ledger foundation) PLANNED and executing:
`phases/01-intent-ledger-foundation/` holds CONTEXT, RESEARCH, VALIDATION (with the pre-execution
gate baseline), 4 plans in 4 sequential waves (checker PASSED after revision 1). Executors run
sequentially on this tree (HEAD is not on origin/HEAD, so worktree isolation degrades). Coherence
anchor: `git log --oneline e1ad065c6..HEAD` lists only `backlog` commits; the newest
`*-SUMMARY.md` in the phase dir names the last sealed plan.

**Host rules that bit.** GSD specialist agents have no PowerShell, so they cannot run pnpm/git here —
dispatch executors as `general-purpose` following `~/.claude/agents/gsd-executor.md`. In PowerShell
call `$pn='pnpm'; & $pn …` and `& 'C:\Program Files\Git\cmd\git.exe'`. `check:mobile-aperture` is
red at HEAD for 4 non-backlog names (pre-existing; never baseline them).

**Active decisions.** See STATE.md Decisions. Never write in `Apps\io-chatgpt-plugin`. Never
`pnpm install` (node_modules is a junction). Push is Owner-only.

**Sealed so far.** Plan 01-01 COMPLETE (`01-01-SUMMARY.md`): 1a `8bf108be7` (store, record-file
engine, contract `backlog.intent-ledger-record`, syscall proof), 1b `593f4d966` (backlog.capture/get
over the real RpcDispatcher, `backlog.v1`, aperture baseline), 2 RED `063a181ef` + GREEN `ef9eb16c7`
(profile-scoped `getOrcaBacklogDirectory`, `src/main/ipc/backlog-host-wiring.ts`, index.ts wiring).
Scoped suite 5 files 10/10; durability and typecheck green; aperture red only for the 4 pre-existing
names. Rung: real files + real runtime/dispatcher under vitest, no app run. Per-commit log:
`phases/01-intent-ledger-foundation/EXECUTION-LOG.md`.
Plan 01-02 COMPLETE (`01-02-SUMMARY.md`, head `7216b228e`): pure lifecycle table (52 edges) +
completion contracts + append-only event rule + link union; fenced `BacklogRecordStore.mutate`
(revision re-read in the commit veto, `applyFold(id, fold)` for plan 03's pair lock);
`backlog.update` / `backlog.transition` over RPC. Suite 11 files 72/72; gates as above.
Plan 01-03 COMPLETE (head `544712205`): fingerprint-keyed candidate ingest, item-first resolution,
survivor-first item merge, three RPC methods. Plan 01-04 COMPLETE (head `0348b4e06`): ledger open with
per-record quarantine, list / candidates.list / health (ten methods), drills M1–M6 all CAUGHT and
restored by SHA-256. `ab79e3fb6` pins the open-concurrency cap (the M4 gap). Scoped suite 16 files 115/115, plus that test 1/1 (run separately).
`pnpm lint` and `check:mobile-aperture` are red only on pre-existing non-phase files (01-04-SUMMARY).
ChatGPT write-back is PROVEN on the Owner's Pro/EEA account (`03a24aaba`, docs + contract C2).

**Next 3 actions.** 1) Phase 1 verification (`01-VERIFICATION.md`); close any gap. 2) Phase 2
(Backlog surface): `02-CONTEXT.md` → UI-SPEC → plan → execute, real-app Playwright CDP proof with
restart. 3) Phase 3 (candidate inbox + harvesters). Tests run as
`node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <files>` (RTK breaks
`pnpm exec vitest`); `pnpm run` scripts via `cmd /c`.

**Start.** Run `/gsd-autonomous --ws ub` from the worktree root; update this file after every sealed unit.
