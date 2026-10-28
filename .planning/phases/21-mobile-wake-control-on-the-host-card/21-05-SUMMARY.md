---
phase: 21-mobile-wake-control-on-the-host-card
plan: 05
subsystem: mobile host card wake session
status: complete
tags: [mobile, host-card, wake, wake-broker, session-evidence, gex44]
requires: [21-02 composeHostWakeRoute + hostKeyFromPublicKeyB64 + VECTOR, 21-04 presentHostCardWake + HostCardWakeAttempt + MobileHostCard wake/onWake]
provides:
  - mobile/src/transport/home-host-wake-session.ts (hostKeyOfPublicKey, advertisesWakeBroker, shouldFetchWakeTargets, hostsAskableForWakeTargets, fetchHomeHostWakeTargets, brokerRouteInputs, planHostWakePress, requestHostWake, pressHostWake, readHostWakeStatus, isWakeAttemptTerminal, wakesToRefresh)
  - mobile/src/components/use-host-card-wake.ts (useHostCardWake -> wakeFor, pressWake, refreshWakes)
  - index.tsx passes wake and onWake to MobileHostCard and calls refreshWakes in the existing focus loop
affects: [21-06 mutants and verification, the owed phone leg]
tech-stack:
  added: []
  patterns: [route recomposed at press time, per-status-answer targets ask, press-reply anchor kept on re-read, refusal as attempt state, focus re-read instead of a timer]
key-files:
  created:
    - mobile/src/transport/home-host-wake-session.ts
    - mobile/src/transport/home-host-wake-session.test.ts
    - mobile/src/components/use-host-card-wake.ts
  modified:
    - mobile/app/index.tsx
decisions:
  - "The requestId is minted in pressHostWake (session module) with expo-crypto randomUUID, already a mobile dependency, so the fresh-id row runs the real minting path rather than a hook nobody tests"
  - "readHostWakeStatus keeps repliedAt: the press reply is the phone-observed anchor the presenter rebases broker stages to; a re-read replaces brokerStages only, and a read that never answers keeps the attempt by identity"
  - "isWakeAttemptTerminal is true on any refusal or any readable packet-send-failed record; the broker never writes after packet-send-failed (wake-broker.ts sendWake), so this equals the last-stage rule and does not depend on array order"
  - "Targets are asked once per status answer (askedAt keyed by status.observedAt), so a re-render while the first ask is on the wire never sends a second one"
  - "A transport rejection of host.wake.request settles the attempt as refusal unknown, because the request may or may not have reached the broker"
metrics:
  duration: "~22 min (16:32 to 16:54)"
  completed: 2026-10-28
  tasks: 2
  files: 4
estimate:
  tokens: 115000
actuals:
  tokens: 9408        # chars/4 over the added mobile lines of BASE..HEAD (37632 chars), before this SUMMARY commit
  tasks: 2
  commits: 4
plan_head_before: f1b9ad04d2e6305066cb4e029353cea741d9f13b
---

# Phase 21 Plan 05: Session broker answers and the Wake press on the home screen Summary

The home screen now feeds the 21-04 card real inputs. When a connected host's current status.get advertises
`host.wake-broker.v1`, the phone asks it `host.wake.targets` once for that status answer. It stamps the answer with the
phone clock and keeps it in React state only. Each card's hostKey is the profile's own `publicKeyB64` through the
shared rule and `@noble/hashes` sha256, and the pinned 21-02 vector holds. A press runs `composeHostWakeRoute` again on
the state of that moment. Only when it routes does the phone send exactly one `host.wake.request { targetId, requestId }`.
It goes on the routed broker's own client, with a fresh requestId, and nothing goes to the target or to any other
broker. Progress has no timer. `host.wake.status` is re-read on screen focus, only for answered wakes that are not
terminal. `host-announced` still comes only from the target's own reconnect and status.get (21-04 presenter rule). A
`wake_device_revoked` refusal becomes that attempt's refusal code. Through a real RpcClient it never reaches
handleAuthRejection.

Evidence label: **UNIT (GEX44 disposable root)**. The session module and its selectors run under vitest. index.tsx and
the hook pass oxlint, oxfmt and mobile tsc, but nothing was rendered or pressed on a phone. The phone leg is owed.

