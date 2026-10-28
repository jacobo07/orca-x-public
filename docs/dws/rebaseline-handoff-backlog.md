# DWS re-baseline: hand-off backlog (2026-10-15)

Written on the laptop for a session on the other PC, then carried on the desktop PC. Branches on GitHub
(`jacobo07/orca-x`):

- `orca-x/dws-rebaseline`: the GEX44 mission branch `dws/rebaseline` at `ca3a66869`
  (85 commits over the integration base `a779261583`). Source of truth stays on GEX44:
  `/home/kobii/missions/dws-canary`, worktree `/home/kobii/missions/dws-exec/rb`, workstream `dwsrb`.
- `orca-x/dws-rebaseline-live`: this branch. It is `dws/rebaseline` plus the live-leg harness fixes and
  the product fixes below.

## State

- Matrix: 26 of 76 rows PASS (`node config/scripts/check-dws-completeness.mjs`); the desktop PC restated
  rows 60, 62, 63 and 73 (was 22). Of the 50 non-PASS rows, 21 are BLOCKED_EXTERNAL (12 UWCP control
  verbs, 2 UWCP lease store, rows 17 and 44 UWCP, 4 CPP write authority: 52 53 54 76, row 45 orca-svc
  login), 6 are READY_FOR_LIVE (24 34 61 65 70 74), row 59 waits on the Owner (model-turn credential,
  OD-1), about 22 are phases 5-10 work.
- GSD phases: 1-3 done, phase 4 executed and reviewed, its verifier never wrote `04-VERIFICATION.md`.
- Ralph mission `m-07a78fbae3c7` on GEX44 is under a cost-breaker hold (Owner kept it, option 1):
  processed 405.7M vs 2 x estimate 10.2M. Goal `dws-exec` has 40.6M left on paper; the worker session's
  charge is not settled yet and will likely exhaust it. Raising the cap or cutting phases 5-10 is the
  Owner's call. Do not release the hold without the Owner.

## Live legs (laptop or any Windows PC -> GEX44 over real SSH)

Prerequisites on the PC that runs them: an `ssh gex44` alias with BatchMode key access, Git for Windows,
and a SHORT working path (a long path broke `git fetch` with "Filename too long"). Building the full set
needs about 6 GB of free RAM; on the desktop PC (7.9 GB total) `electron-vite build --mode e2e` alone
built in 35 s with 2.7 GB free, and running a leg on an existing build needs little.
Build in the worktree: `node config/scripts/build-relay.mjs`, `pnpm run build:cli`,
`VITE_EXPOSE_STORE=true electron-vite build --mode e2e`, and `pnpm run build:web-from-renderer` for probe legs.
Driver per leg: `new-root`, `create`, `seed-p16`, `seed-local-p16`, `fetch-key`, `run-file`, the spec with
`SKIP_BUILD=1`, `teardown`; always check `procs` reports `PROC_COUNT=0` afterwards.

Three traps measured on the desktop PC:

- Probe file (`ORCA_HWF_PROBE_FILE`): the probe test's `HWF_PROBE_*` lines PLUS the provisioner `status`
  lines. Without `PROVIDER_CLAUDE` / `PROVIDER_CODEX` the agent leg prints `NOT_RUN provider-binary-absent`
  and still passes, so a green agent test is only a result when `HWF_AGENT_A_LAUNCH=observed` is printed.
- Keep run files OUTSIDE `%TEMP%`: the remote-first absence scan reads `os.tmpdir()`, and `create.txt` /
  `run.json` carry the seed nonce by design (two runs failed on exactly those two files).
- Write `seed-local.txt` as UTF-8: PowerShell `>` writes UTF-16 and `run-file` then reports
  `INCONCLUSIVE seed roots differ ... local=undefined`.

