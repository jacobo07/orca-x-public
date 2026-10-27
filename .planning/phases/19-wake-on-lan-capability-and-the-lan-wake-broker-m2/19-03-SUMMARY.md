---
phase: 19-wake-on-lan-capability-and-the-lan-wake-broker-m2
plan: 03
subsystem: host-availability
status: complete
tags: [wake-on-lan, wake-broker, serve, cli, rpc, device-authority, mobile-allowlist]
requires: [19-01 WOL probe, 19-02 broker core (wakeBrokerHost, createWakeBroker, loadWakeBrokerStore, sendMagicPacketUdp, host.wake.* methods)]
provides: [startWakeBroker, dropWakeGrantsAfterRevoke, --wake-broker / --serve-wake-broker flag chain, host.wake-broker.v1 in status.get while enabled, live device authority from runtime-rpc, phone wake methods on MOBILE_RPC_METHOD_ALLOWLIST]
affects: [src/main/index.ts, src/main/runtime/runtime-rpc.ts, src/main/runtime/orca-runtime.ts, src/cli/specs/serve.ts, src/main/startup/serve-mode-argv.ts]
tech-stack:
  added: []
  patterns: [explicit serve-only role behind a flag, live authority closure over the server's current registry, purge after revoke as housekeeping with safety re-derived at the effect]
key-files:
  created:
    - src/main/runtime/wake-broker-host.test.ts
    - src/main/startup/wake-broker-wiring.test.ts
    - src/main/runtime/wake-broker-revoke-in-process.test.ts
  modified:
    - src/main/runtime/wake-broker-host.ts
    - src/main/index.ts
    - src/main/runtime/orca-runtime.ts
    - src/main/runtime/runtime-rpc.ts
    - src/main/runtime/mobile-rpc-allowlist.test.ts
    - src/cli/args.ts
    - src/cli/specs/serve.ts
    - src/cli/handlers/core.ts
    - src/cli/runtime/launch.ts
    - src/main/startup/serve-mode-argv.ts
decisions:
  - "19-03: the device authority is a live closure over runtime-rpc's current deviceRegistry, attached once after a successful registry; a later lost registry refuses (registry_unavailable), never judges by a stale one"
  - "19-03: deviceExists treats an absent or unavailable registry as 'exists', so the start-time prune never drops grants on unknown (UNKNOWN is never absent)"
  - "19-03: the serve wake line goes to stdout in human mode and to stderr under --serve-json / --serve-recipe-json, so machine-readable stdout is unchanged"
  - "19-03: getServeOptions names '--serve-bind-host' at its call site (readServeBindHostArg gained a defaulted flag parameter); this repaired a parity-test failure present since d9cd43d1f without editing the test"
metrics:
  duration: 23min
  completed: 2026-10-27
plan_head_before: 8274ed49e8d7a0e8b2b0a126814d7ea79afa63f5
actuals:
  tokens: 8200
  tasks: 3
  commits: 6
---

# Phase 19 Plan 03: Serve-only LAN Wake Broker integration Summary

The broker now starts only when the Owner runs `orca serve --wake-broker` (or `<binary> serve --wake-broker`). The flag reaches `getServeOptions` as `wakeBroker: true`. The serve branch then calls `startWakeBroker(getCanonicalUserDataPath())`, which is the same userData path the runtime RPC server uses. Without the flag no broker exists and every `host.wake.*` call refuses with `wake_broker_disabled`. The desktop path never starts one.

`status.get` advertises `host.wake-broker.v1` only while a broker is enabled. An unreadable state file fails closed: the broker is marked unavailable, requests refuse with `wake_broker_unavailable`, the capability is not advertised, and the corrupt bytes are preserved.

runtime-rpc.ts attaches a live device authority built on `assertDeviceStillAuthorized`. A successful `revokeMobileDevice`/`revokeRuntimeAccess`, and a discarded pending pairing, each drop that device's grants. A phone reaches exactly `host.wake.targets`, `host.wake.request` and `host.wake.status`.

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 (tracer) | Serve-only `startWakeBroker` and the `host.wake-broker.v1` capability | bc4260771 | baed0bdd0 |
| 2 | `orca serve --wake-broker` through the CLI and the direct-launch rewrite | 920f683da | 379850861 |
| 3 | Device authority, revoke and discard purge, mobile allowlist, in-process revoked refusal | a3d0d6c21 | 9a8b9c4f1 |

## Verification (observed on this laptop, 2026-10-27)

### RED lines

- **Task 1:** `Test Files 2 failed (2)`, `Tests 8 failed | 1 passed (9)`. Every host test failed with `TypeError: startWakeBroker is not a function`. The wiring test failed on the missing `wakeBroker: argv.includes('--serve-wake-broker')`, on `startWakeBroker(` count `expected +0 to be 1`, and on the getStatus capability. The one test that passed was the desktop-negative check.
- **Task 2:** the parity test went from 11 to 12 cases, `Tests 2 failed | 10 passed (12)`.
  - The new `--wake-broker` rewrite case failed: the flag was not boolean and not translated.
  - The other failure was the pre-existing `'--serve-bind-host'` source-text check (see Deviation 1).
- **Task 3:** `Test Files 4 failed | 1 passed (5)`, `Tests 10 failed | 17 passed (27)`.
  - The allowlist was missing the 3 names.
  - `dropWakeGrantsAfterRevoke is not a function` (3 tests).
  - The in-process positive control got `ok: false`: the method was not yet allowlisted, and WS auth and broker start had both succeeded.
  - 5 wiring assertions failed: attach count 0, purge counts 0 and 0, total purge 0, and the allowlist.

### GREEN and gates

- **Task 1 verify** (wake-broker-host, wake-broker-wiring, host-wake): `Test Files 3 passed (3)`, `Tests 21 passed (21)`. `typecheck:node` TC_EXIT=0.
  - The tracer gate re-ran the same verify after the lint-staged format: `Tests 21 passed (21)`, VITEST_EXIT=0. "Tracer verified end-to-end — expanding."
- **Task 2 verify:**
  - parity + serve-mode-argv: `Test Files 2 passed (2)`, `Tests 30 passed (30)`.
  - TC_CLI_EXIT=0, TC_NODE_EXIT=0.
  - `git diff --quiet HEAD -- src/cli/serve-electron-flag-parity.test.ts` EXIT=0.
  - Parity count is 11 before and 12 after, which is +1: the one `it.each` case for `wake-broker`. The "emits the same --serve-* names" leg now also checks `'--serve-wake-broker'` in launch.ts and getServeOptions.
- **Task 3 verify** (5 files): `Test Files 5 passed (5)`, `Tests 27 passed (27)`. TC_NODE_EXIT=0. `Recurring-work inventory OK [total=236 interval=48 watcher=8 self-rescheduling-timeout=102 worker=13 helper=36 self-rescheduling-frame=29] debt=0`, unchanged from 19-02.
- **Plan verification block**, run on the final tree after the last commit:
  - 8 files (the plan's 6 + wake-broker-revoke-in-process + effect-class-registry): `Test Files 8 passed (8)`, `Tests 60 passed (60)`.
  - Parity alone: `Tests 12 passed (12)`.
  - Neighbours (serve-mode-argv, host-availability-wiring, the phase 3 runtime-rpc-mobile-reconnect-revocation, wake-broker, wake-broker-store): `Test Files 5 passed (5)`, `Tests 47 passed (47)`.
  - TC_NODE_EXIT=0, TC_CLI_EXIT=0, `tsc --noEmit -p config/tsconfig.tc.web.json` EXIT=0.
  - `check:recurring-work` EXIT=0 (debt=0).
  - `check:durability-contracts`: `Durability contract check passed for 22 contract(s); 19 grandfathered durability publisher(s); 38 grandfathered direct state writer(s); 2 grandfathered durable-primitive delegate(s); 4 grandfathered durable publisher caller(s); no new ones.` EXIT=0.
  - `git diff --quiet 8274ed49e -- src/cli/serve-electron-flag-parity.test.ts src/main/runtime/rpc/effect-class-registry.test.ts` EXIT=0: both protected tests are unmodified and green.
  - `Select-String -Path src/main/runtime/rpc/methods/*.ts -Pattern 'revokeMobileDevice|revokeRuntimeAccess'`: 0 hits. No revoke RPC was added.

### In-process revoked-device leg

Labelled "UNIT in-process (real RuntimeRpcServer)". Source: `src/main/runtime/wake-broker-revoke-in-process.test.ts`.

**Setup**
- A real `OrcaRuntimeRpcServer` runs on a tmp userData with WebSocket on port 0.
- Pairing is mobile-scope. The device token is taken from the pairing offer.
- The target is broadcast `127.0.0.1` at the port of a `dgram` udp4 listener bound to `127.0.0.1:0`.
- The grant is seeded through `loadWakeBrokerStore`. The broker runs from `startWakeBroker(tmp)` with the real `sendMagicPacketUdp`.

**Positive control** (over the authenticated E2EE WebSocket):
- `host.wake.request` returns `ok: true` with stages `requested, authorized, packet-sent`.
- The listener holds **exactly 1 frame of 102 bytes**.

**Revoke and refusals**
1. `revokeMobileDevice(deviceId)` resolves `true`. `terminateDeviceConnections` is stubbed to 0, as in phase 3, so the socket stays open.
2. The in-flight window: dispatching through `server['dispatcher'].dispatchStreaming` with that device's ctx (clientId = token, pairedDeviceId, clientKind `mobile`) maps to `error.code: 'wake_device_revoked'`. `error.data` does not contain `device_revoked`.
3. The same request over the authenticated WebSocket entry is refused at dispatch with `unauthorized` and `data.reason: 'device_revoked'`.

**After the revoke**
- After a bounded 1500 ms wait, the listener count is **still 1**. Counts: 1 before the revoke, 1 after.
- The broker store holds no grant for the device, in memory and reloaded from disk (`grants() == []`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The protected parity test was already red before this plan**
- **Found during:** Task 2, baseline run before any edit.
- **Issue:** `src/cli/serve-electron-flag-parity.test.ts` failed `emits the same --serve-* names …` with `expected 'function getServeOptions(…' to contain '--serve-bind-host'` at 8274ed49e. The cause: since d9cd43d1f (2026-09-29), `getServeOptions` reads bind-host through `readServeBindHostArg(argv)`, which keeps the literal inside serve-mode-argv.ts. The law requires this test to stay unmodified and green.
- **Fix:** `readServeBindHostArg(argv, flag = '--serve-bind-host')`, and `getServeOptions` now calls `readServeBindHostArg(argv, '--serve-bind-host')`, so the main process names every switch it reads at its own call site. Behaviour is unchanged: serve-mode-argv.test.ts passes. The test file was not edited.
- **Files modified:** src/main/startup/serve-mode-argv.ts, src/main/index.ts
- **Commit:** 379850861

**2. [Rule 2 - Correctness] The start-time prune cannot crash serve startup**
- **Found during:** Task 1
- **Issue:** `pruneGrants` publishes, and a publish error would have thrown out of `startWakeBroker` into the serve start path.
- **Fix:**
  - The prune is wrapped. The removal already applied in memory, because the store removes memory-first. The failure is logged as `[wake-broker] grant prune not persisted: <code>`.
  - The broker stays enabled without the pruned grant.
  - Covered by `still enables, without the pruned grant, when the prune cannot be persisted`, which was added in the Task 1 GREEN commit rather than a RED commit.
- **Commit:** baed0bdd0

**3. [Rule 2 - Correctness] The authority reads the server's current registry**
- **Found during:** Task 3
- **Issue:** The plan attaches the authority "right after a successful `new DeviceRegistry`". `initializePairingIdentity` can build a registry that `start()` then discards when the E2EE key fails, and a later `start()` can replace it.
- **Fix:**
  - The attach sits where `start()` sets `this.deviceRegistry`, still after `new DeviceRegistry(` in the file, and the closure reads `this.deviceRegistry` at each call. A missing registry refuses with `registry_unavailable`.
  - `deviceExists` keeps the grant when the registry is absent or unavailable.
  - A registry that never initialized attaches nothing, so requests refuse with `wake_broker_unavailable`.
- **Commit:** 9a8b9c4f1

**4. [Rule 2 - Interface] `startWakeBroker` takes an optional `publish`**
- **Issue:** The deps argument carries `publish` (passed to `loadWakeBrokerStore`) as well as `sendMagicPacket`. Without it, the failed-purge test and the failed-prune test would need a filesystem trick.
- **Fix:** Production passes no deps.

**5. Interface note**
- `newWakeId` uses 19-02's exported `mintWakeId()` (`wk_` + 16 hex) instead of the plan's 12-hex inline form. One minting function, and well within the 64-char status param.

**6. Scope note: what the runtime-rpc.ts diff contains**
- The import, the attach call, the two purge calls and three allowlist lines.
- `revokeAndTerminate` was also restructured from a single `return (a && b)` into `const revoked = …; if (revoked) {…}; return revoked`. A purge "only on success" cannot be expressed in the old shape.

### Notes
- The `[serve] wake broker: enabled (N targets)` / `unavailable (<reason>)` line prints no MAC. It goes to stderr under `--serve-json` and `--serve-recipe-json`, so their stdout is unchanged.
- A revoke whose registry save throws (memory revoked, error propagates) skips the purge. That device is still refused at the effect because `validateToken` no longer finds it. The purge is housekeeping, not the safety mechanism (D-10).
- The gsd `state.advance-plan` / `update-progress` commands are not used on this STATE.md format. Current Position was edited by hand.
- lint-staged ran on every commit (its own internal backup). Three commits left a stale pre-format index; each was reset per the post-commit check, and the final check was `cached=0 tree=0` every time.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model:
- T-19-13 is pinned by the wiring test: exactly one guarded `startWakeBroker(` in the serve branch, and none on the desktop path.
- T-19-14 is pinned by the allowlist test (no `host.wake.admin.` name) and the wiring test.
- T-19-15 is pinned by the purge tests, the failed-purge refusal, and the in-process leg.
- T-19-16: the serve line prints state and count only.
- T-19-17: the unmodified parity test covers `wake-broker`.

## Self-Check: PASSED

- All 3 created files exist, and all 10 modified files are in `git diff --stat 8274ed49e HEAD` (13 files, 654 insertions, 13 deletions).
- All 6 commits are on `mobile/host-availability`: bc4260771, baed0bdd0, 920f683da, 379850861, a3d0d6c21, 9a8b9c4f1.
- `git rev-list --count 8274ed49e..HEAD` = 6.
- `actuals.tokens` is estimated as about 654 changed lines × about 50 chars / 4.
