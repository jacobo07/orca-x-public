---
phase: 19-wake-on-lan-capability-and-the-lan-wake-broker-m2
plan: 02
subsystem: host-availability
status: complete
tags: [wake-on-lan, wake-broker, rpc, durability, dgram]
requires: [phase 18 host availability vocabulary, device-authorization, secure-file durable publish]
provides: [host.wake.targets/request/status, HOST_WAKE_REFUSAL_CODES passthrough, createWakeBroker, wakeBrokerHost, sendMagicPacketUdp, loadWakeBrokerStore, runtime.wake-broker-state contract, composeWakeProgress]
affects: [src/main/runtime/rpc/errors.ts, src/main/runtime/rpc/methods/index.ts, src/shared/protocol-version.ts, config/durability-contracts.jsonc]
tech-stack:
  added: []
  patterns: [authority judged at the effect and again at the send, lazy-pruned windows with no timer, adds publish-first and removals memory-first]
key-files:
  created:
    - src/shared/host-wake.ts
    - src/shared/host-wake.test.ts
    - src/main/runtime/wake-broker.ts
    - src/main/runtime/wake-broker.test.ts
    - src/main/runtime/wake-broker-host.ts
    - src/main/runtime/wake-magic-packet.ts
    - src/main/runtime/wake-magic-packet.test.ts
    - src/main/runtime/wake-broker-store.ts
    - src/main/runtime/wake-broker-store.test.ts
    - src/main/runtime/rpc/methods/host-wake.ts
    - src/main/runtime/rpc/methods/host-wake.test.ts
  modified:
    - src/shared/protocol-version.ts
    - src/main/runtime/rpc/errors.ts
    - src/main/runtime/rpc/methods/index.ts
    - config/durability-contracts.jsonc
decisions:
  - "19-02: wake refusals use wake_device_revoked, never device_revoked; device_revoked stays the dispatch/E2EE latch reason, and no wake refusal carries reason or data.reason 'device_revoked'"
  - "19-02: the broker re-runs the whole judgement (device, grant, target) at the send, not only the device check"
  - "19-02: a failed wake (refused at the send or send error) is neither replayed nor adoptable; a retry with the same requestId re-attempts, and adopters of a failed wake start their own"
  - "19-02: host.wake.* carry no launch effect flag; the send ignores the socket signal, so a disconnect cannot cancel it"
  - "19-02: the store's default publisher is an explicit writeDurableSecureJsonFile(...) call; check:durability-contracts finds barriers by call site"
metrics:
  duration: 50min
  completed: 2026-10-27
plan_head_before: 981f39789
actuals:
  tokens: 18452
  tasks: 3
  commits: 6
---

# Phase 19 Plan 02: LAN Wake Broker core Summary

The broker core is in place. A paired device's `host.wake.request` is judged at the effect in this order: authority attached, device present, token authorizes as that device, grant, target. The judgement runs again immediately before the send. Only then does `dgram` send one 102-byte magic packet. Duplicates replay for 60 s and other requests for the same target adopt for 10 s. The broker writes only `requested`, `authorized`, `packet-sent` and `packet-send-failed`. Targets and grants persist crash-durably in `<userData>/orca-wake-broker.json`. Every refusal reaches the client under its own `wake_*` code. As the plan intends, nothing enables the broker yet (19-03 does that).

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 (tracer) | host.wake.request reaches a sender; each refusal reaches the client under its own code | 71fee67bc | 7aab0dc7b |
| 2 | Dedupe, adoption, status, client stage composition, real UDP frame | b1988f91d | b4268d543 |
| 3 | Crash-durable targets and grants with a durability contract | c9d844932 | 16f4f8ead |

## Verification (observed on this laptop, 2026-10-27)

RED lines:
- Task 1: `Error: Cannot find module '../../wake-broker' imported from C:/owx-haf/src/main/runtime/rpc/methods/host-wake.test.ts` / `Test Files  1 failed (1)`.
- Task 2: `Test Files  3 failed | 1 passed (4)`, `Tests  18 failed | 15 passed (33)`. Failures: composeWakeProgress (7), normalizeMac and sendMagicPacketUdp (5), and the broker's constants, replay, concurrent join, adoption, status retention and cap (6). The 15 that passed were the Task 1 suite plus three broker rows Task 1 already met: authority before dedupe, revoke between checks, send failure.
- Task 3: `Error: Cannot find module '/src/main/runtime/wake-broker-store' ...` / `Test Files  1 failed (1)`.

