# RESUMPTION — Orca Cognitive Workspace, long run (remote-project-agent / provider-resume)

## 1. Identity

Worktree **`C:\Users\User\Apps\orca-cogws-wt`**, branch **`orca-x/cognitive-workspace`** (unpushed).
A `/clear`'d pane has SIX times opened the Desktop checkout instead — prove `git worktree list` first.
Roadmap `.planning/ROADMAP.md` + `.planning/STATE.md` (git-excluded). Spec
`docs/orca-cognitive-workspace-spec.md`; authority/outcomes reference
`docs/reference/remote-agent-turn-authority.md`.

## 2. Exact state (2026-09-24) — PROGRAM COMPLETE

`node config/scripts/check-cognitive-workspace-completeness.mjs` → **exit 0**: 18 complete / 0 open /
2 blocked (Q owner-auth, T runner-capacity), 50/50 evidence pointers, every complete row's gate run.
Phases 1–9 sealed; per-phase `NN-VERIFICATION.md` under `.planning/phases/`. Last drill: 30/30 on
GEX44 at `6afec4fd0`.

## 3. Active decisions

- Conversation on the desktop; provider effect on the ssh host via relay `agentProcess.*`.
- A location is a path AND a host; provenance carries `executionHostId`, `cwd`, `hostAddress`.
- Resume relocates only on Codex ≥ 0.153.4 whose own answer confirms the directory.

## 4. Next three actions (all owner-gated)

1. After 2026-09-27 19:54 (Codex quota): `.planning/tools/gex44-e2e.ps1 -Sha <HEAD> -Phase build`, then
   `-Phase test -SignedIn`; the answer must contain 4471 → flip matrix Q to complete.
2. When a GitHub runner is assigned (runner_id > 0) → flip matrix T.
3. Push the branch / open the PR only on the Owner's word.

## 5. Start

Read `.planning/STATE.md`, prove the worktree, run the done-gate above.
