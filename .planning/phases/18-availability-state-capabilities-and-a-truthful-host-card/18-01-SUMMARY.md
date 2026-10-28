---
phase: 18-availability-state-capabilities-and-a-truthful-host-card
plan: 01
subsystem: runtime-rpc / shared availability model
status: complete
tags: [host-availability, status.get, capabilities, autostart, wire-compat]
requires: [phase 17 relay readiness (host-relay-startup.ts), phase 17 autostart status (serve-autostart.ts)]
provides: [src/shared/host-availability.ts, host availability producer, host autostart probe, status.get hostAvailability]
affects: [18-02 mobile host card, 18-03 host-card claims gate]
tech-stack:
  added: []
  patterns: [total parser over untrusted host answer, single-flight + max-age request-driven probe, capability string gate]
key-files:
  created:
    - src/shared/host-availability.ts
    - src/shared/host-availability.test.ts
    - src/shared/serve-autostart-status.ts
    - src/main/runtime/host-availability-producer.ts
    - src/main/runtime/host-availability-producer.test.ts
    - src/main/runtime/host-autostart-probe.ts
    - src/main/runtime/host-autostart-probe.test.ts
    - src/main/runtime/rpc/methods/status.test.ts
    - src/main/startup/host-availability-wiring.test.ts
  modified:
    - src/shared/protocol-version.ts
    - src/shared/runtime-types.ts
    - src/main/runtime/rpc/methods/status.ts
    - src/cli/runtime/serve-autostart.ts
    - src/main/index.ts
decisions:
  - "Orca detail for a serve host echoes only recognized window statuses; an unrecognized one reads unrecognized_window_status (host string never echoed)"
  - "Host autostart probe deps carry env (process.env by default) so powershell.exe keeps SystemRoot/PATH; plus a settled() method for tests and the live leg"
  - "Relay unavailable mobile_runtime_not_ready / relay_startup_failed stay unknown with that reason; only cloud_auth_not_configured is needs-owner-setup"
metrics:
  duration: 18min
  completed: 2026-10-27
actuals:
  tokens: 15000
  tasks: 3
  commits: 6
plan_head_before: 4f885eae9f20aca580e3468a8129d63681c772dc
---

# Phase 18 Plan 01: Availability model, capabilities and the status.get host producer Summary

status.get now carries an additive `hostAvailability` announcement (schema 1, six capabilities with value + reason +
evidence) behind `host.availability.v1`. A shared, Node-free model composes power / orca / connectivity as three
fields, where no live answer is always `unknown` and never `powered-off`. can-start-orca comes from a
single-flight, 5-minute-bounded read of the phase 17 Task Scheduler status.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 RED | 773100aab | test(18-01): RED status.get carries no host availability |
| 1 GREEN | 4177bf3bb | feat(18-01): status.get carries hostAvailability behind host.availability.v1 |
| 2 RED | 449a53333 | test(18-01): RED composition and capability mapping tables |
| 2 GREEN | 27f354622 | feat(18-01): full orca composition and capability mapping tables |
| 3 RED | eaee8fc2c | test(18-01): RED can-start-orca probe and host availability wiring |
| 3 GREEN | b2ae2fa06 | feat(18-01): can-start-orca from the Task Scheduler read; register both hosts |

START (before RED) = 4f885eae9.

## RED evidence

Task 1 (status.test.ts, before any implementation):
```
FAIL  src/main/runtime/rpc/methods/status.test.ts
Error: Cannot find module '../../../../shared/host-availability' imported from .../status.test.ts
Test Files  1 failed (1)   Tests  no tests
```

Task 2 (against the Task 1 tracer implementation):
```
Test Files  2 failed | 1 passed (3)
     Tests  28 failed | 26 passed (54)
```
Failing: orca table (2880 rows), 5 announcement_unreadable, 4 unrecognized_value, 6 evidence_missing, 5 reason
charset, 1 unknown-with-evidence, relay needs-owner-setup, 4 loopback, 1 unparseable endpoint.

Task 3:
```
FAIL host-autostart-probe.test.ts: Cannot find module '../../shared/serve-autostart-status'
FAIL host-availability-wiring.test.ts: 3 failed | 1 passed (expected +0 to be 1; register anchor -1)
```

## GREEN evidence

- Task 1: status.test.ts 7/7 passed. typecheck:node exit 0.
- Task 2: 3 files, 54/54 passed. The matrix reports its row count in the test names: `covers 2880 rows (at least 1000)`.
- Task 3: probe + wiring + serve-autostart + serve-host-relay-wiring: 61 passed, 2 skipped (live leg, env-gated).
- Plan-level (after the lint-staged formatter ran): 7 files, 115 passed, 2 skipped (live leg).

