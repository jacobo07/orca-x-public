---
phase: 17-host-service-and-orca-closed-availability-m1
plan: 01
subsystem: main/runtime/relay, main/server
status: complete
tags: [relay, serve, headless, readiness, tdd]
requires: []
provides:
  - "createHostRelayOwner(): the one relay-startup owner for serve and desktop"
  - "ServeReadiness.appVersion + ServeReadiness.relay"
affects: [17-02, 17-03, 18]
tech-stack:
  added: []
  patterns: ["memoized per-process owner with a test seam (createService)", "structural wiring test over index.ts with bounded, CRLF-tolerant anchors"]
key-files:
  created:
    - src/main/runtime/relay/host-relay-startup.ts
    - src/main/runtime/relay/host-relay-startup.test.ts
    - src/main/startup/serve-host-relay-wiring.test.ts
  modified:
    - src/main/index.ts
    - src/main/runtime/relay/desktop-relay-service.ts
    - src/main/server/serve-readiness.ts
    - src/main/server/serve-readiness.test.ts
    - src/main/startup/desktop-startup-ordering.test.ts
decisions:
  - "Relay readiness status is null until the broker emits one; the index.ts 'offline' default never feeds readiness"
  - "Serve starts the relay right after settleServeDesktopActivation/installServeSignalHandlers, i.e. after RPC is up and before printServeReady"
  - "Resume listener calls the owner's service directly (same object the module var holds)"
metrics:
  duration: "~45 min"
  completed: 2026-10-27
actuals:
  tokens: 7000
  tasks: 3
  commits: 4
plan_head_before: c9525e85f5567a9e154fd8188a7e2660a846b3a4
---

# Phase 17 Plan 01: Relay in serve through one owner, readiness carries version and relay

`orca serve` now starts the cloud relay through `createHostRelayOwner()`, the single module that also starts it
for the desktop path. Serve readiness reports `appVersion` and a truthful `relay` (`started` with the
broker-emitted status or null, or `unavailable` with a named reason).

## Commits (RED precedes each fix)

| Order | Hash | Message |
|-------|------|---------|
| 1 | 860b79cfc | test(17-01): RED serve branch never reaches relay startup |
| 2 | 4ec283297 | feat(17-01): one host relay owner started by serve and desktop |
| 3 | acd4eb82a | test(17-01): RED serve readiness lacks appVersion and relay |
| 4 | 4d172ea77 | feat(17-01): serve readiness reports appVersion and relay |

## TDD Gate Compliance

**Task 1 RED** (pre-fix tree c9525e85f, `serve-host-relay-wiring.test.ts`), all four failing for the intended reason:
```
AssertionError: expected 'if (serveOptions) {\r\n    // Why: gi…' to contain 'hostRelayOwner.start('      (A)
AssertionError: expected +0 to be 2 // Object.is equality                                           (B)
Error: ENOENT: no such file or directory, open '...\src\main\runtime\relay\host-relay-startup.ts'   (C)
AssertionError: expected 'if (serveOptions) {\r\n    // Why: gi…' to contain 'desktopRelayService = serveHostRelay.…'  (D)
exit=1
```
**Task 1 GREEN:** wiring + owner + serve-desktop-activation-wiring + desktop-relay-service tests: `PASS (18) FAIL (0)`, exit 0.

**Task 2 RED** (`serve-readiness.test.ts` before the implementation): `PASS (7) FAIL (4)`: json contract lacks the
new keys, `appVersion` undefined, `relay` undefined, human output lacks the Version line. The recipe-json
byte-identity case passed in RED, as it must (that contract is unchanged).
**Task 2 GREEN:** serve-readiness + wiring + owner + activation wiring: `PASS (24) FAIL (0)`, exit 0.

## Task 3 gates

