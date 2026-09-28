# RESUMPTION â€” Orca X Stability Closure + Constitutive Baseline Ratchet

**Identity.** Worktree `C:\Users\User\Apps\orca-stability-wt`, branch `orca-x/stability-closure`,
base origin/main `14dfd2d56` + merge of frontier `0d21c867b` (= `626a20148`). Approved plan:
`~/.claude/plans/swift-drifting-wozniak.md` (workstreams Aâ†’B/Câ†’D/Eâ†’Fâ†’Hâ†’Iâ†’J/K/L + CPP/CBR).
Never touch the primary checkout (another writer, 44 dirty files) or its stash.

**Sealed.**
- A1 `efcb90d72` â€” notifier authority table + `resolveNotifierTargets`; unowned act/read refused,
  place â†’ one window (last focused). 21/21 + 36/36, tsc/oxlint clean, 2 mutation drills caught.

**Owed on A.** Real two-window Electron run (GEX44 xvfb, fenced by bundle + rev-parse): unplaced
worktree activation lands in exactly one window; then variant-parity row
`runtime.command-acts-on-the-window-that-owns-the-target` â†’ ported. Hypothesis to prove there: the
pre-fix broadcast ran a new worktree's setup/startup in both windows.

**Host facts.** Windows host 0.6â€“2.3 GB free: vitest 35â€“520 s per run; ripgrep over src times out â€”
use `git grep`. Files on disk are CRLF (`core.autocrlf=true`): `oxfmt --check` fails on every file;
format with `oxfmt <files>` and judge scope by `git diff --stat`. CI starved since 2026-09-13
(`report-ci-execution-rungs.mjs`): CI rungs are OPERATOR-GATED.

**Next 3.** (1) A: two-window E2E + parity row. (2) B/C: `mobile/src/storage/draft-journal.ts`
modelled on `codex-reset-attempt-journal.ts`; dictation `refused`/`landed=false` salvage.
(3) D: register the paint judge in `terminal-render.pixel-refresh-repair`.

**Start.** `git log --oneline -5` must show `efcb90d72`; then continue at Next (1).
