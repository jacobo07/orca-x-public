---
phase: 20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4
plan: 03
subsystem: host-availability
status: complete
tags: [wake-proxy-available, row-k, row-m, oob-power, test-double, import-sweep, unit-unrendered]
requires: [18-01 host-availability vocabulary and parser, 19-03 host.wake-broker.v1 capability string, 20-02 can-power-on-oob verdict]
provides: [src/shared/host-wake-proxy.ts (composeWakeProxyAvailability, planWakeRequest, WAKE_PROXY_UNKNOWN_REASONS), src/main/runtime/oob-power.ts (OobPowerController, OobPowerResult, OobPowerState, OOB_POWER_REFUSAL_CODES, OOB_POWER_RESULT_STAGES), src/main/runtime/oob-power-test-double.ts (createRecordingOobPowerController, tests only)]
affects: [20-04 mutants P20-K1/K2/M1/M2/O2 target these files, deferred mobile Wake control (19 D-13) is the first consumer]
tech-stack:
  added: []
  patterns: [pure composer with an ordered unknown-reason ladder, currency rule shared with the card presenter, test-only double guarded by a whole-src import sweep with positive and station controls]
key-files:
  created:
    - src/shared/host-wake-proxy.ts
    - src/shared/host-wake-proxy.test.ts
    - src/main/runtime/oob-power.ts
    - src/main/runtime/oob-power-test-double.ts
    - src/main/runtime/oob-power.test.ts
  modified:
    - src/shared/host-availability.test.ts
    - .planning/STATE.md
    - .planning/ROADMAP.md
decisions:
  - "20-03: wake-proxy-available is composed only from this session's broker answers: connected with a lastConnectedAt, a current status.get advertising host.wake-broker.v1, a current host.wake.targets reply with at least one {targetId: string, label: string}; evidence live-response at the older of the two answers; UNIT, no UI consumer"
  - "20-03: lastConnectedAt null reads broker_not_connected (stricter than the card presenter, which treats null as current), as the plan specifies"
  - "20-03: OobPowerController is a type alias, not an interface (oxlint consistent-type-definitions); the only implementation is the recording double, which throws when a test outruns its script"
metrics:
  duration: 9min
  completed: 2026-10-28
plan_head_before: f1f7c5794248a375b30d56f00ca62b0c71cb9571
actuals:
  tokens: 5179
  tasks: 2
  commits: 4
---

# Phase 20 Plan 03: wake-proxy-available composer and the OOB power contract Summary

The phone side can now say `wake-proxy-available`, but only when the broker answered in this session: it is
connected, its current `status.get` advertises `host.wake-broker.v1`, and its current `host.wake.targets` reply holds
at least one well-formed target. Every other case is `unknown` with one of seven named reasons, and `planWakeRequest`
then refuses to send, giving the same reason. Row K (broker offline) and row M (old broker) are pinned with positive
controls. The composer has no UI consumer: it is a UNIT, wired but unrendered, until the deferred mobile Wake control
(19 D-13) uses it. The generic OOB power interface exists as types only. Its one implementation is a recording double
that only tests import, and a sweep over all of `src` proves that.

## Tasks

| Task | Commits | Files |
|------|---------|-------|
| 1 (tracer) wake-proxy composer, rows K and M, old-client pin | 20558a7a9 RED, 0dc47e747 GREEN | src/shared/host-wake-proxy.ts, host-wake-proxy.test.ts, host-availability.test.ts |
| 2 OOB contract, test-only double, import sweep | 09c082a38 RED, 40ae8309c GREEN | src/main/runtime/oob-power.ts, oob-power-test-double.ts, oob-power.test.ts |

## RED evidence

Task 1 (`host-wake-proxy.test.ts`):
```
FAIL  src/shared/host-wake-proxy.test.ts
Error: Cannot find module './host-wake-proxy' imported from C:/owx-haf/src/shared/host-wake-proxy.test.ts
Test Files  1 failed | 1 passed (2)
     Tests  28 passed (28)
```
The additive pin rows in `host-availability.test.ts` passed on their first run, both of them: the six phase 18 ids
plus the phase 20-shaped announcement, and an extra unknown id that gets ignored. That is expected, because the parser
already ignores unknown ids. Their failing proof is mutant P20-M2 in 20-04. `host-availability.ts` was not changed.

Task 2 (`oob-power.test.ts`):
```
FAIL  src/main/runtime/oob-power.test.ts
Error: Cannot find module './oob-power' imported from C:/owx-haf/src/main/runtime/oob-power.test.ts
Test Files  1 failed (1)
     Tests  no tests
```

