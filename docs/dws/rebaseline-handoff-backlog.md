# DWS re-baseline: hand-off backlog (2026-10-15)

Written on the laptop for a session on the other PC. Branches on GitHub (`jacobo07/orca-x`):

- `orca-x/dws-rebaseline`: the GEX44 mission branch `dws/rebaseline` at `ca3a66869`
  (85 commits over the integration base `a779261583`). Source of truth stays on GEX44:
  `/home/kobii/missions/dws-canary`, worktree `/home/kobii/missions/dws-exec/rb`, workstream `dwsrb`.
- `orca-x/dws-rebaseline-live`: this branch. It is `dws/rebaseline` plus the live-leg harness fixes below.

## State

- Matrix: 22 of 76 rows PASS (`node config/scripts/check-dws-completeness.mjs`). Of the 54 non-PASS rows,
  21 are BLOCKED_EXTERNAL (12 UWCP control verbs, 2 UWCP lease store, rows 17 and 44 UWCP, 4 CPP write
  authority: 52 53 54 76, row 45 orca-svc login), 10 are READY_FOR_LIVE, about 23 are phases 5-10 work.
- GSD phases: 1-3 done, phase 4 executed and reviewed, its verifier never wrote `04-VERIFICATION.md`.
- Ralph mission `m-07a78fbae3c7` on GEX44 is under a cost-breaker hold (Owner kept it, option 1):
  processed 405.7M vs 2 x estimate 10.2M. Goal `dws-exec` has 40.6M left on paper; the worker session's
  charge is not settled yet and will likely exhaust it. Raising the cap or cutting phases 5-10 is the
  Owner's call. Do not release the hold without the Owner.

## Live legs (laptop or any Windows PC -> GEX44 over real SSH)

Prerequisites on the PC that runs them: an `ssh gex44` alias with BatchMode key access, Git for Windows,
about 6 GB of free RAM, and a SHORT working path (a long path broke `git fetch` with "Filename too long").
Build in the worktree: `node config/scripts/build-relay.mjs`, `pnpm run build:cli`,
`VITE_EXPOSE_STORE=true electron-vite build --mode e2e`, and `pnpm run build:web-from-renderer` for probe legs.
Driver per leg: `new-root`, `create`, `seed-p16`, `seed-local-p16`, `fetch-key`, `run-file`, the spec with
`SKIP_BUILD=1`, `teardown`; always check `procs` reports `PROC_COUNT=0` afterwards.

| Row | Spec / grep | Result 2026-10-15 | Next |
|---|---|---|---|
| 63 | replica-pair `-g relay-compare-result`, phase 17, seed-p17 | PASS: `diverged +1/-2` live, `unverified (host-unreachable)` down | Restate the row |
| 60 | grouped-relation, phase 17 | PASS (transport + ahead 2); the row-63 run is a live grouped relation | Restate the row |
| 73 | host-loss, phase 23, probe from remote-first `-g "probes what the two clients expose"` | Test 1 PASS (relay pid, shell pid, no duplicate, local continues). Test 2 failed only on `emitterAlive`: the emitter's own 120 s tail ended before the check | Rerun with the emitter fix (unverified) |
| 59 | remote-first, same probe | NOT RUN | Run after 73 |
| 74 | mixed-relay, phase 23, `ORCA_HWF_P23_RELAY_PATH` = old relay build (commit `5de29754c5`) | App correct (`unverified (relay-too-old)`), but the instrument is blind: the relay never logs request methods, so `"method":` counts are 0 on any relay | Build an instrument that sees relay methods |
| 65 | replica-pair `-g disk-full-and-disconnect` | NOT RUN | Needs `ORCA_HWF_SMALL_FS_ROOT` on a <= 1 GiB filesystem on GEX44 |
| 61 | `orca project setups --all-environments` | NOT RUN | Needs two real paired environments, one down |
| 62 | rendered Settings relation row | NOT RUN | Drive with the `$electron` skill + Playwright CDP |
| 70 | Continue here reattach to a live remote PTY | NOT RUN | No spec exists yet |

Harness fixes on this branch: provisioner over ssh stdin (Windows ENAMETOOLONG at 27 KB), row-63 expected
word from both measured sides, emitter lifetime 900 s (unverified live).

## Other open items

- Owner decisions: units X05 X06 X16 X18 X19 (proposals in `.planning/workstreams/dwsrb/STATE.md` on GEX44);
  where vault/UKDL records for rows 52-54 and 76 live; the `dws-exec` cap.
- Debt: row-17 laptop tunnel leg; orca-dws-serve claude version pin; provisioner symlink check; orca-svc login (row 45).
- Power Pack fix `2f5f5e64` (progress fingerprint sees an excluded `.planning/`) is committed locally in the
  PP repo on the laptop and in `ce5-env/pp` on GEX44 (`3cab9f89`); neither is pushed.

## Request for the other PC (verbatim from the Owner)

"can you copy from the other PC (C:\Users\User\.claude\) its CLAUDE.md, the agents/ folder and
skills/software-best-practices? Put them somewhere on this PC and I'll install them."

Measured on the laptop 2026-10-15: `C:\Users\User\.claude\CLAUDE.md` (1 file), `agents\` (95 files),
`skills\software-best-practices\` (2 files) all exist. Copy them into a staging folder, not over the other
PC's own `~\.claude`; the Owner installs them.
