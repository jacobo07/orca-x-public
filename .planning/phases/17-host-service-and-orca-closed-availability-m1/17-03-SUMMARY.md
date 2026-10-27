---
phase: 17-host-service-and-orca-closed-availability-m1
plan: 03
subsystem: host-service
status: complete
tags: [serve, host-service, live-leg, scripted-client, task-scheduler, owner-bound]
requires: [17-01, 17-02]
provides:
  - live windowless Host Service leg (SCRIPTED CLIENT) with measured startup, idle RAM/CPU, exit 3 / exit 0
  - run-only autostart trigger option (`trigger: 'none'`) for a disposable task
  - disposable Task Scheduler live leg, written and gated (not run)
affects: [17-VERIFICATION.md]
tech-stack:
  added: []
  patterns: [env-gated *.live.test.ts, GEX44 disposable build, positive-controlled instruments]
key-files:
  created:
    - src/main/runtime/host-service-orca-closed-leg.live.test.ts
    - src/cli/runtime/serve-autostart-task.live.test.ts
    - .planning/phases/17-host-service-and-orca-closed-availability-m1/17-03-evidence.json
    - .planning/phases/17-host-service-and-orca-closed-availability-m1/17-VERIFICATION.md
  modified:
    - src/cli/runtime/serve-autostart-task-xml.ts
    - src/cli/runtime/serve-autostart-task-xml.test.ts
    - src/cli/runtime/serve-autostart.ts
    - src/cli/runtime/serve-autostart.test.ts
decisions:
  - "Task Scheduler leg recorded OWNER_BOUND; restart-on-failure UNMEASURED (no Owner go in STATE.md this session)"
  - "Run-only disposable task carries its EndBoundary on a disabled TimeTrigger so DeleteExpiredTaskAfter has a trigger to expire; default logon XML byte-identical"
  - "Leg 1b ran on cited no-network path relay-auth-context.ts:10-13 + relay-auth-coordinator.ts:134-141"
  - "Idle CPU 0 recorded as below instrument resolution, with a positive control, never as zero"
metrics:
  duration: ~25 min
  completed: 2026-10-27
plan_head_before: 1ec6a6bd8932768b0869ca435bcb6bbe10a194c7
commits: 4
actuals:
  tokens: 9000
  tasks: 3
  commits: 4
---

# Phase 17 Plan 03: Live Host Service leg and Owner-bound handoff Summary

A windowless `--serve` host on this laptop, never shown a window, was paired by a SCRIPTED CLIENT that got FRESH output twice; a duplicate launch exited 3 and an autostart duplicate exited 0 with one serve main process. The Task Scheduler leg and the Owner-PC legs are recorded OWNER_BOUND.

## Step A: GEX44 build (done before writing the leg)

- Bundle of HEAD 1ec6a6bd8 shipped to fresh `/tmp/orca-phone-p17-20261027165305` (no prior p17 root).
- First build: **BUILD_FAIL**. The plain-node-entry guard could not load node-pty `pty.node`, because the recipe's `--ignore-scripts` install skips the native build.
- Fix in the disposable root: `pnpm rebuild node-pty`, then `build:electron-vite` passed.
- `out.tgz` sha256 082d41ea...a330 matched on both ends. Only `out/` was extracted into C:\owx-haf (gitignored by `out/` in .gitignore, absent from `git status`).
- Root removed: `ls /tmp | grep orca-phone-p17` printed `NONE_P17`.
- A second disposable root (`/tmp/orca-phone-p17-20261027170753`) typechecked fd16aa0ac: `typecheck:node` rc=0, `typecheck:cli` rc=0. That root was also removed (`NONE_P17`).

## Task 1: live leg, SCRIPTED CLIENT (PASS)

Run: the `ORCA_LIVE_HS_*` env was set and the platform was win32; scratch was `%TEMP%\orca-hs-p17-20261027165917`. Output tail (the vitest text was compressed by the RTK proxy): `PASS (1) FAIL (0)`, `vitest rc=0`. The evidence file was written by the test itself at 16:01:32Z.

