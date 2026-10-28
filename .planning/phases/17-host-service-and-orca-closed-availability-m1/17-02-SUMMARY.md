---
phase: 17-host-service-and-orca-closed-availability-m1
plan: 02
subsystem: cli/serve-autostart, main/startup
status: complete
tags: [autostart, windows, task-scheduler, serve, single-instance, tdd]
requires: [17-01]
provides:
  - "buildServeAutostartTaskXml (pure) + Windows argv quoting"
  - "getServeAutostartStatus / installServeAutostart / removeServeAutostart behind an injectable exec"
  - "orca serve autostart install|remove|status (remove also answers to rm)"
  - "resolveLockHeldExitCode + SERVE_AUTOSTART_FLAG (src/shared)"
affects: [17-03]
tech-stack:
  added: []
  patterns: ["injectable exec seam for OS tools", "constant PowerShell script with inputs via env only", "shared literal in src/shared for CLI/main parity"]
key-files:
  created:
    - src/cli/runtime/serve-autostart.ts
    - src/cli/runtime/serve-autostart.test.ts
    - src/cli/runtime/serve-autostart-task-xml.ts
    - src/cli/runtime/serve-autostart-task-xml.test.ts
    - src/cli/handlers/serve-autostart.ts
    - src/cli/handlers/serve-autostart.test.ts
    - src/main/startup/serve-autostart-exit-wiring.test.ts
    - src/shared/serve-autostart-flag.ts
  modified:
    - src/cli/specs/serve.ts
    - src/cli/args.ts
    - src/cli/handler-group-manifest.ts
    - src/cli/runtime/launch.ts
    - src/main/startup/single-instance-lock.ts
    - src/main/startup/single-instance-lock.test.ts
    - src/main/index.ts
decisions:
  - "Task name `Orca Host Service (<user>)` in the root folder; user reduced to [A-Za-z0-9._-]"
  - "Status reads Get-ScheduledTask/Get-ScheduledTaskInfo (locale-free ints and ISO dates); a lookup error other than ObjectNotFound is autostart_status_unreadable, never 'not installed'"
  - "SERVE_AUTOSTART_FLAG lives in src/shared/serve-autostart-flag.ts, imported by both the CLI builder and main, instead of a duplicated literal"
  - "Restart policy PT1M x5, logon Delay PT10S (planner discretion within D-06)"
  - "`serve autostart remove` carries an `rm` alias to satisfy the CLI vocabulary policy; D-08's `remove` stays canonical"
metrics:
  duration: "~60 min"
  completed: 2026-10-27
actuals:
  tokens: 12300
  tasks: 3
  commits: 6
plan_head_before: 115c33185eca5de1fe3b4e17f0f169034c0195a6
---

# Phase 17 Plan 02: Windows logon Scheduled Task for the Host Service

`orca serve autostart install|remove|status` now manages a per-user logon Scheduled Task that runs
`<Orca executable> [app root] --serve --serve-autostart --serve-no-pairing`. The task definition comes from a
pure XML builder registered through `schtasks.exe /Create /XML`. Status reads Task Scheduler through a constant
PowerShell script, so the answer does not depend on the Windows display language. A launch carrying
`--serve-autostart` now exits 0 when a live Orca holds the single-instance lock, so RestartOnFailure never
loops. Manual serve and the desktop still exit 3.

## Commits (each RED commit comes before its fix)

| Order | Hash | Message |
|-------|------|---------|
| 1 | b8c121ede | test(17-02): RED serve autostart status runner does not exist |
| 2 | 445d3caa7 | feat(17-02): orca serve autostart status reads the logon task locale-free |
| 3 | 2f361afb5 | test(17-02): RED task XML builder and install/remove do not exist |
| 4 | 457b25169 | feat(17-02): serve autostart install/remove via schtasks /Create /XML |
| 5 | db7318a20 | test(17-02): RED lock-held exit ignores the autostart launch |
| 6 | 4f07a11fd | feat(17-02): lock held by a live Orca is success for the autostart launch |

## TDD Gate Compliance

