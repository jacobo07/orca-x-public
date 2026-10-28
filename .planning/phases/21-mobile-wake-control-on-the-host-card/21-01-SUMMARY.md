---
phase: 21-mobile-wake-control-on-the-host-card
plan: 01
subsystem: wake-broker
status: complete
tags: [wake-on-lan, wake-broker, host-key, cli, rpc]
requires: [phase 19 LAN Wake Broker (store, admin methods, CLI), host-key-fingerprint.ts]
provides:
  - HOST_KEY_FORM / isHostKey and optional hostKey on HostWakeTargetSummary (src/shared/host-wake.ts)
  - WakeTarget.hostKey and the additive targetsFor projection
  - WakeBrokerStore.bindTarget (bind/rebind disk first, unbind memory first, one key per broker)
  - local-only host.wake.admin.targetBind and host.wake.admin.hostKey
  - WakeBrokerHost.attachPairingKeySource / pairingPublicKey (live, attached by runtime-rpc.ts)
  - CLI orca wake target bind|unbind, orca wake host-key
affects: [21-02 routing by hostKey, 21-05 session wiring, check:host-card-claims RPC count]
tech-stack:
  added: []
  patterns: [additive optional wire field, live key-source closure attached beside the device authority]
key-files:
  created:
    - src/main/runtime/wake-host-key-in-process.test.ts
  modified:
    - src/shared/host-wake.ts
    - src/main/runtime/wake-broker.ts
    - src/main/runtime/wake-broker-store.ts
    - src/main/runtime/wake-broker-state-schema.ts
    - src/main/runtime/wake-broker-host.ts
    - src/main/runtime/runtime-rpc.ts
    - src/main/runtime/rpc/methods/host-wake-admin.ts
    - src/cli/specs/wake.ts
    - src/cli/handlers/wake.ts
    - src/cli/handler-group-manifest.ts
    - config/durability-contracts.jsonc
    - src/main/runtime/wake-broker-store.test.ts
    - src/main/runtime/rpc/methods/host-wake-admin.test.ts
    - src/main/runtime/rpc/methods/host-wake.test.ts
    - src/cli/handlers/wake.test.ts
decisions:
  - "host_key_unavailable joins HOST_WAKE_REFUSAL_CODES so the error passthrough carries data.reason to the CLI; errors.ts is untouched"
  - "orca wake host-key calls the client directly, without the broker recovery hints (it runs on the host to be woken)"
  - "the own-key check runs after adminStore and only for a non-null key; unbind never reads the key"
metrics:
  duration: "~25 min (15:04 base to 15:29)"
  completed: 2026-10-28
  tasks: 3
  files: 16
estimate:
  tokens: 110000
actuals:
  tokens: 7534        # chars/4 over the added lines of BASE..HEAD (30136 chars); whole changed files are 61988
  tasks: 3
  commits: 6
plan_head_before: 8858ab60fb3001026a0aaa92defb157a2e342da5
---

# Phase 21 Plan 01: Broker binding by hostKey Summary

The broker now binds a wake target to the SHA-256 base64url fingerprint of the woken host's E2EE public key. A local
admin method writes the binding: disk first, one key per broker, never the broker's own key. Granted phones see it as
an additive `hostKey` on `host.wake.targets` with no MAC. `orca wake host-key` reads the key on the target from the
same keypair the server publishes in its pairing offer.

BASE (HEAD before the first commit of this plan): `8858ab60fb3001026a0aaa92defb157a2e342da5`.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 RED | 9f8a5caa3 | test(21-01): RED bound target reaches host.wake.targets |
| 1 GREEN | 0fefd9a38 | feat(21-01): bind a wake target to its host key and project it to the phone |
| 2 RED | 754632b50 | test(21-01): RED binding rule table |
| 2 GREEN | 83a033beb | feat(21-01): schema-1 loader and store enforce the host-key binding rules |
| 3 RED | 3cc09a9fc | test(21-01): RED host-key readout and bind CLI |
| 3 GREEN | d035dda2a | feat(21-01): host-key readout and wake target bind/unbind CLI |

## Task 1: tracer (bound target reaches the phone)

- RED (9f8a5caa3), from `pnpm exec vitest run --config config/vitest.config.ts src/main/runtime/rpc/methods/host-wake-admin.test.ts src/main/runtime/rpc/methods/host-wake.test.ts src/main/runtime/wake-broker-store.test.ts`:
  `Tests  7 failed | 58 passed (65)`. Failures: `Error: host.wake.admin.targetBind must be a request method` (the four remote rows and the bind flow), and in host-wake.test.ts `AssertionError: expected { targets: [ { …(2) } ] } to deeply equal { targets: [ { …(3) } ] }` and `expected [ [ 'label', 'targetId' ] ] to deeply equal [ [ 'hostKey', 'label', 'targetId' ] ]`.