```
pnpm run typecheck:node            -> exit 0 (tsc --noEmit -p config/tsconfig.node.json, no errors)
pnpm run check:recurring-work      -> Recurring-work inventory OK [total=236 interval=48 watcher=8 self-rescheduling-timeout=102 worker=13 helper=36 self-rescheduling-frame=29] debt=0
pnpm run check:durability-contracts-> Durability contract check passed for 21 contract(s); ... no new ones.
vitest src/cli/serve-electron-flag-parity.test.ts -> PASS (10) FAIL (1): pre-existing, identical on c9525e85f (see Deferred Issues)
```
No change to `config/recurring-work-debt-baseline.txt`, `config/durability-unclassified-baseline.txt` or the
recurring-work inventory (the owner adds no timer; the relay's own timers stay classified per-process).

## Acceptance criteria

- `new DesktopRelayService(`: 0 in index.ts, 1 in host-relay-startup.ts (test C).
- `hostRelayOwner.start(`: exactly 2 in index.ts, desktop one after the serve `return` (test B).
- host-relay-startup.ts imports nothing from 'electron' (only a type import of getOrcaCloudAuthConfig; powerMonitor stays in index.ts).
- Both branches assign `desktopRelayService`, so the quit (`fenceAndCloseNow`), relaunch and sign-out fences reach the serve-started service (test D, D-03).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pre-commit oxlint rejected index.ts on an untouched line**
- **Found during:** Task 1 commit
- **Issue:** `unicorn(no-useless-spread)` at the fleet-observation `readNodeResources({...(cond ? {...} : {})})` (present at HEAD); lint-staged lints the whole file, so no index.ts commit could land.
- **Fix:** pass the conditional object directly; same value, same new-object semantics.
- **Commit:** 4ec283297

**2. [Rule 1 - Bug] RED test anchor assumed LF**
- **Found during:** Task 1 RED run
- **Issue:** index.ts is checked out CRLF, so `indexOf('return\n')` returned -1 and test B failed for the wrong reason.
- **Fix:** CRLF-tolerant regex for the serve `return` anchor; re-ran RED so B fails on its real assertion (`expected +0 to be 2`).
- **Commit:** 860b79cfc

**3. [Rule 3 - Blocking] Existing ordering test anchored on the exact `await printServeReady(serveOptions)` text**
- **Found during:** Task 2
- **Fix:** desktop-startup-ordering.test.ts now matches the call by prefix `await printServeReady(serveOptions` (still unique). The existing human-output test now expects the plan's `Version:` line after the header.
- **Commit:** 4d172ea77

**4. Commit message repair:** an RTK output rewrite injected a literal `[6 more lines]` into the Task 1 message; amended (message only, `--no-verify`, the tree had already passed the hook) before any later commit.

### Process notes
- The PowerShell tool was not available to this executor; shell work ran through Bash with the guard's audited `# bash-safe` marker, outputs captured to files.
- The repo's lint-staged pre-commit hook backs up state via `git stash` internally; no executor-initiated stash was used.

## Deferred Issues

Pre-existing failures, identical on the pre-plan tree c9525e85f (logged in `deferred-items.md`):
- desktop-startup-ordering.test.ts: 3 tests with a stale `Promise.resolve(desktopWindow ?? openMainWindow())` anchor.
- serve-electron-flag-parity.test.ts: getServeOptions does not read `'--serve-bind-host'`.

## Known Stubs

None. Relay status is never synthesized: null until the broker reports.

## Threat Flags

None beyond the plan's register. T-17-01/03/04/05 are covered by owner tests 1, 2, 4, 5, wiring tests B and D and
the relay-key subset assertion; T-17-02 adds no auth path (same service, keypair and device registry).

## Self-Check: PASSED

All three created files exist; commits 860b79cfc, 4ec283297, acd4eb82a, 4d172ea77 resolve. State note: `state.advance-plan` returned plan_position_unreadable (STATE.md position block still describes phase 10); metric, decision, session and ROADMAP progress were recorded. P17-SC1/P17-SC2 are not rows in REQUIREMENTS.md, so mark-complete changed nothing.