## Composer table (17 rows)

Two positive controls. In the first, status is at T0+1 and targets at T0+2, so the evidence is at T0+1. In the second,
targets arrive exactly at the connect instant, and one malformed entry sits beside a granted one, so the evidence is at
T0. The other rows:

- **Row K:** the broker is disconnected; the broker never connected; or both. Each reads `broker_not_connected`.
- **Status:** absent or stale reads `no_status_this_session`. A string result, a null result, or a capabilities field
  that is not an array reads `status_unreadable`.
- **Row M:** an old broker without `host.wake-broker.v1`, or an empty capabilities list, reads `broker_not_announced`.
- **Targets:** absent or stale reads `no_targets_this_session`. Targets that are not an array read
  `targets_unreadable`. An empty list, or a list of only malformed entries, reads `no_granted_target`.

Across the whole table, the test checks that:

- only rows named `positive control` yield wake-proxy-available;
- every unknown reason is in `WAKE_PROXY_UNKNOWN_REASONS` and matches `/^[a-z0-9_]{1,64}$/`;
- no serialized output carries `powered-off`, `woken`, `host-announced` or `awake`;
- every unknown plans `{ send: false, reason }`;
- each of the seven reasons is reached;
- `composeWakeProgress(undefined, null)` returns `[]`.

## Import sweep

```
✓ walks the whole src tree (station control: 14355 files)
✓ sees an import of the double in its own test file (positive control)       -> main/runtime/oob-power.test.ts
✓ finds no non-test file that references the double                          -> []
✓ finds the contract named only by its declaration and the double            -> [oob-power-test-double.ts, oob-power.ts]
✓ registers nothing OOB in the main entry
```
The walk resolves `src` from the test file's `__dirname`. `Select-String src/main/index.ts 'oob-power'` returns 0
lines. Nothing is exported from a barrel, and nothing is registered in index.ts.

## Verification

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --config config/vitest.config.ts src/shared/host-wake-proxy.test.ts src/shared/host-availability.test.ts src/shared/host-wake.test.ts` | Test Files 3 passed (3), Tests 55 passed (55) |
| `pnpm exec vitest run --config config/vitest.config.ts src/main/runtime/oob-power.test.ts` | Test Files 1 passed (1), Tests 8 passed (8) |
| `pnpm run typecheck:node` | exit 0 (after each GREEN and at the end) |
| `pnpm exec tsc --noEmit -p config/tsconfig.tc.web.json` | exit 0 |
| `pnpm run typecheck:cli` | exit 0 |
| `git diff --quiet f1f7c5794 HEAD -- mobile src/shared/host-availability.ts src/main/index.ts` | exit 0 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `OobPowerController` declared as a type alias, not an `interface`**
- **Found during:** Task 2 GREEN commit
- **Issue:** the pre-commit oxlint rule `typescript(consistent-type-definitions)` rejected `interface`, so the commit
  did not land.
- **Fix:** I changed it to `export type OobPowerController = { ... }`, which has the same shape and the same
  assignability. The double still satisfies it through a typed variable.
- **Files modified:** src/main/runtime/oob-power.ts
- **Commit:** 40ae8309c

**2. [Plan detail] The double throws when its script runs out**
- The plan did not say what happens when the script is exhausted. I chose to throw an Error rather than invent a
  default result or state, so a test that outruns its script fails loudly. A test pins this.

### Index hygiene

The lint-staged pre-commit hook rewrote line endings and formatting after three of the four commits, which left a
stale index. Each time, I confirmed that the tree equals HEAD (`--ignore-cr-at-eol`), then reset the index for those
files only. One file that differed only in line endings (`oob-power-test-double.ts`) was restored from HEAD. `diff
--cached --quiet` reads 0 after every commit.

## Known Stubs

None. `oob-power-test-double.ts` is a test double by design, and the sweep proves that only tests import it.
`wake-proxy-available` has no UI consumer and is recorded as UNIT / WIRED-BUT-UNRENDERED, not as a stub. Its
consumer, the mobile Wake control, is deferred under 19 D-13.

## Threat Flags

None. There is no new network endpoint, IPC channel, file write or registration. Both modules are pure, or contain
only types.

## Self-Check: PASSED

- FOUND: src/shared/host-wake-proxy.ts, src/shared/host-wake-proxy.test.ts, src/main/runtime/oob-power.ts,
  src/main/runtime/oob-power-test-double.ts, src/main/runtime/oob-power.test.ts
- FOUND commits: 20558a7a9, 0dc47e747, 09c082a38, 40ae8309c (`git log --oneline -5`)
