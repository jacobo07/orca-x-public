---
phase: 19-wake-on-lan-capability-and-the-lan-wake-broker-m2
reviewed: 2026-10-27T00:00:00Z
depth: standard
diff_base: 490ee6849
files_reviewed: 30
files_reviewed_list:
  - config/durability-contracts.jsonc
  - config/host-card-claims.jsonc
  - src/cli/args.ts
  - src/cli/handler-group-manifest.ts
  - src/cli/handlers/core.ts
  - src/cli/handlers/wake.ts
  - src/cli/index.ts
  - src/cli/runtime/launch.ts
  - src/cli/runtime/local-invocation.ts
  - src/cli/runtime/serve-autostart.ts
  - src/cli/specs/index.ts
  - src/cli/specs/serve.ts
  - src/cli/specs/wake.ts
  - src/main/index.ts
  - src/main/runtime/host-availability-producer.ts
  - src/main/runtime/host-wol-probe.ts
  - src/main/runtime/host-wol-verdict.ts
  - src/main/runtime/orca-runtime.ts
  - src/main/runtime/rpc/errors.ts
  - src/main/runtime/rpc/methods/host-wake-admin.ts
  - src/main/runtime/rpc/methods/host-wake.ts
  - src/main/runtime/rpc/methods/index.ts
  - src/main/runtime/runtime-rpc.ts
  - src/main/runtime/wake-broker-host.ts
  - src/main/runtime/wake-broker-store.ts
  - src/main/runtime/wake-broker.ts
  - src/main/runtime/wake-magic-packet.ts
  - src/main/startup/serve-mode-argv.ts
  - src/shared/host-wake.ts
  - src/shared/protocol-version.ts
findings:
  critical: 0
  warning: 1
  info: 5
  total: 6
status: issues_found
fix_status: warnings_fixed
---

# Phase 19: Code Review Report

**Reviewed:** 2026-10-27
**Depth:** standard (plus targeted call-chain tracing into device-registry, device-authorization, secure-file, the SSH CLI passthrough and the WSL bridge)
**Files Reviewed:** 30 source files. Tests were read only to judge whether they can fail (`wake-broker.test.ts`).
**Status:** issues_found

## Summary

The authorization chain at the effect holds. `request` runs `judge` before any replay lookup (`wake-broker.ts:241`). The grant is checked before the target, so an ungranted device cannot probe for target ids (`:134-143`). Both `status` and `targetsFor` filter by grant, and an unknown wake id gets the same refusal code as one the device may not see (`wake_unknown`). The re-judge inside `sendWake` runs in the same tick as `deps.sendMagicPacket`. It does real work on the adopt-retry path (`startOrAdopt` after an in-flight failure), where time has passed since the first judge.

These checks found no defect:
- **Failed wakes are not replayed or adopted.** Both maps drop the pending entry on rejection (`:208-212`, `:251-255`).
- **Revoke purges grants.** `revokeAndTerminate` (runtime-rpc.ts:729-731) and the pending-device discard (runtime-rpc.ts:1064-1066) both call `dropWakeGrantsAfterRevoke`. `startWakeBroker` prunes grants of vanished devices at start, and `runtimeRpc.start()` attaches the authority before `startWakeBroker` runs (index.ts:3400 → 3422).
- **The MAC never reaches a phone.** `host.wake.targets` projects `{targetId, label}` only. Refusals carry no MAC. The admin methods are absent from the mobile allowlist (runtime-rpc.ts:377-379) and are refused server-side for any stamped caller (`isLocalRpcCaller`).
- **The SSH relay cannot clear the CLI's local-only gate.** `ssh-relay-session.ts:1374` defaults an empty cwd to `/`, so `ORCA_CLI_CWD` is never empty. `buildHostCliEnv` sets it after copying the remote env, so it cannot be overridden. The legacy in-process fallback (`ssh-remote-orca-cli.ts`) is a fixed command switch with no `wake` verbs. `shouldIgnoreRemoteSelection` includes `wake`.
- **Refusal codes reach the client.** All `HOST_WAKE_REFUSAL_CODES` are in `STRUCTURED_RUNTIME_PASSTHROUGH_CODES`, carrying `.data`.
- **Durability.** The state file is written with fsync before rename and a directory fsync after (`writeDurableSecureJsonFile`). Additions go to disk first and removals to memory first. A corrupt file is quarantined rather than published over. The contract entry lists the remaining gaps honestly.
- **No process spawn uses a shell string.** All are `execFile` with argv. Linux interface names are filtered against a leading `-`, and the PowerShell script is a constant.
- **The UDP socket closes on every settle path.**
- **The wire change is additive.** The capability is only present when a broker is enabled (computed per `getStatus`), and there is no new stream opcode.

One warning: the grant-time device check fails open in exactly the state it claims to guard. The info items are edge-case honesty and consistency issues.

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: `grantAdd` device check fails open when the registry is unavailable, contradicting its own guard (T-19-21)