**Task 1 RED** (`serve-autostart.test.ts` at 115c33185):
```
Error: Cannot find module './serve-autostart' imported from C:/owx-haf/src/cli/runtime/serve-autostart.test.ts
Test Files  1 failed (1)   exit=1
```
**Task 1 GREEN:** `serve-autostart.test.ts` 20/20 passed, exit 0. Verify set (+ manifest, registry-parity, vocabulary,
flag-parity): 52 passed, 1 failed. The failure is the known pre-existing `--serve-bind-host` case.

**Live positive control (win32, read-only, this laptop):** the nonce `Orca Absent <uuid>` read as `installed:false`. The
built-in task, queried through the same function, read:
```
[live-positive-control] {"installed":true,"taskName":"ScheduledDefrag","state":"disabled","lastTaskResult":267011,"lastRunTime":null,"command":"%windir%\\system32\\defrag.exe","arguments":"-c -h -o -$","workingDirectory":null}
```
(267011 = 0x41303 "task has not yet run", so the never-run date is correctly reported as `lastRunTime:null`.)
Tracer gate: verify re-ran end to end before expansion, PASS.

**Task 2 RED:** `serve-autostart-task-xml.test.ts`: `Cannot find module './serve-autostart-task-xml'`.
`serve-autostart.test.ts`: `TypeError: installServeAutostart is not a function` (x13). Result:
`Tests 13 failed | 21 passed`, exit 1.
**Task 2 GREEN:** xml + runtime + handler + manifest tests: `Test Files 4 passed, Tests 65 passed`, exit 0.
`launch.test.ts`: 13 passed, 4 skipped (unchanged). `registry-parity` and `vocabulary-policy`: pass.

**Task 3 RED:** 9 failed / 30 passed. `expected undefined to be '--serve-autostart'`. The wiring test failed with
`expected 'if (!hasSingleInstanceLock) {…' to contain 'app.exit(resolveLockHeldExitCode(process.argv))'` and
`not to contain 'app.exit(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)'`. The parity test failed with `expected '--serve-autostart' to be undefined`.
**Task 3 GREEN:** single-instance-lock + exit-wiring + serve-desktop-activation-wiring + task-xml + runtime tests:
`Test Files 5 passed, Tests 77 passed`, exit 0.

## Task 3 gates (final tree 4f07a11fd)

```
pnpm run typecheck:node             -> exit 0 (tsc --noEmit -p config/tsconfig.node.json, 0 errors)
pnpm run typecheck:cli              -> exit 0 (tsc --noEmit -p config/tsconfig.tc.cli.json, 0 errors)
pnpm run check:recurring-work       -> Recurring-work inventory OK [total=236 interval=48 watcher=8 self-rescheduling-timeout=102 worker=13 helper=36 self-rescheduling-frame=29] debt=0
pnpm run check:durability-contracts -> Durability contract check passed for 21 contract(s); 19 grandfathered durability publisher(s); 38 grandfathered direct state writer(s); 2 grandfathered durable-primitive delegate(s); 4 grandfathered durable publisher caller(s); no new ones.
```
No new timer, and no Orca-owned state file: the temp XML is deleted in `finally`, and Task Scheduler owns the task.

## Acceptance criteria

- Every D-06 value is asserted by name in `serve-autostart-task-xml.test.ts`: UTF-16 declaration, 1.2 namespace,
  LogonTrigger Enabled/UserId/Delay PT10S, InteractiveToken + LeastPrivilege, IgnoreNew, both battery flags false,
  ExecutionTimeLimit PT0S, StartWhenAvailable, StopOnIdleEnd false, RestartOnFailure PT1M/5, and Enabled.
- `serve-autostart.test.ts` asserts the exact argv: `schtasks.exe /Create /XML <file> /TN <name> /F` and `/Delete /TN <name> /F`.
  It also asserts the UTF-16LE BOM `FF FE`, that the temp dir is gone after both success and failure, that `remove` makes no schtasks call
  for an absent task, and that `ORCA_CLI_CWD` refuses install/remove before any exec while status is still allowed.
- The PowerShell `-Command` is the constant `SERVE_AUTOSTART_STATUS_SCRIPT`. A hostile task name appears only in the env.
- `isCommandGroup(['serve','autostart'])` is true and `['serve']` is still false. The `serve` spec's flags are untouched.
- All five lock-exit mappings are asserted, plus normalized argv and no desktop activation for an autostart second instance.
  The wiring test anchors are asserted `>= 0`, and there is exactly one `app.exit(resolveLockHeldExitCode(` in index.ts.
