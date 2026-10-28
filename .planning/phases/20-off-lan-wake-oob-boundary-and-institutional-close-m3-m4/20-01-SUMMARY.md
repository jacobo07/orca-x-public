---
phase: 20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4
plan: 01
subsystem: host-availability
status: complete
tags: [wake-broker, relay, transport-independence, row-L, mutants, unit-in-process-relay]
requires: [19-02 broker core, 19-03 serve-only broker and device authority, 19-05 mutant protocol]
provides: [wake-broker-relay-test-harness.ts (startRelayWakeHarness), relay/loopback-relay-cell.ts, wake-broker-relay-dispatch.test.ts (9 rows), 20-01-MUTANTS.md (P20-L1, P20-L2)]
affects: [.planning/STATE.md, .planning/ROADMAP.md]
tech-stack:
  added: []
  patterns: [loopback relay cell splicing host data leg to phone leg by connId, handshake outcome with cause as a station control for a negative readiness row, restore-by-byte-copy mutant drill]
key-files:
  created:
    - src/main/runtime/wake-broker-relay-test-harness.ts
    - src/main/runtime/relay/loopback-relay-cell.ts
    - src/main/runtime/wake-broker-relay-dispatch.test.ts
    - .planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-01-MUTANTS.md
  modified:
    - .planning/STATE.md
    - .planning/ROADMAP.md
decisions:
  - "20-01: relay test devices come from DeviceRegistry.addDevice, because createPairingOffer coalesces every unscanned mobile offer onto one pending device (two phones would share one deviceId)"
  - "20-01: the relay phone's 2000 ms ready bound starts at socket open, and the connect is bounded separately by ws handshakeTimeout; the harness reports a handshake cause so a refused binding (e2ee_error) is told apart from a timeout"
  - "20-01: no production code changed; transport independence holds by construction (RpcContext carries no transport field) and is now pinned over real relay frames, with P20-L1/L2 CAUGHT"
metrics:
  duration: 35min
  completed: 2026-10-28
plan_head_before: 608a536faead7c70ecd0c4ca38cc0fa23977f0a0
actuals:
  tokens: 7388
  tasks: 3
  commits: 4
---

# Phase 20 Plan 01: Relay-delivered wake proof (UNIT in-process relay) Summary

A `host.wake.request` from a simulated E2EE v2 phone travels through a loopback relay cell and a real
`CloudRelayTransport` into the server's own `MobileSocketWiring`, the same attach `DesktopRelayService` uses. It
reaches the broker effect on a real `OrcaRuntimeRpcServer` and sends exactly one 102-byte magic packet to a loopback
listener. Over the relay it meets the direct path's dedupe and refusal codes. Mutants P20-L1 and P20-L2 are CAUGHT and
RESTORE_VERIFIED.

**Label: UNIT in-process relay.** This is not M3. The live leg (phone on 5G, real relay, LAN broker, target wakes)
stays OWNER_BOUND and is written up in 20-05 (D-03). Nothing left 127.0.0.1: the cell binds 127.0.0.1, the target
broadcast is 127.0.0.1, and the MAC is the fictitious locally administered `02:00:5e:20:00:01`. No real relay or cloud
was contacted.

## Tasks

| Task | Name | Commit | Files |
|---|---|---|---|
| 1 RED | relay-delivered wake reaches the broker effect | 8f71fa8d2 | wake-broker-relay-dispatch.test.ts |
| 1 GREEN | relay wake harness on a real server via a loopback relay cell | 2878d23c1 | wake-broker-relay-test-harness.ts, relay/loopback-relay-cell.ts |
| 2 | row L and transport independence over real relay frames | 489b4f555 | wake-broker-relay-dispatch.test.ts, wake-broker-relay-test-harness.ts |
| 3 | P20-L1 and P20-L2 mutant drills | aaaf0edb2 | 20-01-MUTANTS.md |

### Task 1 (tracer)

