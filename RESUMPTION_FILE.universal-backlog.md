# RESUMPTION — Universal Backlog / Intent Ledger (Orca X)

**Identity.** Worktree `C:\Users\User\Apps\orca-backlog-wt`, branch `orca-x/universal-backlog`, base main
`49b1415e7`. Workstream `ub` (`.planning/workstreams/ub/`, git-excluded). Architecture:
`docs/reference/universal-backlog.md`. InfinityOps side: `docs/reference/backlog-infinityops-contract.md`.
Thesis: a cross-project, provenance-aware, evidence-reconciled system of record for unfinished intent,
sitting ABOVE Tasks and linking to execution owners.

**State.** Approved 2026-09-29. W0 sealed (this file, spec, contract, roadmap). Phase 1 (ledger
foundation) not started. Coherence anchor: `git log -1` on this branch names the W0 docs commit.

**Active decisions.** See STATE.md Decisions. Never write in `Apps\io-chatgpt-plugin`. Never
`pnpm install` (node_modules is a junction). Push is Owner-only.

**Next 3 actions.** 1) Phase 1: read `src/main/runtime/orchestration/db.ts` migrate pattern and
`src/main/durable-file-write.ts`, choose the store, write the durability contract. 2) Ledger RPC in
`src/main/runtime/rpc/methods/`. 3) Unit + kill-durability proofs, then commit.

**Start.** Run `/gsd-autonomous --ws ub` from the worktree root; update this file after every sealed unit.