- No real schtasks `/Create`, `/Run` or `/Delete` ran. The only live call was the read-only `Get-ScheduledTask` positive control.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] install/remove specs moved from Task 1 to Task 2**
- **Issue:** registry-parity requires a handler for every spec. Adding the three specs in Task 1 while deferring the install/remove
  handlers, as the plan said, would have left Task 1's commit red.
- **Fix:** Task 1 added only the status spec. The install/remove specs landed with their handlers and manifest keys in 457b25169.

**2. [Rule 3 - Blocking] Vocabulary policy rejects a bare `remove` verb**
- **Fix:** `serve autostart remove` keeps D-08's path and gets the alias `['serve','autostart','rm']`. The handler key is unchanged. (457b25169)

**3. [Rule 3 - Blocking] The CLI typecheck cannot import `src/main/startup/single-instance-lock.ts`**
- **Issue:** the plan's parity test imported main's flag into a CLI test. `tsconfig.cli.json` lists main files explicitly, and this
  one pulls in `startup-diagnostics.ts` (TS6307).
- **Fix:** I used one literal in `src/shared/serve-autostart-flag.ts`, which both projects include, so the CLI builder and main import
  the same constant. The parity test checks that the builder's flag equals the shared one. It also checks by source that main imports the shared module and that
  `resolveLockHeldExitCode` reads it. The behavioural argv check stays in `single-instance-lock.test.ts`. (4f07a11fd)

**4. [Rule 2 - Correctness] Status distinguishes "absent" from "lookup failed"**
- `-ErrorAction SilentlyContinue` alone would report an access-denied lookup as "not installed". The script now exits 0 with no
  output only for `ObjectNotFound`. Any other error exits 3, which the runner raises as `autostart_status_unreadable`.

**5. [Rule 3 - Blocking] oxlint (prefer-ternary, prefer-template) in the argv quoter**
- The pre-commit hook rejected the first Task 2 commit, and lint-staged reverted it. I rewrote the loop body as a single template expression
  and recommitted. No `--no-verify` was used.

### Process notes
- The PowerShell tool was not available. Shell work ran through Bash with the `# bash-safe` marker, and output was captured under
  `C:\Users\Jacobo\.claude\jobs\bcab54e5\tmp`.
- A destructive-state guard matched the word "rm" inside a commit message. Nothing was deleted, and the command was re-issued unchanged.
- Each commit body was checked with `git log -1 --format=%B`. None contains injected text.

## Deferred Issues

These failures were already present and are out of scope (see `deferred-items.md`). Both are unchanged by this plan:
- `serve-electron-flag-parity.test.ts`: 1 of 11 (`--serve-bind-host` not read by getServeOptions). The `serve` spec was not touched.
- `desktop-startup-ordering.test.ts`: 3 tests with a stale window-open anchor. Not run here.

## Open risk for 17-03

The task XML has never been accepted by a real `schtasks /Create` on this machine, because that write is held for the Owner's go. Element order inside
`LogonTrigger` follows real exports (EndBoundary, Enabled, UserId, Delay). If Task Scheduler rejects the definition, 17-03's live leg is the
first place it will show. `install` raises `autostart_install_failed` with schtasks' stderr, which is localized and decoded as UTF-8, so
accented text may be garbled.

## Known Stubs

None.

## Threat Flags

None beyond the register:
- T-17-06: principal assertions in the builder test.
- T-17-07: escaping and argv quoting tests.
- T-17-08: constant script, name passed through env only.
- T-17-09: ORCA_CLI_CWD refusal.
- T-17-10: per-call mkdtemp directory, removed in finally.
- T-17-11: IgnoreNew, the 5-restart bound, and exit 0 on a held lock.
- T-17-12: `--serve-no-pairing` in the default args.

## Self-Check: PASSED

All 8 created files exist; commits b8c121ede, 445d3caa7, 2f361afb5, 457b25169, db7318a20, 4f07a11fd resolve.