## Gates

| Gate | Result |
|------|--------|
| `pnpm run typecheck:node` | exit 0 |
| `pnpm run typecheck:cli` | exit 0 |
| `pnpm exec tsc --noEmit -p config/tsconfig.tc.web.json` | exit 0 |
| `pnpm run check:recurring-work` | `Recurring-work inventory OK [total=236 ...] debt=0`; debt baseline unchanged |
| `pnpm run check:durability-contracts` | `passed for 21 contract(s) ... no new ones` |
| serve-autostart.test.ts | 35 passed at plan start, 35 passed after; file unmodified (`git diff --quiet` OK) |
| `git diff --stat START..HEAD -- src/shared/terminal-stream-protocol.ts` | empty (D-07: no stream change) |
| `src/shared/host-availability.ts` import lines | 1 (`./protocol-version`) |

## Live leg (read-only Get-ScheduledTask, ORCA_LIVE_AUTOSTART_PROBE=1, this laptop)

```
[live] nonce task -> {"value":"not-configured","reason":"logon_task_absent","evidence":{"kind":"os-probe","observedAt":1793120328943}}
[live] ScheduledDefrag -> {"value":"not-configured","reason":"logon_task_disabled","evidence":{"kind":"os-probe","observedAt":1793120331290}}
```
The positive control (ScheduledDefrag at `\Microsoft\Windows\Defrag\`) read a real, non-unknown state, so the
nonce absence is not a blind reader. No task was created, run or deleted.

## Decision coverage (tests that pin each row)

- D-01 three separate fields, evidence on every non-unknown: `host-availability.test.ts` matrix "never emits a power-loss value and evidences every value".
- D-02 no response is unknown, awake only from a live answer: same matrix (awake iff connected && status), `status.test.ts` "composes no response into unknown".
- D-03 orca rows: `host-availability.test.ts` "matches the orca table in all 2880 rows".
- D-04 capabilities separate from state and DeviceScope: `HostCapabilitySet` is its own type; DeviceScope untouched (diff); `status.test.ts` six ids.
- D-05 capability values and the old-host unknown: `status.test.ts` round-trip and old-host tests, `host-availability-producer.test.ts`, `host-autostart-probe.test.ts`.
- D-07 additive only: optional `RuntimeStatus.hostAvailability`, no stream file change, no new RPC method.
- T-18-02 endpoint never on the wire: producer test "never serializes the endpoint".
- T-18-03 bounded probe: "runs one exec for ten reads inside the max age and none while one is in flight".
- T-18-04 constant script, task name only in env: probe test "starts exactly one constant-script exec with the task name in env".

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Unrecognized window status is not echoed as the serve detail**
- Found during: Task 2
- Issue: the plan says the serve detail is "window status or window_status_absent"; echoing an arbitrary host string would put untrusted text into a phone-rendered detail.
- Fix: recognized window statuses echo, anything else reads `unrecognized_window_status` (the same rule the plan gives non-serve hosts).
- Files: src/shared/host-availability.ts, test table in host-availability.test.ts. Commit 27f354622.

**2. [Rule 3 - Blocking] Probe deps carry `env`, and the probe exposes `settled()`**
- Found during: Task 3
- Issue: execFile replaces the child env, so powershell.exe needs the inherited env (SystemRoot, PATH); tests and the live leg need to await the in-flight read without polling.
- Fix: `HostAutostartProbeDeps.env` (default `process.env`) and `settled(): Promise<void>` beside `read()`.
- Commit b2ae2fa06.

**3. [Rule 3 - Blocking] Lint: `Object.hasOwn` instead of `Object.prototype.hasOwnProperty.call`**
- The pre-commit oxlint (prefer-object-has-own) rejected the first Task 2 GREEN commit; switched and recommitted (27f354622). Web typecheck passes.

## Known Stubs

None. can-wake-lan / can-wake-remote `not-configured no_wake_broker` and can-power-on-oob `unknown oob_not_measured`
are truthful values per D-05 (no broker, no measurement), not stubs.

## Notes

- The repo's lint-staged pre-commit hook backs up state with its own git stash; I ran no git stash.
- No push, no merge, no schtasks /Create, /Run or /Delete, no C:\ox write, no Owner Orca X touched.
- Known pre-existing failures (serve-electron-flag-parity 1/11, desktop-startup-ordering 3) were not run and are not counted.

## Self-Check: PASSED

All 9 created files exist; commits 773100aab, 4177bf3bb, 449a53333, 27f354622, eaee8fc2c, b2ae2fa06 are in `git log`.
