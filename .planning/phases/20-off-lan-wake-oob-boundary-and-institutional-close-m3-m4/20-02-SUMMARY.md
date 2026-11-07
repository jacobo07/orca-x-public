---
phase: 20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4
plan: 02
subsystem: host-availability
status: complete
tags: [oob, can-power-on-oob, can-wake-remote, os-probe, system32-path, read-only-live-leg]
requires: [18-02 host availability producer, 19-01 WOL probe pattern]
provides: [host-oob-verdict.ts, host-oob-probe.ts (createHostOobProbe, defaultHostOobProbeDeps, OOB_STATUS_MAX_AGE_MS), describeRemoteWakeCapability, src/shared/windows-system-tool-path.ts (getWindowsSystemToolPath), host-oob-probe.live.test.ts]
affects: [20-04 G6 ratchet scopes describeRemoteWakeCapability and the OOB producer, 20-05 re-runs the live leg into 20-oob-probe-evidence.json]
tech-stack:
  added: []
  patterns: [WOL-probe shape reused for OOB (deps injection, single-flight, max age, no timer, settled), per-platform verdict composers over pure parsers, one absolute System32 path authority, source-text pin for a path-authority adoption]
key-files:
  created:
    - src/main/runtime/host-oob-verdict.ts
    - src/main/runtime/host-oob-verdict.test.ts
    - src/main/runtime/host-oob-probe.ts
    - src/main/runtime/host-oob-probe.test.ts
    - src/main/runtime/host-oob-probe.live.test.ts
    - src/shared/windows-system-tool-path.ts
    - src/shared/windows-system-tool-path.test.ts
  modified:
    - src/main/runtime/host-availability-producer.ts
    - src/main/runtime/host-availability-producer.test.ts
    - src/main/runtime/rpc/methods/status.test.ts
    - src/main/startup/host-availability-wiring.test.ts
    - src/shared/secure-path-windows-acl.ts
    - src/main/index.ts
    - .planning/STATE.md
    - .planning/ROADMAP.md
decisions:
  - "20-02: can-power-on-oob is measured read-only; AMD reads not-supported/hardware_bound_amd_no_amt (os-probe), Intel reads unknown (intel_mei_not_detected or intel_amt_unverified), any read failure reads unknown; no verdict branch yields supported (D-07)"
  - "20-02: a missing CPU vendor (ARM cpuinfo, empty sysctl) reads unknown/oob_cpu_vendor_unreported, distinct from an unrecognized vendor (oob_vendor_unrecognized)"
  - "20-02: can-wake-remote has one producer, describeRemoteWakeCapability, returning not-configured/no_wake_broker/host-announced for every relay readiness (D-04 option B)"
  - "20-02: windows-system-tool-path.ts is the one System32 path rule; secure-path-windows-acl.ts imports it and the OOB probe spawns PowerShell through it; darwin spawns /usr/sbin/sysctl"
  - "20-02: index.ts registers the oob source in the same commit that makes it required, so typecheck:node never went red (plan-check info 1)"
metrics:
  duration: 22min
  completed: 2026-10-28
plan_head_before: 229122a5ebd3f46cfcff87bd1d647e3bd5e4428e
actuals:
  tokens: 11299
  tasks: 3
  commits: 6
---

# Phase 20 Plan 02: Measured OOB probe and pinned remote-wake capability Summary

`status.get` now reports `can-power-on-oob` from a read-only check of the CPU vendor and Intel management engine,
instead of phase 18's fixed `oob_not_measured`. On this AMD laptop it reads
`not-supported / hardware_bound_amd_no_amt` with `os-probe` evidence. `can-wake-remote` comes from one exported
producer that answers `not-configured / no_wake_broker` on every host. Windows tool spawns now get their path from
one absolute System32 rule.

The `HARDWARE_BOUND` label from D-07 is used only in verification text. The wire carries the lowercase reason,
which passes `^[a-z0-9_]{1,64}$` and is not turned into `unspecified` (research pitfall 1).

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 (tracer) | A Windows CPU/MEI read reaches status.get; can-wake-remote scoped and pinned | 673cdf679 | b4ca14e0d |
| 2 | Verdict tables for Windows/Linux/macOS, probe bounds, default deps | cbd4880ca | 422abaa5c |
| 3 | Register and prime at both start paths, ACL adopts the path rule, live read | d3754fd99 | 10d438dd9 |

### RED failure lines (pasted)

