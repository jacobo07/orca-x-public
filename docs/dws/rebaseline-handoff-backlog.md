# DWS re-baseline: hand-off backlog (2026-10-15)

Written on the laptop for a session on the other PC. Branches on GitHub (`jacobo07/orca-x`):

- `orca-x/dws-rebaseline`: the GEX44 mission branch `dws/rebaseline` at `ca3a66869`
  (85 commits over the integration base `a779261583`). Source of truth stays on GEX44:
  `/home/kobii/missions/dws-canary`, worktree `/home/kobii/missions/dws-exec/rb`, workstream `dwsrb`.
- `orca-x/dws-rebaseline-live`: this branch. It is `dws/rebaseline` plus the live-leg harness fixes below.

## State

- Matrix: 25 of 76 rows PASS (`node config/scripts/check-dws-completeness.mjs`); the desktop PC restated
  rows 60, 63 and 73 (was 22). Of the 51 non-PASS rows, 21 are BLOCKED_EXTERNAL (12 UWCP control verbs,
  2 UWCP lease store, rows 17 and 44 UWCP, 4 CPP write authority: 52 53 54 76, row 45 orca-svc login),
  7 are READY_FOR_LIVE (24 34 61 62 65 70 74), row 59 waits on the Owner (model-turn credential, OD-1),
  about 22 are phases 5-10 work.
- GSD phases: 1-3 done, phase 4 executed and reviewed, its verifier never wrote `04-VERIFICATION.md`.
- Ralph mission `m-07a78fbae3c7` on GEX44 is under a cost-breaker hold (Owner kept it, option 1):
  processed 405.7M vs 2 x estimate 10.2M. Goal `dws-exec` has 40.6M left on paper; the worker session's
  charge is not settled yet and will likely exhaust it. Raising the cap or cutting phases 5-10 is the
  Owner's call. Do not release the hold without the Owner.

## Live legs (laptop or any Windows PC -> GEX44 over real SSH)

Prerequisites on the PC that runs them: an `ssh gex44` alias with BatchMode key access, Git for Windows,
and a SHORT working path (a long path broke `git fetch` with "Filename too long"). Building needs about
6 GB of free RAM; running a leg on an existing build does not (the desktop PC ran row 73 with 2.7 GB free).
Build in the worktree: `node config/scripts/build-relay.mjs`, `pnpm run build:cli`,
`VITE_EXPOSE_STORE=true electron-vite build --mode e2e`, and `pnpm run build:web-from-renderer` for probe legs.
The desktop PC's `C:\ox\out` holds such a build of the `28b881b58` tree.
Driver per leg: `new-root`, `create`, `seed-p16`, `seed-local-p16`, `fetch-key`, `run-file`, the spec with
`SKIP_BUILD=1`, `teardown`; always check `procs` reports `PROC_COUNT=0` afterwards.

Probe file (`ORCA_HWF_PROBE_FILE`): the probe test's `HWF_PROBE_*` lines PLUS the provisioner `status`
lines. Without `PROVIDER_CLAUDE` / `PROVIDER_CODEX` the agent leg prints `NOT_RUN provider-binary-absent`
and still passes, so a green agent test is only a result when `HWF_AGENT_A_LAUNCH=observed` is printed.

Builds older than the tab-row fix (see Other open items) clip the tab bar "+" at a 1366 px window; with
such a build, run the app with `--lang=en-US` and a wider window, or rebuild first.

| Row | Spec / grep | Result 2026-10-15 | Next |
|---|---|---|---|
| 63 | replica-pair `-g relay-compare-result`, phase 17, seed-p17 | PASS: `diverged +1/-2` live, `unverified (host-unreachable)` down | Done: row PASS (`docs/dws/live-2026-10-15-rows-60-63-evidence.md`) |
| 60 | grouped-relation, phase 17 | PASS (transport + ahead 2); the row-63 run is a live grouped relation | Done: row PASS (same evidence file) |
| 73 | host-loss, phase 23, probe from remote-first `-g "probes what the two clients expose"` | Desktop PC: both tests PASS; agent pid kept, emitter alive after the drop, backfill A and B 13/13 | Done: row PASS (`docs/dws/live-2026-10-15-row-73-host-loss-evidence.md`) |
| 59 | remote-first, phase 15, same probe | Desktop PC: 6 of 6 PASS (fs/git/terminal from both clients, claude launch, reconnect keeps shell and agent, backfill B 13/13) | Row stays PARTIAL: Owner decides the model-turn credential (OD-1). Keep run files outside `%TEMP%` (`docs/dws/live-2026-10-15-row-59-remote-first-evidence.md`) |
| 74 | mixed-relay, phase 23, `ORCA_HWF_P23_RELAY_PATH` = old relay build (commit `5de29754c5`) | App correct (`unverified (relay-too-old)`), but the instrument is blind: the relay never logs request methods, so `"method":` counts are 0 on any relay | Build an instrument that sees relay methods |
| 65 | replica-pair `-g disk-full-and-disconnect` | NOT RUN | Needs `ORCA_HWF_SMALL_FS_ROOT` on a <= 1 GiB filesystem on GEX44 |
| 61 | `orca project setups --all-environments` | NOT RUN | Needs two real paired environments, one down |
| 62 | rendered Settings relation row | NOT RUN | Drive with the `$electron` skill + Playwright CDP |
| 70 | Continue here reattach to a live remote PTY | NOT RUN | No spec exists yet |

Harness fixes on this branch: provisioner over ssh stdin (Windows ENAMETOOLONG at 27 KB), row-63 expected
word from both measured sides, emitter lifetime 900 s (verified live on the desktop PC, row 73).

## Other open items

- Layout defect, fixed on this branch: at a 1366 px window the tab strip got 0 px (Spanish) / 22 px
  (English) and clipped its own "New tab" "+", because AppMenuStrip's fit check ignored the columns left
  of the header and the terminal toolbar sharing the top band. The check now subtracts both and is
  re-run when they change; the menu folds to its compact button at 1366 px and keeps its labels at
  1920 px. Covered by `tests/e2e/tab-row-new-tab-reachable.spec.ts` (es and en-US, red on the old build).
  The hwf helpers still click the "+" with `force: true`, which would hide a regression as "menu never
  opened"; worth removing.
- Owner decisions: units X05 X06 X16 X18 X19 (proposals in `.planning/workstreams/dwsrb/STATE.md` on GEX44);
  where vault/UKDL records for rows 52-54 and 76 live; the `dws-exec` cap.
- Debt: row-17 laptop tunnel leg; orca-dws-serve claude version pin; provisioner symlink check; orca-svc login (row 45).
- Power Pack fix `2f5f5e64` (progress fingerprint sees an excluded `.planning/`) is pushed to
  `jacobo07/claude-power-pack` branch `feature/knowledge-acquisition` (tip `4752ce43`); its GEX44 port
  `3cab9f89` lives in `ce5-env/pp`, which has no remote.
- The laptop's Claude config without secrets is in the private repo `jacobo07/claude-config-laptop`
  (README lists what was left out and why).

## Request for the other PC (verbatim from the Owner)

"can you copy from the other PC (C:\Users\User\.claude\) its CLAUDE.md, the agents/ folder and
skills/software-best-practices? Put them somewhere on this PC and I'll install them."

Done 2026-10-15 on the desktop PC: the 98 files (CLAUDE.md, `agents\` 95, `skills\software-best-practices\` 2)
are staged in `C:\Users\Jacobo\Desktop\laptop-claude-staging`, each checked against its blob in
`jacobo07/claude-config-laptop`. Nothing was written to `~\.claude`; the Owner installs them.
