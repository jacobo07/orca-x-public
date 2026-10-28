---
phase: 19-wake-on-lan-capability-and-the-lan-wake-broker-m2
plan: 01
subsystem: host-availability
status: complete
tags: [wake-on-lan, host-availability, os-probe, status.get]
requires: [phase 18 host availability producer, host-autostart-probe model]
provides: [measured can-wake-lan via createHostWolProbe, host-wol-verdict D-02 tables]
affects: [status.get hostAvailability, config/host-card-claims.jsonc]
tech-stack:
  added: []
  patterns: [request-driven single-flight OS probe with max age, pure verdict module over OS output]
key-files:
  created:
    - src/main/runtime/host-wol-verdict.ts
    - src/main/runtime/host-wol-verdict.test.ts
    - src/main/runtime/host-wol-probe.ts
    - src/main/runtime/host-wol-probe.test.ts
    - src/main/runtime/host-wol-probe.live.test.ts
  modified:
    - src/main/runtime/host-availability-producer.ts
    - src/main/runtime/host-availability-producer.test.ts
    - src/main/runtime/rpc/methods/status.test.ts
    - src/main/index.ts
    - src/main/startup/host-availability-wiring.test.ts
    - config/host-card-claims.jsonc
decisions:
  - "19-01: unelevated Get-NetAdapterPowerManagement fails (Windows system error 31) on this laptop's Realtek NIC; the probe falls back to the language-independent *WakeOnMagicPacket advanced property, and an Ethernet adapter still unreadable makes the verdict unknown/wol_adapter_unreadable, never not-supported"
  - "19-01: Linux interface names are argv to ethtool only when they match ^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,14}$ (no leading dash)"
  - "19-01: this laptop measures can-wake-lan unknown/firmware_unverified (Realtek WakeOnMagicPacket Enabled and in powercfg wake_armed)"
metrics:
  duration: 17min
  completed: 2026-10-27
plan_head_before: 490ee6849c3bf7fcd6f3593d0960190aceff32e3
actuals:
  tokens: 12296
  tasks: 3
  commits: 6
---

# Phase 19 Plan 01: Wake-on-LAN capability probe Summary

`can-wake-lan` is now measured by a read-only, single-flight Wake-on-LAN probe on Windows (adapter script plus powercfg), Linux (ethtool, then sysfs) and macOS (pmset womp). The value travels through the phase 18 producer to `status.get` from both host start paths. No branch can yield `supported` (D-02).

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 (tracer) | A Windows WOL read reaches status.get as can-wake-lan | 347020a5e | 92d012ab3 |
| 2 | Verdict tables for win32/linux/darwin, probe bounds, live leg | 2d4f1bf64 | 56b3cab9e |
| 3 | Register the probe at both start paths, claims table evidence | 69618ec6b | eca5f1923 |

## Verification (observed on this laptop, 2026-10-27)

RED lines:
- Task 1: `Error: Cannot find module './host-wol-verdict' imported from C:/owx-haf/src/main/runtime/host-wol-probe.test.ts` / `Test Files  2 failed (2)`.
- Task 2: `Tests  20 failed | 51 passed (71)` (linuxWolVerdict / darwinWolVerdict not functions; linux, darwin and unlisted-platform probe rows read `wol_platform_pending`).
- Task 3: `AssertionError: expected +0 to be 1` on `countOccurrences(source, 'createHostWolProbe(')`, `Tests  1 failed | 4 passed (5)`.

GREEN and gates:
- Task 1 verify (`host-wol-probe.test.ts`, `status.test.ts`): `Test Files  2 passed (2)`, `Tests  11 passed (11)`. The tracer gate re-ran it end to end before the expansion task.
- Task 2 verify (4 files): `Test Files  4 passed (4)`, `Tests  74 passed (74)`. The verdict table has 26 rows (the assertion message names the count). None yields supported.
- Task 3 verify block, run in order, every step exit 0:
  - vitest wiring + `check-host-card-claims.test.mjs`: `Tests  37 passed (37)`
  - `check:host-card-claims`: `check-host-card-claims: 22 labels classified, 2 controls classified, 589 host RPC methods known, no unevidenced power-loss state, no control without an effect.` (same 22 labels / 2 controls as phase 18)
  - `typecheck:node` exit 0; `tsc --noEmit -p config/tsconfig.tc.web.json` exit 0
  - `check:recurring-work`: `Recurring-work inventory OK [total=236 interval=48 watcher=8 self-rescheduling-timeout=102 worker=13 helper=36 self-rescheduling-frame=29] debt=0`
  - `git diff --quiet -- config/recurring-work-debt-baseline.txt` exit 0; `git diff --quiet HEAD -- mobile/src/components` exit 0
