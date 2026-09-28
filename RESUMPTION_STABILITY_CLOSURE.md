# RESUMPTION — Orca X Stability Closure + Constitutive Baseline Ratchet

**Identity.** Worktree `C:\Users\User\Apps\orca-stability-wt`, branch `orca-x/stability-closure`,
base origin/main `14dfd2d56` + merge of frontier `0d21c867b` (= `626a20148`). Approved plan:
`~/.claude/plans/swift-drifting-wozniak.md`. Never touch the primary checkout (another writer, 44
dirty files) or its stash. `RESUMPTION_FILE.md` belongs to the durability programme — never edit it.

**Sealed (commit · rung).**
- A `efcb90d72` router authority table; `48818fddc` two-window E2E; `6a1c95e60` parity closed.
  PRODUCTION-REALITY on Linux: fix passes, pre-fix `626a20148` fails (worktree activated in BOTH
  windows, setup/startup included). Windows real-app run still owed.
- D `03e472fff` gate `terminal-render.visible-pane-painted-liveness` (unit, drill); `6eb9ac233` spec
  skips named without WebGL. Linux xvfb = DOM renderer → paint E2E INCONCLUSIVE both sides; product
  gap recorded (no paint detection without WebGL2). WebGL real-app run owed (Windows/GPU host).
- E `9225842ce` reveal convergence probe; `91e45c037` gate none→partial. Real-app red/green on Linux.
- B/C `de3d32ac3` mobile draft journal: chat drafts + dictation salvage, contract `mobile.user-drafts`.
  142/142, 2 drills. NOT done: markdown/file-preview editors (seams in `mobile/.stability-bc-findings.md`,
  untracked), salvage retrieval UI, emulator process-death run.

**GEX44 recipe.** Bundle `HEAD ^<sha gex has>` → `/home/kobii/`, fetch `HEAD:refs/heads/<n>`, per-run
worktree `/home/kobii/stab-*`, assert `rev-parse`. Reads ONLY via uploaded scripts
(`/home/kobii/read-ev.py <dir> <names>`, `/home/kobii/grep-ev.py <file> <single-token>`): inline
python/quotes through PowerShell→ssh break every time. Evidence in `/home/kobii/stab-evidence/`.

**Host.** 0.6–2.3 GB free; ripgrep over src times out (use `git grep`); files are CRLF — run
`oxfmt <files>` then check `git diff -w --numstat` for laundered hunks before committing.

**Also sealed.** F `cda936887` E2E impact selector (drill caught). H1 `91822df33` e2ee identity: read
error ≠ damaged (baseline 6→5). Linux cross-check 142/142 at `cda936887`. UKDL: new
`refusal-is-not-recovery`; amended `single-owner-to-many-owners`, `a-gate-that-cannot-fail`,
`an-instrument-that-cannot-see-the-answer`, `absence-does-not-describe-itself`.

**Next 3.** (1) CBR: read `~/.claude/skills/claude-power-pack/modules/capability_runtime/applicability.py`
+ `modules/setup_os/graph.py:353` (ProjectProfile); add a versioned constitutive obligation set
(authority semantics, user-intent durability, oracle reachability, failure-state separation) with
scope predicates; FIRST tests there: multi-window profile inherits, static library does not,
anti-downgrade mutation, stale entry. (2) H: next contract `integrations.credential-file`, then
`persistence.profile-data-file`; real ENOSPC via GEX44 loopback. (3) I: historical persisted-session
corpus from OLD writers (`git show <old>:`), gate `startup-upgrade.persisted-session-corpus`.

**Start.** `git log --oneline -15` must show `91822df33`; continue at Next (1).