**File:** `src/main/runtime/rpc/methods/host-wake-admin.ts:113-116`, with the predicate at `src/main/runtime/runtime-rpc.ts:1313-1319`

**Issue:** `grantAdd` refuses with `wake_device_unknown` when `!authority.deviceExists(deviceId)`, and its comment says "an unknown or revoked device must not be planted ahead of the effect check". But the only `deviceExists` implementation answers **true** whenever the registry is missing or unavailable:

```ts
deviceExists: (deviceId) => {
  const registry = this.deviceRegistry
  return (
    !registry ||
    !registry.getAvailability().available ||
    registry.getDevice(deviceId) !== null
  )
}
```

That "unknown keeps the grant" rule is right for `pruneGrants` at start (wake-broker-host.ts:102). It is the wrong answer for granting, which needs "unknown refuses". The one predicate serves two callers that need opposite fail directions.

**Failure scenario:** `orca-devices.json` fails to load at broker start. `DeviceRegistry.load` sets `unavailableReason` and `devices = []` (device-registry.ts:328-347). Alternatively, a WS restart leaves `this.deviceRegistry = null` (runtime-rpc.ts:1295). The Owner then runs `orca wake grant add --device <typo-or-revoked-id> --target wt_…`. The call succeeds and writes a crash-durable grant for a device that does not exist, and the CLI prints "REMOTE_WAKE granted".

**Impact:** The grant stays inert today, because the effect re-judges the token. It is still a persisted authorization the guard promised never to write. It survives until a later broker start finds the registry readable and prunes it. If that id is ever paired, the grant is live without the Owner having granted it to that pairing.

**Why existing guards miss it:** The grant-time check is the guard in question. `addGrant` in the store only validates the id's length.

**Fix:** Give the authority a tri-state answer and fail closed at grant time:

```ts
// WakeDeviceAuthority
deviceState(deviceId: string): 'present' | 'absent' | 'unknown'

// grantAdd
const state = authority.deviceState(params.deviceId)
if (state === 'unknown') {
  throw hostWakeRefusal('wake_broker_unavailable', 'The device registry is unreadable; no grant was written.', { brokerState: 'device_registry_unavailable' })
}
if (state === 'absent') {
  throw hostWakeRefusal('wake_device_unknown', 'That device is not paired with this host.')
}

// pruneGrants keeps grants unless state === 'absent'
```

Add a test that drives `grantAdd` with an unavailable registry and expects a refusal with no publish. The current suite only covers an available registry.

## Info

### IN-01: A refusal at the effect re-judge leaves a record whose last stage is `authorized`

**File:** `src/main/runtime/wake-broker.ts:165-178` (record created at `:202`)

**Issue:** `sendWake` records `requested` and `authorized` *before* the effect-time `judge`. When that re-judge refuses (the adopt-retry path, after a revoke or grant removal), the refusal carries the stages. But the entry stays in `records` with no terminal stage. For up to `WAKE_STATUS_RETENTION_MS` (300 s), `host.wake.status` from any other device holding a grant for that target shows a wake that was "authorized" and never ends. A client renders that as "sending…".

The refusal paths are also inconsistent. The re-judge refusal includes `stages` (`:172-175`), but `wake_send_failed` includes only `{ wakeId, code }` (`:187-190`).

**Fix:** Record a terminal stage on the re-judge refusal. For example, push `packet-send-failed` with `code: error.code`, or add a broker-only `refused` stage to `BROKER_WRITABLE_STAGES`. Alternatively, delete the record. Include `stages` in the `wake_send_failed` data as well. The test at `wake-broker.test.ts:241` pins `['requested','authorized']` and would need the terminal stage added.

### IN-02: `orca wake` from WSL on the broker host is refused as "a remote SSH session"

**File:** `src/cli/runtime/local-invocation.ts:9-14`; `src/main/cli/wsl-cli-scripts.ts:86-90`

**Issue:** The WSL bridge sets `ORCA_CLI_CWD` to the WSL cwd. `assertLocalInvocation` treats any non-empty `ORCA_CLI_CWD` as the SSH relay, so an Owner sitting at the broker who runs `orca wake target list` inside WSL is refused with "must run in a shell on the Orca host itself, not through a remote SSH session". That is false: they are on the host. The refusal is safe, since it fails closed, but the message sends the Owner looking for an SSH session that does not exist.

**Fix:** Have the SSH passthrough stamp a dedicated marker (for example `ORCA_CLI_VIA_SSH_RELAY=1` in `buildHostCliEnv`) and key the refusal on that. If WSL is also meant to be refused, keep the `ORCA_CLI_CWD` check and name the WSL case in the message.

### IN-03: The WOL probe spawns `powershell.exe` and `powercfg.exe` by bare name

**File:** `src/main/runtime/host-wol-probe.ts:104-110`