| Row | Spec | Result 2026-10-15 | Next |
|---|---|---|---|
| 63 | replica-pair `-g relay-compare-result`, phase 17 | PASS live | Done (`docs/dws/live-2026-10-15-rows-60-63-evidence.md`) |
| 60 | grouped-relation, phase 17 | PASS; the row-63 run is a live grouped relation | Done (same evidence file) |
| 73 | host-loss, phase 23 | PASS live in English, then again in Spanish with the tab-row fix and unforced clicks | Done (`docs/dws/live-2026-10-15-row-73-host-loss-evidence.md`) |
| 62 | `hwf-two-host-replica-settings-relation.spec.ts` (new), phase 17 seeded | PASS live, rendered row + screenshots; the stale footer it exposed is fixed | Done (`docs/dws/live-2026-10-15-row-62-settings-relation-evidence.md`) |
| 59 | remote-first, phase 15 | 6 of 6 PASS | PARTIAL: Owner decides the model-turn credential (OD-1) (`docs/dws/live-2026-10-15-row-59-remote-first-evidence.md`) |
| 34 | mission-placement, phase 17 seeded | Spec PASS: live proposal lists GEX44 + PC, two jobs spread | Still READY_FOR_LIVE: the spec plans in the test process, not via the app; needs `orca orchestration mission-place` over two hosts (Task Run with a bound coordinator terminal) |
| 74 | mixed-relay, phase 23, old relay build `5de29754c5` | App correct (`unverified (relay-too-old)`), instrument blind | See the instrument note below |
| 65 | replica-pair `-g disk-full-and-disconnect` | NOT RUN | `ORCA_HWF_SMALL_FS_ROOT` must be a dedicated <= 1 GiB filesystem on the machine running the APP (the spec fills it with `statfsSync` locally); on Windows that is a small VHD, which needs an elevated shell |
| 61 | `orca project setups --all-environments` | NOT RUN | Needs two real paired environments, one down |
| 70 | Continue here reattach to a live remote PTY | NOT RUN | No spec exists yet |
| 24 | workspace locality | NOT RUN | No committed two-host spec seeds a ready setup yet |

Row 74 instrument: counting `"method":` in the relay's logs cannot work, because no relay logs request
methods and an OLD relay never will. Count on the client instead, at the write: an e2e-only tally of
methods sent through `SshChannelMultiplexer.request` (`src/main/ssh/ssh-channel-multiplexer.ts`), read by
the spec through `electronApp.evaluate`. Count at the multiplexer, not in `requestGatedRelayMethod`, or
the gate certifies itself. The leg also needs the old relay build, which on the desktop PC would need a
second worktree with its own `pnpm install` (not done: RAM).

Harness fixes on this branch: provisioner over ssh stdin (Windows ENAMETOOLONG at 27 KB), row-63 expected
word from both measured sides, emitter lifetime 900 s (verified live, row 73), hwf agent-launch helpers
click the new-tab "+" without `force` (a forced click lands on whatever covers it).

## Product fixes on this branch (desktop PC)

- `ce24e2eda` tab row: at a 1366 px window the tab strip got 0 px (Spanish) / 22 px (English) and clipped
  its own "New tab" "+", because AppMenuStrip's fit check ignored the columns left of the header and the
  terminal toolbar. Now subtracted and re-measured when they change; the menu folds at 1366 px and keeps
  its labels at 1920 px. `tests/e2e/tab-row-new-tab-reachable.spec.ts` (5 tests, red before).
- Settings replica footer: "Relation not verified yet" was appended unconditionally to the grouping
  evidence and contradicted a published relation; the footer now states only the grouping commit.

## Other open items

- Owner decisions: model-turn credential (OD-1, row 59); units X05 X06 X16 X18 X19 (proposals in
  `.planning/workstreams/dwsrb/STATE.md` on GEX44); where vault/UKDL records for rows 52-54 and 76 live;
  the `dws-exec` cap.
- Debt: row-17 laptop tunnel leg; orca-dws-serve claude version pin; provisioner symlink check; orca-svc
  login (row 45); the anchor replica row reads unverified; ja, ko and zh replica strings not
  native-reviewed.
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
