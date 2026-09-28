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

**Next 3.** (1) F: PR E2E selection by production impact (`.github/workflows/pr.yml:538-541`), unknown
→ wider, script-tested. (2) H: trace the 6 crash-durable contracts' caller-visible failures
(`config/durability-failure-semantics-baseline.txt`), credential + e2ee identity first, ENOSPC on GEX44.
(3) CPP: UKDL amend `single-owner-to-many-owners` (sentinel inversion) + CBR obligations in
`skills/claude-power-pack/modules/capability_runtime/applicability.py` with first tests.

**Start.** `git log --oneline -12` must show `91e45c037`; continue at Next (1).