**Issue:** On Windows, libuv resolves a bare executable name from the current directory before `PATH`. Elsewhere the repo deliberately pins system tools (`getWindowsSystemToolPath('WindowsPowerShell\\v1.0\\powershell.exe')` in `src/shared/secure-path-windows-acl.ts:51`). Two things mitigate this: `orca serve` pins the child cwd to the app root (`src/cli/runtime/launch.ts:138`), and the pattern copies the existing `host-autostart-probe.ts:120`. So this is a consistency and hardening note, not an exploitable path found in this diff.

**Fix:** Resolve both binaries through `getWindowsSystemToolPath` (`System32\\powercfg.exe`, `WindowsPowerShell\\v1.0\\powershell.exe`), here and in the autostart probe.

### IN-04: A quarantined state file turns into an empty broker on the next start with no hint, and a future schema is treated as corrupt

**File:** `src/main/runtime/wake-broker-store.ts:91-93, 241-252`; `src/main/index.ts:3423-3426`

**Issue:** The first start after corruption correctly reports `unavailable (wake_broker_state_unreadable)`. But the rename moves the file away, so the next start takes the "no file" branch and prints `wake broker: enabled (0 targets)`. Nothing points at the `.corrupt-<ts>` file. For grants, empty is the least-privilege direction, so this is not a security defect. It is the "failure collapsing into empty" shape AGENTS.md names, delayed by one restart.

Separately, `parseState` returns `null` for `schema !== 1`. A file written by a newer Orca (schema 2) and then read by an older serve binary on the same userData would be quarantined. On re-upgrade, the targets and grants are gone.

**Fix:** On load, when `orca-wake-broker.json` is absent but a `orca-wake-broker.json.corrupt-*` sibling exists, include it in the startup line or the `targetCount` answer. Return a distinct `wake_broker_state_newer_schema` (leave the file in place, fail closed) when `schema` is a number greater than `STATE_SCHEMA`.

### IN-05: `commitAddition` assumes a throwing publish wrote nothing, but `writeSecureFile` can throw after the rename

**File:** `src/main/runtime/wake-broker-store.ts:123-126`; `src/shared/secure-file.ts:122-129, 210`

**Issue:** "Disk first" is only correct if a publish that throws left the old file in place. On POSIX, `writeSecureFile` can throw *after* `renameSync`: from `chmodSync` (via `applySecurePathRestriction` at `:124`/`:210`) or from a directory-fsync error that is not in `UNSUPPORTED_DIRECTORY_FSYNC_CODES` (`:128`, `:157-163`). In that case `addGrant` or `addTarget` reports an error to the CLI and memory does not hold the addition, but the file does. The next restart activates a grant the Owner was told failed. This is rare (EIO/EPERM after a successful rename). It is listed because the store's comment states the invariant as unconditional.

**Fix:** In `commitAddition`, on a publish error, re-read and parse `statePath`. Adopt it if it equals `next`, or surface a distinct `wake_broker_state_indeterminate` code. Alternatively, document this in the `knownGaps` of `runtime.wake-broker-state` next to the existing removal-window gap.

---

## Fix Log

Scope: Critical + Warning (no criticals). IN-01..IN-05 left open.

### WR-01: FIXED

- **RED** `cab270fb0` (test(19): WR-01 RED). Five tests failed before the fix: `wakeDeviceState` x2, prune keeps grants with no prune error, `grantAdd` refused on an unreadable registry, and the positive control (a present device's grant is persisted).
- **GREEN** `b88f111c5` (fix(19): WR-01). `WakeDeviceAuthority.deviceExists` (boolean) was replaced by `deviceState: 'present' | 'absent' | 'unknown'`, computed by the pure `wakeDeviceState(registry, deviceId)` in `wake-broker.ts`. `runtime-rpc.ts` now calls it with its live registry. `grantAdd` refuses `absent` with `wake_device_unknown`, and refuses `unknown` with `wake_broker_unavailable` (`brokerState: device_registry_unavailable`). `startWakeBroker` prunes only on `absent`. Every caller and fixture of `deviceExists` was updated, including the wiring source assertion.
- **Refusal code:** `wake_broker_unavailable` was chosen because it already means "the broker cannot judge right now", the same code used for a missing device authority. It also passes through `STRUCTURED_RUNTIME_PASSTHROUGH_CODES` with `.data`, so no protocol change was needed.
- **Verification ran in the main checkout C:\owx-haf, with no worktree:**
  - vitest across 7 files (`host-wake-admin`, `wake-broker-host`, `wake-broker-wiring`, `wake-broker-revoke-in-process`, `wake-broker`, `host-wake`, `wake-broker-store`): `Test Files  7 passed (7)` / `Tests  83 passed (83)`.
  - `typecheck:node`: exit 0.
  - `check:durability-contracts`: passed (22 contracts, no new publishers).

## REVIEW COMPLETE

critical: 0 · warning: 1 · info: 5 · total: 6

_Reviewed: 2026-10-27_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