- Task 1: `Error: Cannot find module './host-oob-probe' imported from C:/owx-haf/src/main/runtime/host-availability-producer.test.ts` and the same for `../../host-oob-probe` in status.test.ts. `Test Files  2 failed (2)`, `Tests  no tests`. The tests fail because the module does not exist yet.
- Task 2: `Tests  29 failed | 11 passed (40)`. The failures are `TypeError: windowsOobVerdict is not a function` (plus the linux and darwin composers), `expected 'oob_platform_pending' to be 'oob_probe_unreadable'`, `expected [] to deeply equal [ { file: '/usr/sbin/sysctl', ... } ]`, and the missing-vendor row.
- Task 3: `Tests  2 failed | 10 passed | 1 skipped (13)`. The failures are `AssertionError: const serveHostRelay = hostRelayOwner.start(: expected '\n    // Why: start the first Task Sc…' to [contain hostOobProbe.read()]` and `expected 'import { execFile, execFileSync } fro…' not to contain 'function getWindowsSystemToolPath'`.

The tracer feedback gate after Task 1 re-ran `<verify>` end to end: `Test Files  2 passed (2)`, `Tests  39 passed (39)`,
and `typecheck_node_exit=0`. It passed, so expansion went ahead.

## Verification (at HEAD 10d438dd9, this laptop)

| Command | Result |
|---------|--------|
| `vitest run` host-oob-verdict.test.ts, host-oob-probe.test.ts, host-availability-producer.test.ts | `Test Files  3 passed (3)` / `Tests  71 passed (71)` |
| `vitest run` rpc/methods/status.test.ts, startup/host-availability-wiring.test.ts, src/shared/windows-system-tool-path.test.ts | `Test Files  3 passed (3)` / `Tests  20 passed (20)` |
| `vitest run` wiring + path + live (no env) + src/shared/secure-file.test.ts (ACL regression) | `Test Files  3 passed \| 1 skipped (4)` / `Tests  27 passed \| 3 skipped (30)` |
| `pnpm run typecheck:node` | exit 0 (also exit 0 after each GREEN commit) |
| `pnpm exec tsc --noEmit -p config/tsconfig.tc.web.json` | exit 0 |
| `pnpm run typecheck:cli` | exit 0 |
| `pnpm run check:recurring-work` | `Recurring-work inventory OK [total=236 interval=48 watcher=8 self-rescheduling-timeout=102 worker=13 helper=36 self-rescheduling-frame=29] debt=0` (total unchanged from 19) |
| `pnpm run check:host-card-claims` | `check-host-card-claims: 22 labels classified, 2 controls classified, 598 host RPC methods known, no unevidenced power-loss state, no control without an effect.` |
| `pnpm run check:durability-contracts` | `Durability contract check passed for 22 contract(s); ... no new ones.` |
| `git diff --quiet -- config/recurring-work-debt-baseline.txt` | exit 0 |
| `git diff --quiet HEAD -- mobile` | exit 0 |
| `git diff --quiet HEAD -- src/main/runtime/host-wol-probe.ts` | exit 0 (IN-03 stays deferred) |
| `Select-String host-oob-verdict.ts "value:\s*'supported'"` (non-comment) | 0 lines |
| `Select-String secure-path-windows-acl.ts 'function getWindowsSystemToolPath'` / `"from './windows-system-tool-path'"` | 0 lines / 1 line |
| `Select-String src/main/index.ts 'oob-power'` | 0 lines |

The whole-table assertion message reads `table has 20 rows` (minimum 16). Every reason in the table matches the wire
pattern. Every non-unknown verdict carries `os-probe` evidence, and every unknown carries null.

## Live read-only leg (measured, this laptop, 2026-10-28 12:06 local)

The leg ran once with `ORCA_LIVE_OOB_PROBE=1` and `ORCA_LIVE_OOB_EVIDENCE` set to the job temp file
`C:\Users\<owner>\.claude\jobs\fd0cc958\tmp\20-02-live-oob-evidence.json`. Result: `Test Files  1 passed (1)`,
`Tests  1 passed (1)`, live_exit=0. The leg ran; it was not skipped. It made Get-CimInstance reads only. Nothing
touched BIOS, power settings or Fast Startup, and nothing was elevated.

- Verdict: `{"value":"not-supported","reason":"hardware_bound_amd_no_amt","evidence":{"kind":"os-probe","observedAt":1793185595560}}`
- Positive control: `"vendor": "AuthenticAMD"`, `"meiCount": 0` (PowerShell exit 0). A reader that saw nothing
  would have no vendor string and no finite count, so it could not pass.