- Plan verification (6 files): `Test Files  6 passed (6)`, `Tests  111 passed (111)`.
- `Select-String -Path src/main/runtime/host-wol-verdict.ts -Pattern "value: 'supported'"`: 0 hits.

Live leg (`ORCA_LIVE_WOL_PROBE=1`, read only, `Test Files  1 passed (1)`), evidence file contents:
- Verdict: `{"value":"unknown","reason":"firmware_unverified","evidence":null}`
- Positive control: 1 adapter row `{ name: Ethernet, interfaceDescription: Realtek PCIe GbE Family Controller, mediaType: 802.3, wakeOnMagicPacket: Enabled }`. powercfg returned 6 non-empty lines and armedCount was 6; the Realtek NIC is among the armed devices.
- The first run failed and found the defect described under Deviation 1: the verdict was `unknown/wol_probe_unreadable` because adapterRows was null.

Only read-only cmdlets and queries ran: Get-NetAdapter, Get-NetAdapterPowerManagement, Get-NetAdapterAdvancedProperty, and `powercfg /devicequery`. No power setting was changed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The Windows adapter read failed on this laptop's only NIC**
- **Found during:** Task 2 live leg
- **Issue:** Unelevated, `Get-NetAdapterPowerManagement -Name Ethernet` throws CimException "Windows System Error 31" (the device is not functioning) for the Realtek NIC. With `ErrorActionPreference = 'Stop'` the whole script exited 1, so the probe read `wol_probe_unreadable` on a machine whose setting is readable.
- **Fix:** For each adapter the script tries `Get-NetAdapterPowerManagement`. If that fails, it falls back to the `*WakeOnMagicPacket` advanced property (a standard registry keyword, so it does not depend on the UI language; 1 = Enabled). If neither can be read, the adapter reports `Unreadable`. `windowsWolVerdict` treats an unreadable Ethernet adapter, when no other adapter is capable, as `unknown/wol_adapter_unreadable` and never as not-supported. Three table rows cover this. The live positive control no longer counts `Unreadable` as having read the setting.
- **Files:** host-wol-verdict.ts, host-wol-verdict.test.ts, host-wol-probe.live.test.ts
- **Commit:** 56b3cab9e

**2. [Rule 2 - Security] An interface name could be read as an ethtool option**
- **Found during:** Task 2
- **Issue:** Interface names come from `/sys/class/net` and are passed as argv. Linux allows a name that starts with `-`, and ethtool would parse it as an option (T-19-01).
- **Fix:** A name must match `SAFE_INTERFACE_NAME` before it is spawned. A probe test checks that `-s` is never passed.
- **Commit:** 56b3cab9e

### Notes
- Task 1 deferred the typecheck to Task 3, as the plan allows; it passed there.
- The plan described `src/main/index.ts` as CRLF, but the working copy is LF. It was edited with a line-ending-aware script, and the wiring test already normalizes line endings.
- The plan expected this laptop to measure needs-owner-setup. It measured unknown/firmware_unverified because the Realtek NIC is already in `wake_armed`. Following the plan, the measured value is recorded rather than asserted.
- The vitest config does not print console output for passing tests, so the verdict line above was copied from the `ORCA_LIVE_WOL_EVIDENCE` JSON file (job tmp `live-wol-evidence.json`).

## Known Stubs

None.

## Self-Check: PASSED

- All 5 created files exist, and all 6 commits are on `mobile/host-availability`: 347020a5e, 92d012ab3, 2d4f1bf64, 56b3cab9e, 69618ec6b, eca5f1923.