GREEN and gates:
- Task 1 verify (host-wake.test.ts and effect-class-registry.test.ts): `Test Files  2 passed (2)`, `Tests  21 passed (21)`. `typecheck:node` EXIT=0. The tracer gate re-ran the verify end to end before Task 2.
- Task 2 verify (4 files): `Test Files  4 passed (4)`, `Tests  33 passed (33)`. `Select-String setTimeout|setInterval` over wake-broker.ts and wake-magic-packet.ts: 0 hits. `check:recurring-work`: `Recurring-work inventory OK [total=236 interval=48 watcher=8 self-rescheduling-timeout=102 worker=13 helper=36 self-rescheduling-frame=29] debt=0`, the same as after 19-01.
- Task 3 verify: store test `Tests  12 passed (12)`. `check:durability-contracts`: `Durability contract check passed for 22 contract(s); 19 grandfathered durability publisher(s); 38 grandfathered direct state writer(s); 2 grandfathered durable-primitive delegate(s); 4 grandfathered durable publisher caller(s); no new ones.` `typecheck:node` EXIT=0.
- Plan verification block, run after the last code change:
  - vitest over the 6 files: `Test Files  6 passed (6)`, `Tests  55 passed (55)`.
  - `typecheck:node` EXIT=0 and `tsc --noEmit -p config/tsconfig.tc.web.json` EXIT=0.
  - `check:durability-contracts` EXIT=0 and `check:recurring-work` EXIT=0 (debt=0).
  - `git diff --quiet -- config/durability-contract-publisher-baseline.txt config/durability-failure-semantics-baseline.txt` EXIT=0: the publisher is classified, not grandfathered.
  - `git diff --quiet HEAD -- src/main/runtime/rpc/effect-class-registry.test.ts` EXIT=0, and `config/recurring-work-debt-baseline.txt` is unchanged.
- After the lint-staged format on the last commit, the store and broker tests were re-run: `Tests  21 passed (21)`.
- Non-test source size, counting non-blank and non-comment lines: wake-broker.ts 243, wake-broker-store.ts 225, host-wake.ts 111, wake-magic-packet.ts 47, host-wake RPC 51, wake-broker-host.ts 44. All are under 300, with no max-lines disable.

## Disjointness check (Task 1 read_first, run before the codes were committed)

- `device_revoked` appears only in two places:
  - `src/main/runtime/rpc/mobile-e2ee-auth-validation.ts:34,37,67`, the handshake/dispatch latch.
  - `mobile/src/transport/device-revocation-refusal.ts:9`, the phone latch. `namesDeviceRevocation` matches `reason === 'device_revoked' || data?.reason === 'device_revoked'` and never reads `code`.
- It stays a dispatch and handshake latch reason only. `HOST_WAKE_REFUSAL_CODES` does not contain it, and every refusal assertion in host-wake.test.ts checks that the mapped `error.data` does not contain the string `device_revoked`.
- No `wake_*` code appears anywhere in `mobile/src`, `src/shared` or `src/main/runtime/rpc`. No client maps a wake code to a retry, a fallback or an alternate path, so there is no blocker.

## Durability barrier finding (Task 3 read_first)