BASE (HEAD before the first commit of this plan) = `f1b9ad04d2e6305066cb4e029353cea741d9f13b`.

## Commits

| Task | Commit | Subject |
|---|---|---|
| 1 RED | b0d75d690 | test(21-05): RED press routes to the session broker |
| 1 GREEN | ffc71ffbf | feat(21-05): press on a bound card sends one host.wake.request to the session broker |
| 2 RED | 010e61789 | test(21-05): RED wake progress and refusals |
| 2 GREEN | 696f4002f | feat(21-05): wake progress re-read on focus, refusals stay wake states |

`git show --numstat --format= ffc71ffbf -- mobile/app/index.tsx` = `10 0` (cap 20). For 696f4002f it is `3 2`
(destructure refreshWakes, the call in the focus loop, the deps array). index.tsx is 1272 counted lines of the 1422
cap. `mobile/.oxlintrc.json` is untouched and there is no max-lines disable.

Counted lines (non-blank, non-comment): session module 228 of the .ts cap 300; hook 126; test 618 of the test cap 800.

## GEX44 runs

All runs used host kobicraft-gex44, node v24.21.0, pnpm 12.15.0 and the phase 18 runner unchanged. The mobile tsc has
the same 3 pre-existing errors before and after (MermaidDiagram.tsx TS2307, terminal-webview-html.ts TS2307,
mobile-workspace-client.ts TS2366). None is in this plan's files, and none names `src/shared/`.

| Run | Root | Result |
|---|---|---|
| T1 RED (test) | /tmp/orca-phone-p18-20261028T153607Z | `RUNNER vitest_rc=1`, `RUNNER result=FAIL`: suite failed, `Cannot find module '/src/transport/home-host-wake-session'` |
| T1 GREEN (full) | /tmp/orca-phone-p18-20261028T154041Z | 12/12, `RUNNER vitest_rc=0`, `RUNNER oxlint_rc=0 oxfmt_rc=0 tsc_rc=2`, `tsc_errors_touched=0`, `RUNNER result=PASS` |
| T2 RED (test) | /tmp/orca-phone-p18-20261028T154429Z | `RUNNER vitest_rc=1`, `RUNNER result=FAIL`: 7 failed / 16 passed (`readHostWakeStatus`, `isWakeAttemptTerminal`, `wakesToRefresh` are not functions) |
| T2 GREEN (full, + 21-04 regression) | /tmp/orca-phone-p18-20261028T154651Z | see below |

Every run printed `TEARDOWN procs=0 root=absent` and `PROOF ROOT_ABSENT_CONFIRMED`.

Final full gate. It synced the four plan files and ran the session test, `MobileHostCard.test.tsx` and
`host-availability-presentation.test.ts`:

```
RUNNER synced=4 mobile files: src/transport/home-host-wake-session.ts src/transport/home-host-wake-session.test.ts src/components/use-host-card-wake.ts app/index.tsx
Test Files  3 passed (3)
Tests  109 passed (109)
RUNNER vitest_rc=0
Found 0 warnings and 0 errors.
RUNNER oxlint_rc=0 oxfmt_rc=0 tsc_rc=2
RUNNER tsc_errors_total=3 tsc_errors_preexisting=3 tsc_errors_touched=0
RUNNER result=PASS
TEARDOWN procs=0 root=absent
PROOF ROOT_ABSENT_CONFIRMED
LOCAL exit=0
```

109 = 23 session rows + the 86 presenter and card rows from 21-04, which are unchanged and pass.

## Laptop gates (after each GREEN commit's tree; read from log files)

- `pnpm run typecheck:node`, `pnpm run typecheck:cli`, `pnpm exec tsc --noEmit -p config/tsconfig.tc.web.json`: rc=0
  after Task 1 and again after Task 2.
- `pnpm run check:host-card-claims` rc=0, both times:
  `check-host-card-claims: 41 labels classified, 3 controls classified, 600 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified, 3 capability emitters scanned.`
