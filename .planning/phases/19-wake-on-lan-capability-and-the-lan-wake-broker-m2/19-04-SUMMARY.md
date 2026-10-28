---
phase: 19-wake-on-lan-capability-and-the-lan-wake-broker-m2
plan: 04
subsystem: host-availability
status: complete
tags: [wake-on-lan, wake-broker, cli, rpc, local-only, ssh-relay]
requires: [19-02 broker store and host-wake refusal codes, 19-03 serve-only broker enable and live device authority]
provides: [HOST_WAKE_ADMIN_METHODS (host.wake.admin.targetAdd/targetList/targetRemove/grantAdd/grantRemove/grantList), WAKE_COMMAND_SPECS, WAKE_HANDLERS + createWakeHandlers(env), assertLocalInvocation in src/cli/runtime/local-invocation.ts, normalizeMac + isWakeTargetLabel in src/shared/host-wake.ts]
affects: [src/main/runtime/rpc/methods/index.ts, src/cli/specs/index.ts, src/cli/handler-group-manifest.ts, src/cli/index.ts, src/cli/runtime/serve-autostart.ts, src/main/runtime/wake-magic-packet.ts]
tech-stack:
  added: []
  patterns: [local-only admin RPC behind isLocalRpcCaller, CLI-side relay refusal before any runtime call, one shared validation rule for CLI and method schema]
key-files:
  created:
    - src/main/runtime/rpc/methods/host-wake-admin.ts
    - src/main/runtime/rpc/methods/host-wake-admin.test.ts
    - src/cli/specs/wake.ts
    - src/cli/handlers/wake.ts
    - src/cli/handlers/wake.test.ts
    - src/cli/runtime/local-invocation.ts
  modified:
    - src/main/runtime/rpc/methods/index.ts
    - src/cli/specs/index.ts
    - src/cli/handler-group-manifest.ts
    - src/cli/runtime/serve-autostart.ts
    - src/cli/index.ts
    - src/shared/host-wake.ts
    - src/main/runtime/wake-magic-packet.ts
decisions:
  - "19-04: every host.wake.admin.* method refuses a non-local caller (any of clientId, pairedDeviceId, clientKind, connectionId, foreign fingerprint) with remote_caller_refused before it resolves the broker"
  - "19-04: grantAdd needs an attached device authority (else wake_broker_unavailable) and deviceExists (else wake_device_unknown); the store still refuses an unregistered target"
  - "19-04: orca wake refuses ORCA_CLI_CWD, --environment / --pairing-code and a remote-resolved client with remote_invocation_refused before any call; wake is in shouldIgnoreRemoteSelection"
  - "19-04: normalizeMac lives in src/shared/host-wake.ts (the CLI tsconfig cannot reach src/main); wake-magic-packet re-exports it"
  - "19-04: no CLI or RPC lists paired device ids; the hint names desktop Settings and the device's own status.get pairedDeviceId (named residual)"
metrics:
  duration: 55min
  completed: 2026-10-27
plan_head_before: 073bc8050
actuals:
  tokens: 12000
  tasks: 3
  commits: 6
---

# Phase 19 Plan 04: Local wake administration (`orca wake target|grant`) Summary

The Owner now administers the LAN Wake Broker from a shell on the broker host:

- `orca wake target add --mac <mac> [--broadcast <ipv4>] [--port <n>] [--label <text>]`
- `orca wake target list`
- `orca wake target remove <targetId>`
- `orca wake grant add --device <id> --target <id>`
- `orca wake grant remove --device <id> --target <id>`
- `orca wake grant list`

Each command makes exactly one call to a `host.wake.admin.*` method. Each method refuses any non-local caller with `remote_caller_refused`, then acts on the enabled broker's store. The CLI never writes the state file: the running broker is its only writer (D-10).

Before any runtime call, the CLI refuses three remote paths with `remote_invocation_refused`:

- `ORCA_CLI_CWD` is set (the SSH relay bridge);
- `--environment` or `--pairing-code` is passed;
- the client resolved to a remote pairing.

MACs appear only in the local target rows. Grant rows carry `{ deviceId, targetId, grantedAt }`, and the phone methods are unchanged.

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 (tracer) | `orca wake target add` / `list` over local-only admin methods | bf88aace7 | be0eff939 |
| 2 | Grants and target removal | 983a4df8e | 2033e4e9f |
| 3 | Refuse the SSH relay bridge with the shared phase 17 guard | 5df4f0063 | bc5f570ae |

## Verification (observed on this laptop, 2026-10-27)

### RED lines

- **Task 1:** `Error: Cannot find module './wake'` and `Cannot find module './host-wake-admin'`. `Test Files 2 failed | 1 passed (3)`; the manifest test passed 10/10.
- **Task 2:** `Test Files 2 failed | 2 passed (4)`, `Tests 19 failed | 48 passed (67)`. The 10 admin rows and the 9 CLI rows failed because the methods and handlers did not exist.
- **Task 3:** `Tests 15 failed | 54 passed (69)`, `TypeError: createWakeHandlers is not a function`.

### GREEN and gates