RED failure line (8f71fa8d2):
`Error: Cannot find module './wake-broker-relay-test-harness' imported from C:/owx-haf/src/main/runtime/wake-broker-relay-dispatch.test.ts`
(`Test Files 1 failed (1)`, `Tests no tests`).

GREEN (2878d23c1): `Test Files 1 passed (1)`, `Tests 1 passed (1)`. The tracer passed on the first GREEN run: ready
true; stages exactly `requested, authorized, packet-sent`; after the 1500 ms settle exactly 1 frame of 102 bytes, with
bytes 0-5 `0xff` and every 6-byte block equal to the harness MAC. `cellUpgradePaths` contains
`/v1/host/data/relay-conn-1` (the host dialed the cell) and `/v1/connect/<relayHostId>` (the phone dialed the cell).
The wiring's `connectionCount` is 1, so the only mobile socket the server saw arrived over the relay. No test step
connects to the server's own WebSocket port.

Tracer gate (interactive, end-of-phase, automated-only verify): re-run green, so execution continued.
`Select-String ... -Pattern "from 'vitest'"` on the harness returns 0 matches. `git diff --name-only
8f71fa8d2^..2878d23c1 -- src` lists `relay/loopback-relay-cell.ts`, `wake-broker-relay-dispatch.test.ts` and
`wake-broker-relay-test-harness.ts`. All three are new test-infrastructure modules; there is no production change
(the third file is the split, see Deviations).

### Task 2 (rows)

9 `it(` rows (acceptance requires 8 or more):

1. tracer
2. replay: same wakeId, `replayed: true`, +0 frames
3. status ends at `packet-sent`; `host.wake.targets` lists exactly `[{ targetId, label }]`; the MAC-shape regex
   `/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i` matches `harness.targetMac` (positive control) and no reply
4. ungranted phone-b: `wake_grant_missing`, targets `[]`, 0 frames
5. phone-b's `host.wake.status` on phone-a's wake: `wake_unknown`
6. `host.wake.admin.targetList`: `forbidden`, 0 frames
7. a relay leg bound to phone-b presenting phone-a's token: ready false, and the handshake ends in `e2ee-authenticated`
   with cause `e2ee_error` (the server judged and refused the binding), 0 frames
8. positive control: matching bindings are ready with cause `authenticated`
9. revoke inside the dispatch window (`terminateDeviceConnections` spied to 0, `dispatchStreaming` spied to revoke
   for `relay-req-revoke` only): `revokeMobileDevice` true, the reply is `wake_device_revoked` and its data has no
   `device_revoked`; the next relay frame `relay-req-after` gets `unauthorized` with `data.reason: device_revoked`;
   frames stay at 1; the grant is gone in memory and on disk

Verify, the three files (relay + `wake-broker-revoke-in-process.test.ts` + `rpc/methods/host-wake.test.ts`):
`Test Files 3 passed (3)`, `Tests 21 passed (21)`, twice in a row after the harness fix; `pnpm run typecheck:node`
exit 0; oxlint exit 0 on the three new files. `git diff --quiet HEAD -- src/main/runtime/wake-broker.ts
src/main/runtime/rpc/mobile-socket-wiring.ts src/main/runtime/runtime-rpc.ts` exit 0.

First-run outcome: every behaviour row passed on its first run. As the plan expected, the behaviour already existed,
and the failing proof for each refusal is Task 3. The first 3-file run had 1 failure: row 8 (the positive control),
whose ready resolved false under parallel-worker load. That was a harness timing defect, not a product finding; see
Deviations. No row was weakened. Row 7 was strengthened instead.

### Task 3 (mutants)

The full table is in `20-01-MUTANTS.md`.

- **P20-L1** (wake-broker.ts:137, effect-time authority forced ok) is CAUGHT by row 9 at `:251` (received
  `wake_grant_missing`, expected `wake_device_revoked`), with `Tests 1 failed | 8 passed (9)`. RESTORE_VERIFIED: sha256
  `A3617A94...FE53` equal before and after, diff-quiet 0, rerun 9/9.