| Measure | Value |
|---|---|
| startupMs (spawn to `orca_server_ready`) | 18192 |
| readiness 1a | appVersion `1.4.178-rc.2`, relay `{state:'unavailable', reason:'cloud_auth_not_configured'}`, pairing available |
| idle (60 s settle, 30 s window) workingSetBytes / privateBytes | 346181632 / 277692416 |
| cpuPercentOneCore / cpuPercentAllCores (12 logical) | 0 / 0, below instrument resolution. Positive control on the same CIM fields: busy loop 100.625 %, 50 ms ticker 1.25 % |
| processCount (idle tree) | 4 (main, crashpad, gpu, network utility) |
| repo registration | runtime pipe `repo.add`; the mobile `repo.add` was refused |
| FRESH #1 / #2 | `HOST JACOBO-PC win32`, nonces 433c391a / d521120e |
| runtimeId via `status.get` | equals readiness, unchanged after duplicates |
| duplicateExitCode / autostartDuplicateExitCode | **3 / 0** |
| serveMainProcessCount | **1** (baseline 0) |
| leg 1b (production cloud constants, no stored identity) | relay `{state:'started', status:null}`. `leg1bNoNetworkCitation` is recorded |
| teardown | spawned pids reaped true; serve mains 0; scratch-family processes 0; scratch absent true |
| Owner orca-devices.json sha256 before / after | 39759f41...aa7b / identical |

The reap was confirmed outside the test too: `Get-Process electron` found none before or after, the scratch dir is gone, and the host log was deleted.

## Task 2: Task Scheduler leg (OWNER_BOUND)

- No Owner go is recorded in STATE.md, so no real `schtasks /Create`, `/Run` or `/Delete` was called. restart-on-failure is **UNMEASURED**.
- The 17-02 builder could not omit its LogonTrigger. Added `trigger?: 'logon' | 'none'`, defaulting to logon, with the default XML byte-identical. With `'none'` there is no LogonTrigger; when an end boundary is given, it is carried on a disabled TimeTrigger. `installServeAutostart` passes the option through. This was done test-first: RED at 34d3347f8 (2 failed for the right reason), GREEN at fd16aa0ac (55 passed).
- `serve-autostart-task.live.test.ts` is written and skipped unless `ORCA_LIVE_SCHTASKS=1`. Without env it reports skipped, which is not evidence.
- No `Orca HAF Disposable` task exists: the `schtasks /Query` count is 0. The ScheduledDefrag positive-control pair was not pasted, because no task was ever created.

## Task 3: checkpoint (recorded, not performed)

17-VERIFICATION.md (`status: human_needed`) carries SC rows, the Task Scheduler items, and Owner rows O1-O6, all OWNER_BOUND. Its automated check passes (rc=0).

## Deviations from Plan

1. **[Rule 3 - Blocking] GEX44 recipe:** the `--ignore-scripts` install breaks `build:electron-vite`, because the node-pty smoke load fails. Fixed with `pnpm rebuild node-pty` in the disposable root. The STATE.md recipe should say this.
2. **[Rule 2 - Correctness] CPU 0 positive control:** added the `cpuInstrumentPositiveControl` and `cpuInstrumentNote` evidence, so that 0 is not read as zero.
3. **[Rule 1 - Lint] `curly`:** wrapped the two single-line `if` statements in the leg after the evidence run. The semantics are identical, and lint-staged formatted the files on commit.
4. **Commit protocol:** commits landed on `mobile/host-availability`, as 17-01 and 17-02 did and as the caller instructed. The executor's `agent-*` worktree branch allow-list was not applied.

## Known Stubs

None.

## Self-Check: PASSED

- Files present: both live test files, 17-03-evidence.json (valid JSON), 17-VERIFICATION.md.
- Commits present: 34d3347f8, 6d4794aa6, fd16aa0ac.