- `pnpm run check:recurring-work` rc=0:
  `Recurring-work inventory OK [total=236 interval=48 watcher=8 self-rescheduling-timeout=102 worker=13 helper=36 self-rescheduling-frame=29] debt=0`.
  This is unchanged from phase 20 (total=236 debt=0). Nothing under src/ gained a timer.

## Rows (home-host-wake-session.test.ts, 23)

- Vector: `hostKeyOfPublicKey('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=')` is `toBe`
  `'Yw3NKWbEM2aRElRIu7JbT_QSpJxzLbLIq8G4WBvXEN0'`, as a literal. Junk and a short key give null.
- Ask selection:
  - `advertisesWakeBroker` holds only for a record whose capabilities array holds `host.wake-broker.v1`.
  - `shouldFetchWakeTargets` asks again only when targets are older than the status answer.
  - `hostsAskableForWakeTargets` picks the connected advertised host only, never the plain host or the reconnecting one.
- Fetch: one `host.wake.targets` with params undefined. Stored `{ observedAt: 7000 (phone clock), targets: raw }`. A
  refusal keeps the previous answer by identity.
- Press tracer: broker A (connected, current status, bound target `wt_0123456789ab` with the VECTOR key) and target T.
  The plan is `{ client: A, brokerHostId: 'host-a', targetId }`. A gets exactly
  `[{ method: 'host.wake.request', params: { targetId, requestId } }]` and T gets `[]`. onPressed sees the pending
  attempt (repliedAt null) before the reply. The attempt has pressedAt 5000 < repliedAt 5001, wakeId and the reply's
  stages.
- Fresh id: two presses through `pressHostWake` send two different requestIds, each 8-128 characters.
- No route: an unbound entry gives a null plan, a null press, and no call on either client. A routed broker with no
  registered client gives null.
- Relay profile: a `HostProfile` with a `relay` block, `relayHostId` and a `wss://relay-c1...` endpoint routes to A by
  `publicKeyB64` alone. Its id `host-t-relay` matches no client. The same relay, endpoint and id with another key give
  null.
- Progress:
  - `readHostWakeStatus` sends `host.wake.status { wakeId }` on the attempt's broker client. It replaces brokerStages
    and keeps every other field.
  - `wake_unknown` gives refusalCode `wake_unknown`, which is terminal.
  - A rejected read keeps the attempt by identity. No wakeId means no request.
- Terminal: packet-sent and an unreadable value are not terminal. packet-send-failed and a refusal are.
  `wakesToRefresh` over five attempts selects only the answered, unfinished one with a wakeId.
- Latch:
  - A `wake_device_revoked` reply records `refusalCode: 'wake_device_revoked'`, which is terminal, and
    `namesDeviceRevocation(reply.error)` is false. An empty code records `unknown`.
  - The session and hook sources contain none of these tokens: `device-revocation-refusal`, `namesDeviceRevocation`,
    `handleAuthRejection`, `setInterval`, `setTimeout`, `AsyncStorage`, `async-storage`, `SecureStore`,
    `secure-store`, `saveHomeSnapshot`. A positive control checks that the reader saw `'host.wake.request'` and
    `export function useHostCardWake`.
- Real RpcClient (plan check info 6). `connect()` runs over a mock WebSocket with e2ee mocked. handleAuthRejection is a
  closure, so the spy is console.log's `[net] auth rejected` prefix, which both of its branches print, plus onLog and
  onStateChange.
  - A `wake_device_revoked` reply to `host.wake.request` leaves: 0 auth rejections, no `Authentication rejected` log, no
    `reconnecting` or `auth-failed` state, state `connected`, no socket close, and one socket. The next `status.get`
    goes out on the same socket and is answered ok.
  - Control: an `unauthorized` + `data.reason: device_revoked` reply on the same path does fire the spy and latches
    `auth-failed`. The attempt then reads `unknown`. The spy can fire, so its silence in the first row is evidence.

## TDD notes

- Task 1 is a tracer, and RED (b0d75d690) precedes GREEN (ffc71ffbf). The tracer gate passed: the GREEN run was full
  mode, a superset of the plan's test-mode `<verify>`, before Task 2 started.