- **P20-L2** (mobile-socket-wiring.ts:165, relay binding skipped) is CAUGHT by row 7 at `:196`
  (`expected true to be false`: ready). RESTORE_VERIFIED: sha256 `88405E14...4C59` equal, diff-quiet 0, rerun 9/9.

There were no driver defects. Both drivers live in the job tmp directory. The `WakeCaller` type is quoted in the
MUTANTS file (`{ token: string | undefined; deviceId: string | undefined }`, wake-broker.ts:67), which answers
plan-check info 2. Final `git diff --quiet -- src/main/runtime/wake-broker.ts src/main/runtime/rpc/mobile-socket-wiring.ts`:
exit 0.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Devices from `DeviceRegistry.addDevice`, not `createPairingOffer`**
- **Found during:** Task 1, while reading the code before GREEN
- **Issue:** `createPairingOffer({ scope: 'mobile' })` calls `getOrCreatePendingDevice`, which returns the existing
  unscanned mobile device (`device-registry.ts:117-136`). Two calls would have given phone-a and phone-b the same
  deviceId, so the ungranted and binding rows would have been meaningless. `rotate: true` drops the earlier pending
  entry instead.
- **Fix:** the harness calls the server's real registry (`server.getDeviceRegistry().addDevice(name, 'mobile')`),
  the same call the relay E2EE integration test makes. The authority, revoke and grant purge are unchanged.
- **Files:** wake-broker-relay-test-harness.ts. **Commit:** 2878d23c1

**2. [Rule 3 - Blocking] Harness split to stay under max-lines 300**
- **Found during:** Task 1. After `oxfmt`, the harness counted 302 lines (`eslint(max-lines)` error).
- **Fix:** the loopback relay cell moved to `src/main/runtime/relay/loopback-relay-cell.ts`
  (`startLoopbackRelayCell`, `parseJsonObject`), which the plan allows ("split a concretely named second module only
  if needed"). There is no max-lines disable. As a result, Task 1's diff names three new files, all test
  infrastructure.
- **Commit:** 2878d23c1

**3. [Rule 1 - Bug, harness] The ready bound counted the TCP connect; the negative row had no station control**
- **Found during:** Task 2, first 3-file run. Row 8 (positive control) failed in 7261 ms: its ready resolved false
  under three parallel workers, and it passed alone.
- **Issue:** the 2000 ms ready timer started when the socket was constructed, so it covered the loopback connect under
  load as well as the handshake. Separately, row 7 accepted any `false`, and a slow splice timing out would also have
  produced `false`.
- **Fix:** the 2000 ms bound now starts at socket `open` (the handshake proper), and the connect is bounded by ws
  `handshakeTimeout` (2000 ms). The harness returns `handshake: { ready, endedIn, cause, e2eeError }`. Row 7 now
  requires `endedIn: 'e2ee-authenticated'` and `cause: 'e2ee_error'` (the server's own refusal), and row 8 requires
  `cause: 'authenticated'`. After the fix the three files ran 21/21 twice.
- **Commit:** 489b4f555

**4. Interface extensions (additive):** `RelayPhone` gained `connId` and `handshake`; `RelayWakeHarness` gained
`relayHostId` and `targetLabel`. `host.wake.targets` returns `{ targets: [...] }`, so row 3 asserts `result.targets`.
The cell binds `127.0.0.1` explicitly; the integration test it copies bound all interfaces, and this follows D-14.

## Known Stubs

None. The harness wires real objects end to end. Test doubles are limited to two vitest spies inside row 9 (the same
shape as the 19 in-process test).

## Threat Flags

None. The new modules are test infrastructure. The production network surface is unchanged.

## Self-Check: PASSED

- FOUND: src/main/runtime/wake-broker-relay-test-harness.ts, src/main/runtime/relay/loopback-relay-cell.ts,
  src/main/runtime/wake-broker-relay-dispatch.test.ts, 20-01-MUTANTS.md
- FOUND commits: 8f71fa8d2, 2878d23c1, 489b4f555, aaaf0edb2 (`git rev-list --count 608a536fa..HEAD` = 4 before the
  metadata commit)