- GREEN (0fefd9a38), the same three files plus wake-broker.test.ts: `Test Files  4 passed (4)`, `Tests  75 passed (75)`; typecheck:node and typecheck:cli exit 0.
- Exact-key rows: host-wake.test.ts "projects exactly targetId, label and a bound hostKey" compares `Object.keys(...).sort()` with toEqual for an unbound target (`['label','targetId']`) and a bound one (`['hostKey','label','targetId']`). host-wake-admin.test.ts does the same through the real targetBind, store and projection, before and after the bind. In host-wake.test.ts the fixture T2 now carries a hostKey, so the MAC_PATTERN afterEach runs over a bound reply.
- Projection line check (`Select-String -Path src/main/runtime/wake-broker.ts -Pattern '\.map\(\(target\) => \(\{' -Context 0,3`):
  ```
  MATCHES=1
  LINE:           .map((target) => ({
  POST:             targetId: target.targetId,
  POST:             label: target.label,
  POST:             ...(target.hostKey ? { hostKey: target.hostKey } : {})
  HAS_MAC_BROADCAST_PORT=False
  ```

## Task 2: binding rule table

- RED (754632b50), `src/main/runtime/wake-broker-store.test.ts src/main/runtime/wake-broker.test.ts`: `Tests  8 failed | 39 passed (47)`.
  - RED rows (8): a stored hostKey of 42 characters, 44 characters, a `+`, a `/`, an empty string, a number, or `null` must make the file `wake_broker_state_unreadable` (7; they loaded because isStoredTarget accepted any extra key). Also: one key on two targets of one broker is refused, naming the bound target, with no write (`Error: expected a throw`).
  - Rows that passed on the first run (10, already satisfied by the Task 1 code): a well-formed key loads and is kept; an absent key loads with no hostKey key; an unknown target is refused (`wake_target_unknown`) and a malformed key is refused (`invalid_argument`) with no write; a rebind from A to B leaves B on disk with schema 1; binding the same key again is a no-op with no write; unbind is memory first (a failed publish still leaves the target unbound, and the error propagates); unbind deletes the key; bind is disk first (a failure before landing leaves the target unbound); a bind that lands and then fails is `wake_broker_state_indeterminate` with `active: true`; removing a bound target leaves no orphan key.
- GREEN (83a033beb): `Test Files  4 passed (4)`, `Tests  93 passed (93)` (store, broker, admin, phone methods). `check:durability-contracts`: `Durability contract check passed for 22 contract(s); 19 grandfathered durability publisher(s); 38 grandfathered direct state writer(s); 2 grandfathered durable-primitive delegate(s); 4 grandfathered durable publisher caller(s); no new ones.` `Select-String ... 'STATE_SCHEMA = 1'` matched once. oxlint (max-lines included) exited 0 on the store, the schema and the store test. Typechecks exited 0.
- The `runtime.wake-broker-state` contract text listed the target fields, so it now reads `(MAC, broadcast, port, label, optional bound hostKey)`. Tier and proof are unchanged.

## Task 3: Owner path