- **Task 1 verify** (admin, wake, manifest): `Test Files 3 passed (3)`, `Tests 37 passed (37)`.
  - TC_cli=0 and TC_node=0. The first CLI typecheck failed on a dynamic import in the test; it was fixed before commit.
  - With neighbours (registry-parity, mobile-rpc-allowlist, effect-class-registry, wake-magic-packet, wake-broker-store, host-wake): `Test Files 9 passed (9)`, `Tests 88 passed (88)`.
  - **Tracer gate:** after the lint-staged format, the verify was re-run with registry-parity: `Tests 42 passed (42)`, EXIT=0. "Tracer verified end-to-end — expanding."
- **Task 2 verify** (admin, wake, manifest, host-wake, plus registry-parity): `Test Files 5 passed (5)`, `Tests 72 passed (72)`. TC_cli=0, TC_node=0.
- **Task 3 verify:** wake + serve-autostart gave `Test Files 2 passed (2)`, `Tests 69 passed (69)`. TC_cli=0.
  - **serve-autostart.test.ts pass count:** 35 before any edit, 35 after.
  - `git diff --quiet HEAD -- src/cli/runtime/serve-autostart.test.ts` exit 0.
  - `Select-String ... serve-autostart.ts -Pattern 'function assertLocalInvocation'`: 0 hits. The only definition is `src/cli/runtime/local-invocation.ts:5`.
  - CLI neighbours (manifest, registry-parity, index, agent-context, vocabulary-policy): `Test Files 5 passed (5)`, `Tests 57 passed (57)`.

### Plan verification block (final tree, HEAD bc5f570ae)

- Plan vitest over 5 files (host-wake-admin, wake, handler-group-manifest, serve-autostart, host-wake): `Test Files 5 passed (5)`, `Tests 117 passed (117)`, EXIT=0.
- Neighbours: `Test Files 7 passed (7)`, `Tests 59 passed (59)`, EXIT=0. The seven were:
  - serve-electron-flag-parity
  - effect-class-registry
  - mobile-rpc-allowlist
  - registry-parity
  - wake-magic-packet
  - wake-broker-store
  - shared host-wake
- TC_node=0, TC_cli=0, TC_web=0.
- `git diff --quiet 073bc8050 -- src/cli/serve-electron-flag-parity.test.ts src/main/runtime/rpc/effect-class-registry.test.ts src/cli/runtime/serve-autostart.test.ts` exit 0. The protected tests are unmodified and green.
- `host.wake.admin` in runtime-rpc.ts (the mobile allowlist): 0 hits.
- Revoke and device-list methods: a sweep of `rpc/methods/*.ts` for `revokeMobileDevice|revokeRuntimeAccess|listDevices` hits only `emulator.listDevices`, which is unrelated. No device-revoke RPC and no device-list RPC were added.

## What the tests pin (fails_when coverage)

**Local-only boundary**
- Each of the six admin methods is refused for each of four remote stamps: clientId, pairedDeviceId, clientKind `runtime` and connectionId.
- After every refusal, the store reloaded from disk is unchanged.

**Validation at two layers**
- The method schema rejects:
  - a 5-octet or non-hex MAC;
  - a broadcast of `example.com` or `::1`;
  - port 0 or 65536;
  - a 65-character label, or a label containing NUL.
- The CLI fails fast on the same inputs, with no call.

**Target ids**
- Ids match `wt_` + 12 hex characters.
- The same MAC added twice gets two different ids, and neither contains MAC octets.

**Grants**
- A grant for an unknown or revoked device is refused with `wake_device_unknown` and nothing is stored.
- With no authority attached, the refusal is `wake_broker_unavailable`. An unregistered target is refused with `wake_target_unknown`.

**Grant removal reaches the effect**
- A real broker wakes once: 1 frame.
- `grantRemove` returns `{ removed: true }`, then `{ removed: false }`.
- The device's next `host.wake.request` is refused with `wake_grant_missing`, and the frame count stays at 1.

**Target removal**
- `targetRemove` drops the target and its grants, in memory and on disk. The other target and its grant survive.
- An unknown id is refused with `wake_target_unknown`.

**No MAC in grant output**
- `grantList` and `grantAdd` results do not match a MAC pattern.

**CLI**
- Each verb makes exactly one call, to the right method with the right params.
- A missing `--broadcast` prints one stderr hint that recommends the subnet-directed broadcast.
- An unreachable runtime yields `wake_broker_unreachable` naming `orca serve --wake-broker`.
- `wake_broker_disabled` gets the same fix appended.
- `wake_device_unknown` names where device ids come from.

**Relay**
- All six handlers refuse `ORCA_CLI_CWD` with zero calls.
- An empty `ORCA_CLI_CWD` still reaches the runtime (positive control).

## Device-id path (Task 2 read_first)

There is no existing CLI or RPC that lists paired device ids. Grep evidence:

- `src/cli/specs`: the only `devices` path is `emulator devices`.
- `rpc/methods`: no method named `*Device*` / `*Pairing*` lists paired devices. The only matches are `browser.setDevice`, `emulator.listDevices`, `pairing.getEndpoints` and `pairing.provisionRelay`.
- The paired-device list is reachable only through Electron IPC (`src/main/ipc/mobile.ts:204 mobile:listDevices`).
- `status.get` returns `pairedDeviceId` to the calling device (`rpc/methods/status.ts:13`).

So the `wake_device_unknown` hint and the `grant add` notes name those two sources. **Named residual: no CLI device listing.** A serve-only broker host has no desktop Settings window, so there the Owner reads the id from the device's own `status.get` answer. No device-listing method was added (law and plan).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] specs/core.ts is at its max-lines cap**
- **Found during:** Task 1 commit. oxlint reported `src/cli/specs/core.ts ... max-lines: File has too many lines (302). Maximum allowed is 300.`
- **Fix:** `WAKE_COMMAND_SPECS` is spread into `COMMAND_SPECS` in `src/cli/specs/index.ts`, right after `CORE_COMMAND_SPECS`. specs/core.ts is unchanged, and no max-lines disable was added.
- **Commit:** be0eff939

**2. [Rule 3 - Blocking] The CLI cannot import the broker's MAC rule**
- **Issue:** The CLI cannot import `normalizeMac` from `src/main/runtime/wake-magic-packet.ts`, because tsconfig.cli.json does not include it and that module pulls in `node:dgram`.
- **Fix:** `normalizeMac`, `isWakeTargetLabel`, `WAKE_DEFAULT_BROADCAST`, `WAKE_DEFAULT_PORT` and `WAKE_TARGET_LABEL_MAX` now live in `src/shared/host-wake.ts`. wake-magic-packet.ts re-exports `normalizeMac`, so the store and the broker are unchanged. The CLI, the method schema and the store all use the same rule.
- **Commit:** be0eff939

**3. [Rule 2 - Security] Remote retargeting is refused, not only the relay**
- **Issue:** The runtime client honours `--environment` / `--pairing-code` and `ORCA_ENVIRONMENT` / `ORCA_PAIRING_CODE`. Without a guard, `orca wake` could address another host's runtime. That runtime would refuse it as non-local, but it is the wrong host to ask.
- **Fix:**
  - `wake` is in `shouldIgnoreRemoteSelection` (src/cli/index.ts).
  - The handlers refuse both flags, and a client with `isRemote`, using `remote_invocation_refused`.
- **Commit:** bc5f570ae

**4. [Interface] The relay guard takes a command label**
- **Issue:** `assertLocalInvocation` gained an optional `command` label. A message moved verbatim would tell a wake user about "orca serve autostart install/remove".
- **Fix:** The default is the original serve-autostart text, so its two call sites and its message are identical. serve-autostart tests: 35/35, file unmodified.
- **Commit:** bc5f570ae

**5. [Interface] Handlers are built by a factory**
- `WAKE_HANDLERS = createWakeHandlers()` (env = `process.env`). Tests inject an env, as the plan intends.
- `target remove` takes the id positionally (`positionalArgs: ['target']`) or as `--target`.
- The `rm` aliases exist for `target remove` and `grant remove`, and both removals are marked `destructive`.

### Residuals (not fixed here, by plan or law)

- **No CLI device listing** (above).
- **grantAdd on an unavailable registry:** 19-03's `deviceExists` returns true while the device registry is absent or unavailable ("unknown is not absent", which protects the start-time prune). So a grant can be stored while the registry cannot judge. It authorizes nothing, because the broker re-judges the token at the request and again at the send. A stricter grant-time check needs a tri-state authority answer, which is a runtime-rpc.ts change.

### Notes

- lint-staged reformatted each commit. Three commits left a stale pre-format index, which was reset per the post-commit check; the final check was `cached=0 tree=0` every time.
- The first Task 1 commit attempt was rejected by the pre-commit oxlint (Deviation 1), and nothing was committed. The corrected commit is be0eff939.
- The gsd `state.advance-plan` / `update-progress` commands are not used on this STATE.md format. Current Position was edited by hand.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model:
- T-19-18 is pinned by the 4 remote stamps × 6 methods.
- T-19-19 is pinned by the 6 relay rows, the retarget rows and the remote-client row.
- T-19-20 is pinned by the schema rows and the CLI fail-fast rows.
- T-19-21 is pinned by `wake_device_unknown` and the effect-level `wake_grant_missing` row.
- T-19-22: the CLI only calls the running broker.
- T-19-23 is pinned by the no-MAC assertions on grant rows.

The admin methods are not on `MOBILE_RPC_METHOD_ALLOWLIST` (0 hits). A mobile-scope device therefore gets `forbidden` at dispatch, and a runtime-scope device gets `remote_caller_refused` from the method.

## Self-Check: PASSED

- All 6 created files exist on disk.
- All 6 commits are on `mobile/host-availability`: bf88aace7, be0eff939, 983a4df8e, 2033e4e9f, 5df4f0063, bc5f570ae.
- `git rev-list --count 073bc8050..HEAD` = 6.
- `actuals.tokens` is the plan diff size: 48074 chars / 4 ≈ 12000.