- `writeDurableSecureJsonFile` (src/shared/secure-file.ts:95-97) calls `writeSecureFile(..., { durable: true })`.
- That function fsyncs the staged temp file (`fsyncFileSync(tmpFile)`, :117-118) and ACL-restricts it (:121) before `renameSync(tmpFile, targetPath)` (:122). It then fsyncs the directory as a best effort, which is a no-op on Windows (:127-128).
- It uses its own barrier, not src/main/durable-file-write.ts. The contract schema allows this secure-file durable variant for state that needs the ACL publish.
- Existing syscall-order proof: V-REG-FSYNC-ORDER and V-REG-FSYNC-ORDER-ALL in src/main/runtime/device-registry-durability.test.ts:67-81 and :149-161 (fsyncSync before renameSync onto the state file). The new contract cites that file.
- wake-broker-store.test.ts also asserts the same order for this file directly: node:fs is mocked and the test sees fsyncSync before renameSync onto orca-wake-broker.json. So the fallback to writeFileDurableSync was not needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The holder had no way to reset**
- **Found during:** Task 1
- **Issue:** The `<interfaces>` holder could enable and mark unavailable, but could not return to disabled. The module-scope singleton would then leak between tests, and the serve stop path in 19-03 would have no way to retire the broker.
- **Fix:** Added `disable()` and exported `createWakeBrokerHost()`. The holder's store is typed `WakeBrokerStoreView`; 19-03 and 19-04 can widen it to `WakeBrokerStore`.
- **Commit:** 7aab0dc7b

**2. [Rule 2 - Security] The whole judgement re-runs at the send**
- **Found during:** Task 1
- **Issue:** The plan named only "authorize again" before the send.
- **Fix:** The same `judge()` (device, then grant, then target) runs at the effect moment. A refusal there carries `data { wakeId, stages }` without packet-sent.
- **Commit:** 7aab0dc7b

**3. [Rule 1 - Bug] A failed wake would otherwise be replayed or adopted for its window**
- **Found during:** Task 2
- **Issue:** A send failure, or a refusal at the send, would have been replayed to a retry for 60 s and adopted by other devices for 10 s. A transient UDP error would then have blocked every wake of that target.
- **Fix:** Failed entries leave both maps. Concurrent joiners of the same requestId share the failure. Adopters of a failed wake start their own (`startOrAdopt`).
- **Commit:** b4268d543

**4. [Rule 3 - Blocking] The durability gate did not see the barrier**
- **Found during:** Task 3
- **Issue:** `check:durability-contracts` reported `wake-broker-store.ts ... has no durability barrier`. The default publisher was passed by reference, and the gate detects `writeDurableSecureJsonFile(` at a call site.
- **Fix:** The default publisher is now an explicit call, `(path, value) => writeDurableSecureJsonFile(path, value)`.
- **Commit:** 16f4f8ead

**5. [Rule 2 - Input validation] The store validates what it persists**
- **Found during:** Task 3
- **Fix:**
  - `addTarget` normalizes the MAC, requires an IPv4 broadcast address, a port from 1 to 65535 and a label of at most 64 characters, and otherwise throws `invalid_argument` (already a passthrough code).
  - `addGrant` for an unregistered target throws `wake_target_unknown`. It is idempotent and does not publish when the grant already exists.
  - Loading is strict: one malformed target or grant row makes the file unreadable, so it is preserved and the store fails closed.
- **Commit:** 16f4f8ead

### Notes
- `mintWakeId()` (`wk_` + 16 hex) is exported for 19-03, so it can supply `newWakeId` when it enables the broker.
- A test in wake-magic-packet.test.ts proves that a send which throws synchronously (port 70000) rejects and never resolves. The positive and negative UDP controls bind only to 127.0.0.1. Nothing was broadcast onto the LAN.
- The phone methods are registered but not yet in `MOBILE_RPC_METHOD_ALLOWLIST`, which is 19-03 scope. Until then a mobile-scope device gets `forbidden` at dispatch.
- The gsd `state.advance-plan` / `update-progress` commands are not used on this STATE.md format (see 19-01). Current Position was edited by hand.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. The three new RPC methods are the T-19-06..T-19-12 surface, and each mitigation is pinned by a named test:
- grant-first ordering (T-19-09);
- authority before dedupe, and a re-judge at the send (T-19-07);
- adoption keyed by target, plus the record cap (T-19-08);
- no broker-written host-announced (T-19-10);
- removals memory-first, and a grant valid only while its device authorizes (T-19-11);
- passthrough codes, asserted on the mapped response (T-19-12).

## Self-Check: PASSED

- All 11 created files exist on disk.
- All 6 commits are on `mobile/host-availability`: 71fee67bc, 7aab0dc7b, b1988f91d, b4268d543, c9d844932, 16f4f8ead.
- `git rev-list --count 981f39789..HEAD` = 6.