This matches the 2026-10-27 research measurement (AuthenticAMD, MEI 0). The evidence comes from the JSON file because
the test setup suppresses `console.log` even with `--silent=false`, so the `[live-oob]` lines are not in the vitest
output. In the verdict JSON, `observedAt` is 1793185595560 ms. Read as a Unix epoch that is about 2026-10-28T11:06Z,
which matches the run time (12:06 local, UTC+1). 20-05 re-runs the leg at the phase HEAD into
`20-oob-probe-evidence.json`.

## Deviations from Plan

### Orchestrator-directed

**1. [Binding, plan-check info 1] index.ts `oob` registrations moved into Task 1 GREEN**
- **Why:** every GREEN commit has to leave `typecheck:node` passing. The plan had left it red until Task 3.
- **What moved forward:** `b4ca14e0d` also adds the index.ts import, the module-scope
  `const hostOobProbe = createHostOobProbe(defaultHostOobProbeDeps())`, and `oob: hostOobProbe` at both
  registrations. To make that compile, `defaultHostOobProbeDeps()` and `src/shared/windows-system-tool-path.ts`
  (planned for Task 2) also landed in Task 1.
- **Effect on TDD order:** Task 2's absolute-PowerShell-path test and most of Task 3's path tests were already green
  at their RED commits. Each RED still failed on its own behavior. Task 2 failed on the per-platform composers and
  branches. Task 3 failed on priming (`hostOobProbe.read()` after each registration stayed in Task 3) and on a new
  source pin that the ACL module imports the path rule. That pin was added so the ACL adoption had a genuine RED.
- **Result:** `typecheck:node` was exit 0 after b4ca14e0d, 422abaa5c and 10d438dd9.

### Auto-fixed / refinements

**2. [Rule 2 - correctness] A missing vendor gets its own reason**
- Task 1's text maps "a null or other vendor" to `oob_vendor_unrecognized`. Task 2's behavior requires
  `oob_cpu_vendor_unreported` for a host with no `vendor_id` line. The Task 2 GREEN commit 422abaa5c makes a null
  vendor read `oob_cpu_vendor_unreported` and keeps `oob_vendor_unrecognized` for a vendor string that is present
  but unknown. Both values are unknown with null evidence.

**3. [Rule 3 - structure] Per-platform composers exported from the verdict module**
- `windowsOobVerdict`, `linuxOobVerdict` and `darwinOobVerdict` are added next to the four planned exports. This lets
  the verdict table test whole OS outputs without spawning anything, as the WOL verdict module does, and the probe
  calls the composers directly.

**4. [Rule 2 - test window] The wiring priming window is 8 lines for OOB**
- The OOB read follows the autostart and WOL primes, each with a Why line, so it sits on line 7 after the
  registration. `primedAfter` takes a line count, and the WOL assertion keeps its 6.

**5. Script quoting:** `WINDOWS_OOB_PROBE_SCRIPT` contains no double quotes, because Windows argv quoting rewrites
them. The filter uses doubled single quotes. The interface sketch used `"Name LIKE '%Management Engine%'"`, which
would have been rewritten in transit. The live leg shows the constant script parses on this host.

### Process notes (not deviations in scope)

- After 3 of the 6 commits, lint-staged's oxfmt left a stale pre-format index. Each time the tree equalled HEAD,
  so only those index entries were reset (the 2026-10-27 STATE decision). After every commit,
  `diff --cached --quiet` ended at 0.
- The project's lint-staged pre-commit hook makes its own internal `git stash` backup. This executor ran no stash
  command.

## Known Stubs

None. Every OOB answer is either measured or an explicit unknown with a reason. No new UI.

## Threat Flags

None beyond the plan's register. T-20-07: constant script, argv-only `execFile`, absolute System32 PowerShell and
absolute `/usr/sbin/sysctl`. T-20-08: single-flight with a 600 s max age, no timer, debt=0. T-20-09: the table never
yields supported. T-20-10: the serialized announcement has no `AuthenticAMD` and no `MS-7B89`. T-20-11: reads only.
T-20-12: the path rule moved verbatim, is unit-tested, its call sites are unchanged, and three typechecks pass.

## Self-Check: PASSED

- Files: all 7 created files exist. The final sweep reports their line counts: verdict 78, probe 160, path 10,
  verdict test 136, probe test 187, live 58, path test 43, all under the caps. No max-lines disables.
- Commits: 673cdf679, b4ca14e0d, cbd4880ca, 422abaa5c, d3754fd99 and 10d438dd9 are all in
  `git log 229122a5e..HEAD`. `git rev-list --count 229122a5e..HEAD` = 6 before this docs commit.