- RED (3cc09a9fc), `wake-host-key-in-process.test.ts host-wake-admin.test.ts src/cli/handlers/wake.test.ts`: 46 failed. Causes: `WAKE_HANDLERS.wake target bind is not a function` (and unbind / host-key); `wakeBrokerHost.attachPairingKeySource is not a function`; the in-process reply `{ ok: false }`; the target list lacking `host `. The existing grants-block rows of host-wake-admin.test.ts are among the 46 because their beforeEach now attaches a pairing key source.
- GREEN (d035dda2a), `wake-host-key-in-process.test.ts host-wake-admin.test.ts wake-broker-host.test.ts wake-broker-revoke-in-process.test.ts src/cli/handlers/wake.test.ts`: `Test Files  5 passed (5)`, `Tests  119 passed (119)`.
- In-process proof (plan check W2), on a real OrcaRuntimeRpcServer with a temp userData and `enableWebSocket`: `host.wake.admin.hostKey` from a local dispatch equals `fingerprintHostPublicKey(decodePairingOffer(createPairingOffer(...).pairingUrl).publicKeyB64)`. In the control, `loadOrCreateE2EEKeypair` in a second temp dir fingerprints differently, and the readout is not equal to it. No broker is enabled (`wakeBrokerHost.current()` is null). The key reaches the method only through `wakeBrokerHost.pairingPublicKey()`, a live closure over `this.getE2EEPublicKey()` attached in runtime-rpc.ts right after `attachDeviceAuthority`. `null` is attached when the pairing identity fails. e2ee-keypair.ts is unchanged (`git diff --quiet BASE..HEAD -- src/main/runtime/e2ee-keypair.ts` exits 0).
- The registries that list the CLI verbs were found by running `src/cli/registry-parity.test.ts` and `src/cli/handler-group-manifest.test.ts`, which failed until `wake target bind`, `wake target unbind` and `wake host-key` were added to src/cli/handler-group-manifest.ts. After that, those two files plus vocabulary-policy and wake.test.ts gave `Tests  73 passed (73)`. A grep for `host.wake.admin.grantList` found no other method-name registry.
- Gates at d035dda2a: typecheck:node exit 0, typecheck:cli exit 0, `check:recurring-work` `Recurring-work inventory OK [total=236 interval=48 watcher=8 self-rescheduling-timeout=102 worker=13 helper=36 self-rescheduling-frame=29] debt=0`, durability as above. The claims gate's own pin test (`config/scripts/host-capability-producer-gate.test.mjs`, which recomputes the RPC count) gave `Tests  32 passed (32)`.
- **check:host-card-claims success line (the RPC count is 600 = 598 + targetBind + hostKey):**
  `check-host-card-claims: 22 labels classified, 2 controls classified, 600 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified, 3 capability emitters scanned.`
  The pinned success line was not edited (21-04 owns it).
- `git diff --quiet 8858ab60f..HEAD -- src/main/runtime/rpc/methods/host-wake.ts src/main/runtime/orca-runtime.ts` exits 0. The phone method file is unchanged and status.get gains no field.

## Final verification (HEAD d035dda2a)

`pnpm exec vitest run --config config/vitest.config.ts` over host-wake-admin, host-wake, wake-broker-store, wake-broker, src/cli/handlers/wake, wake-host-key-in-process, wake-broker-host and wake-broker-revoke-in-process test files: `Test Files  8 passed (8)`, `Tests  178 passed (178)`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `host_key_unavailable` added to HOST_WAKE_REFUSAL_CODES**
- **Found during:** Task 3
- **Issue:** `mapRuntimeError` only passes `code` and `data` through for codes it knows. A new `host_key_unavailable` would have reached the CLI as `runtime_error`, without `data.reason`.
- **Fix:** add it to `HOST_WAKE_REFUSAL_CODES` in src/shared/host-wake.ts (already in this plan's files), which errors.ts spreads into its passthrough set. Nothing on the phone imports that list (grep).
- **Commit:** d035dda2a

**2. [Rule 3 - Blocking] CLI handler manifest**
- **Found during:** Task 3
- **Issue:** src/cli/handler-group-manifest.ts lists every wake handler key, and registry-parity / handler-group-manifest tests failed without the three new verbs. The file was not in the plan's file list.
- **Fix:** added `wake target bind`, `wake target unbind` and `wake host-key` to the wake group.
- **Commit:** d035dda2a

**3. [Note] `orca wake host-key` bypasses the broker recovery hints**
- The broker verbs map `runtime_unavailable` to "Start the broker ... orca serve --wake-broker". That would mislead on the host to be woken, so this verb calls `ctx.client.call` directly and keeps the generic recovery. It still runs behind the same `assertWakeRunsOnBroker` guard (ORCA_CLI_CWD, --environment/--pairing-code and remote client refused before any call; covered by the existing it.each rows, now including the three new verbs). The guard's refusal text still says "broker host" for the host-key verb.

No architectural change. `wake-broker-store.ts` stayed under the 300-counted-line cap (oxlint exit 0), so no `wake-broker-target-binding.ts` module was needed.

## Known Stubs

None. Every new path is wired end to end: CLI → admin method → store → disk, and store → projection → phone method.

## Threat Flags

None beyond the plan's register. T-21-01..06 are mitigated as planned:
- form check at zod, store and loader;
- isLocalRpcCaller first, plus the CLI guard;
- a separate method;
- the spread-only projection;
- the duplicate-key refusal;
- commitAddition / commitRemoval.

## Self-Check: PASSED

- FOUND: src/main/runtime/wake-host-key-in-process.test.ts
- FOUND commits: 9f8a5caa3, 0fefd9a38, 754632b50, 83a033beb, 3cc09a9fc, d035dda2a (`git log --oneline 8858ab60f..HEAD`, COMMITS=6)