- Task 2: RED (010e61789) precedes GREEN (696f4002f). 7 of the 11 new rows failed. The other 4 passed at RED:
  - the empty-code row and the source-token row, because Task 1's `requestHostWake` already records refusal codes and
    imports no latch;
  - the two real-RpcClient rows, because the guard at rpc-client.ts:527 predates this plan.

  They were not weakened to fail. The control row shows the RpcClient harness discriminates. Mutants of the session
  module belong to 21-06.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] RED commit refused by oxlint**
- **Found during:** the Task 1 RED commit.
- **Issue:** the pre-commit hook rejected `new Array(32)` (unicorn/no-new-array). The hook reverted the commit.
- **Fix:** `Array.from({ length: 32 }, () => 1)`. The RED cause is unchanged (the module is missing). Committed as
  b0d75d690.

**2. [Process] Formatter left a stale index after 010e61789**
- `diff --cached --quiet` returned 1 while the tree equalled HEAD (`diff HEAD --ignore-cr-at-eol --quiet` = 0).
- Only that index entry was reset, and the file was restored from HEAD. `diff --cached --quiet` is 0. After b0d75d690
  one stat-dirty file equal to HEAD was restored from HEAD.

### Interface adjustments (plan-intended behaviour kept)

**3. requestId minted in `pressHostWake`, not in the hook.**
- `pressHostWake` composes `planHostWakePress` and `requestHostWake` with `ExpoCrypto.randomUUID()`.
- expo-crypto is already a mobile dependency, used by use-codex-reset-credit-action.ts, so no dependency was added.
- The fresh-id row runs this path. The hook only guards a double tap and stores the attempts.

**4. Two extra exports.**
- `hostsAskableForWakeTargets`, so that "a host without the capability is never asked" is a unit row.
- `pressHostWake`, so that the relay-profile row passes a whole `HostProfile`.

**5. `readHostWakeStatus` takes no `now`.** It keeps repliedAt (decision above), so it needs no clock.

**6. Terminal rule** uses any readable packet-send-failed record (decision above). The plan's rows (packet-send-failed
terminal, packet-sent not) hold.

### Not changed (outside this plan's files)

- `src/shared/host-wake-proxy.ts:49` still says composeWakeProxyAvailability has "No UI consumer until the deferred
  mobile Wake control". After this plan the consumer is wired into index.tsx. That file is not in 21-05's
  files_modified, so it is left for 21-06 (verification and close).

### Residual (not in this plan)

- Hermes base64 padding was not measured. The plan has no Hermes row, and vitest on GEX44 runs Node's atob. The phone
  derivation is pinned on Node by the vector. The canonical re-pad from 21-02 stays the defense. The real engine is
  owed to a phone leg.

## Known Stubs

None. Every export is wired: index.tsx calls the hook, the hook calls the session module, and the card renders the
inputs. The hook has no direct render test. Its decisions live in the session module's pure selectors
(`hostsAskableForWakeTargets`, `brokerRouteInputs`, `planHostWakePress`, `wakesToRefresh`), which are tested. Its
React wiring is proven only by tsc and oxlint, and on a device it is owed.

## Threat Flags

None beyond the plan's register:
- T-21-21: the route is recomposed at press time and sent only on the routed broker's own client. The tracer row has
  one send on A and none on T, and a missing broker client gives null.
- T-21-22: the hook never picks a broker; `planHostWakePress` returns null unless the composer routes.
- T-21-23: the refusal is stored as an attempt state. There is no latch import (token row). The predicate reads false.
  The real-client row shows no auth rejection, and its control shows the spy fires.
- T-21-24: React state only. The storage-token row covers both sources, and `saveHomeSnapshot` in index.tsx is
  unchanged.
- T-21-25: there is no timer (token row). Re-reads happen on focus and press only; recurring-work total=236 debt=0.
- T-21-26: the phone receives targetId, label and hostKey (the 21-01 projection). Nothing here reads a MAC.

## Self-Check: PASSED

- FOUND: mobile/src/transport/home-host-wake-session.ts, mobile/src/transport/home-host-wake-session.test.ts,
  mobile/src/components/use-host-card-wake.ts, mobile/app/index.tsx (modified).
- FOUND commits: b0d75d690, ffc71ffbf, 010e61789, 696f4002f (`git rev-list --count f1b9ad04d..HEAD` = 4).
