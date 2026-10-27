# Phase 19: Wake-on-LAN capability and the LAN Wake Broker (M2) - Research

**Researched:** 2026-10-27
**Domain:** Electron main / headless `orca serve` runtime RPC, Node `dgram`, OS power-management probes, durable state, mobile host card
**Confidence:** HIGH for in-repo integration points (read this session); MEDIUM for OS probe output shapes (training knowledge, needs live legs); LOW for Linux `ethtool` privilege behaviour.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
Copied verbatim from `19-CONTEXT.md` `<decisions>`:

#### WOL capability measurement (SC1)
- D-01: A host-side probe measures WOL per platform, read-only:
  - Windows: `Get-NetAdapterPowerManagement` (WakeOnMagicPacket per adapter) and
    `powercfg /devicequery wake_armed` (OS arming).
  - Linux: `ethtool <if>` `Wake-on:` line, or `/sys/class/net/<if>/device/power/wakeup`.
  - macOS: `pmset -g` `womp`.
- D-02: Firmware (BIOS "Resume by PCI-E / LAN", ErP) cannot be read from the OS. The verdict maps to the phase 18
  capability vocabulary:
  - no wake-capable wired adapter: `not-supported`;
  - driver allows magic packet but the OS has not armed it: `needs-owner-setup`, reason `os_not_armed`
    (Owner step a);
  - driver and OS armed: `unknown`, reason `firmware_unverified`;
  - probe failed or unreadable: `unknown` with the probe's reason.
  `supported` only with evidence of an observed wake: a host-announced resume after a packet this broker sent.
  Never `supported` from configuration alone.
- D-03 (rec): The probe runs off the hot path (at startup and on a slow refresh), owns no new recurring timer
  unless classified in `config/recurring-work-inventory.jsonc`, and degrades to `unknown` on Linux/SSH/WSL hosts
  where the tool is missing. Spawned binaries go through the existing process helpers (no shell strings).

#### Broker role and target registry (SC2)
- D-04: The broker is a role of any paired Orca host (brief decision 5), enabled explicitly (e.g.
  `orca serve --wake-broker`), never by default. A host that is not a broker refuses wake requests with a
  distinct code (`wake_broker_disabled`).
- D-05 (rec): Wake targets (MAC, broadcast address, port, optional label) live only on the broker. The Owner
  registers them locally on the broker through a CLI (`orca wake target add|remove|list` or equivalent). MACs are
  never sent to the phone and never appear in `status.get` to the phone. The phone names a target by the
  broker-issued target id.
- D-06: The magic packet is the standard frame (6 x 0xFF + 16 x MAC) sent by Node `dgram` UDP broadcast
  (default port 9). No native module, no shell.

#### Grant, authorization and idempotency (SC2)
- D-07: `REMOTE_WAKE` is a grant per device, per target, stored on the broker and separate from pairing and
  from `DeviceScope`. Pairing alone never implies wake. Issuing a grant is a local Owner act on the broker (CLI).
  There is no phone-side grant surface.
- D-08: Every wake request is judged at the effect:
  - device token through `assertDeviceStillAuthorized` (revoked refuses, `device_revoked`);
  - grant present, else `wake_grant_missing`;
  - target registered, else `wake_target_unknown`.
  Refusal codes are disjoint from any code a shipped client treats as fall back.
- D-09: Each request carries an idempotency id. The broker keeps a dedupe window (rec 60 s) keyed by
  (target, idempotency id) that replays the original result. Within a short per-target window, a different
  request id adopts the in-flight wake instead of sending a second burst.
- D-10: Persisted broker state (targets, grants) gets a durability contract in
  `config/durability-contracts.jsonc`. Grants are `crash-durable` through `durable-file-write.ts`, since losing a
  revoke is a security defect. Revoking a device drops its grants.

#### Evidence-staged readiness (SC2, SC3)
- D-11: A wake request returns and reports stages, never a single "woken":
  - `requested`, `authorized`, `packet-sent` (broker only; the dgram send callback succeeded);
  - `host-announced` (the target's Host Service answered `status.get` or reconnected);
  - `runtime-ready` (the target's runtime status is ready).
  A broker never reports `host-announced` from its own send. The law: a wake packet sent is not a host woken.
- D-12 (rec): The new RPC (e.g. `host.wake.request`, plus a stage read `host.wake.status`) is additive and behind
  a new runtime capability string (e.g. `host.wake-broker.v1`), following
  `docs/reference/remote-wire-compatibility.md`: optional fields only, no new stream opcode.

#### Mobile projection
- D-13 (rec): The host card may show a Wake control only when all three hold: a broker announces it this
  session, the target capability is not `not-supported`, and the request is a real RPC. The control is
  classified in `config/host-card-claims.jsonc` with a backend effect, so `check:host-card-claims` still passes
  with the new control and the P18 mutants still catch. Wake progress is shown by stage and never as "On"
  until `host-announced`. If wiring the card proves larger than the slice, the control is deferred and the
  SCRIPTED CLIENT drives the RPC; that is recorded, not hidden.

#### Proof and laws (SC3)
- D-14: Autonomous proof on a disposable serve host, labelled SCRIPTED CLIENT:
  - refused without a grant, refused for a revoked device, accepted with a grant;
  - a duplicate request sends exactly one packet;
  - a UDP listener positive control captures the exact 102-byte frame for the registered MAC;
  - the stages stop at `packet-sent` when no target answers.
  Mutants (grant check skipped, dedupe off, packet-sent reported as host-announced) are PLANT_CONFIRMED, CAUGHT,
  RESTORE_VERIFIED.
- D-15: LAN Product Reality (host sleeping, wake, Host Service reconnects, terminal works) is OWNER_BOUND:
  - Owner step (a), elevated `powercfg /deviceenablewake`;
  - Owner step (b), BIOS Resume by PCI-E/LAN and ErP off;
  - Owner step (c), an always-on LAN node to run the broker while the target sleeps. The measured LAN has none.
  The WOL probe is run read-only on this machine and its verdict recorded as measured. Nothing here sleeps the
  Owner's PC.
- D-16: Mobile tests run on GEX44 in a disposable root (STATE.md recipe). Node-side tests run here as single
  files. Never push. No Owner-PC effects.

### Claude's Discretion
File and module names, exact RPC names, CLI verb shape, dedupe window length, stage vocabulary spelling, and how
the target id is minted.

### Deferred Ideas (OUT OF SCOPE)
- Host pre-suspend announcement as evidence for `sleeping` (powerMonitor `suspend`), so the card can say
  "asleep (announced)" (phase 20, or a later slice).
- Broker discovery and target auto-registration over the LAN.
- Off-LAN wake through the relay, `can-wake-remote` (phase 20).
- Proving S5 wake with Fast Startup off (M4, phase 20).
</user_constraints>

## Project Constraints (from CLAUDE.md / AGENTS.md / STATE.md)

- **Durable State** (AGENTS.md): persisted state that a crash could destroy needs a contract in
  `config/durability-contracts.jsonc`; `crash-durable` writes route through `src/main/durable-file-write.ts` or the
  durable variants of `src/shared/secure-file.ts`, plus a syscall-order proof. `pnpm check:durability-contracts`
  fails a new unclassified temp-file-and-rename publisher. Watch the three named failure shapes, especially
  "failure collapsing into empty".
- **Recurring Work** (AGENTS.md): any timer/poll/watcher/retry must be classified in
  `config/recurring-work-inventory.jsonc`; `pnpm check:recurring-work` finds them. Prefer request-driven reads.
- **Remote Wire Compatibility**: additive optional fields only; new behaviour behind a runtime capability; a new
  method name fails closed on old hosts with `method_not_found`, which a client must never turn into a fallback
  effect.
- **Effect authority across transports** (`~/.claude/rules`): the check lives at the effect boundary, keyed by
  subject (target), not by requester; refusals get their own codes disjoint from fallback codes; automatic
  callers never inherit an interactive override.
- **Detach, Stop, Cancel** (AGENTS.md): "An RPC that launches or mutates an Execution declares `effect: 'launch'`".
- **SSH and folder-workspace use cases**: changes must consider SSH hosts; CLI commands invoked through the SSH relay
  bridge carry `ORCA_CLI_CWD` and must not plant host-persistent effects (phase 17 precedent).
- **Naming**: no `helpers`/`utils`/`common` file names; prefer `.ts` over `.d.ts`; one-line non-obvious comments only;
  never disable `max-lines`.
- **Cross-platform**: macOS, Linux, Windows behind runtime checks; `path.join`, never assume separators.
- **STATE.md laws**: laptop has 8 GB; only single vitest files here; no full suite, no build, no emulator here;
  heavy and mobile runs on GEX44 in a disposable root (`/tmp/orca-*`), torn down; git through PowerShell only;
  never push; no Owner-PC effects.
- **Workspace Surface Claims / host-card claims**: no control without a backend effect; unreachable is not powered off.

## Summary

Phase 19 is almost entirely an assembly of patterns this repo already has. The WOL probe is a sibling of the phase
17/18 autostart probe (`src/main/runtime/host-autostart-probe.ts`): an injected `exec`, a request-driven cache with
a max age and no timer, registered into `hostAvailabilityProducer` from both host start paths in
`src/main/index.ts`. The broker is a new RPC method group (`src/main/runtime/rpc/methods/host-wake.ts`) that sits
behind the existing dispatch-time device check (`runtime-rpc.ts:1752-1798`) and repeats
`assertDeviceStillAuthorized` at the moment of the send, as D-08 requires. Its state lives in one userData JSON file
written with `writeDurableSecureJsonFile`, the same primitive the device registry uses.

The non-obvious traps, found by reading code: (1) refusal codes thrown from a handler collapse into `runtime_error`
unless they are added to `STRUCTURED_RUNTIME_PASSTHROUGH_CODES` in `src/main/runtime/rpc/errors.ts`; (2) mobile-scope
devices can only call methods listed in `MOBILE_RPC_METHOD_ALLOWLIST` (`runtime-rpc.ts:238`), so the phone methods
must be added there and the admin methods must stay off it; (3) runtime-scope paired devices bypass that allowlist,
so admin methods (target and grant edits) must refuse any caller that is not local (`isLocalRpcCaller`), and the CLI
must refuse an SSH-relay invocation (`ORCA_CLI_CWD`) as phase 17 did; (4) in `check-host-card-claims.mjs`, a single
effect control disables the card-wide effect-wording check (`:427-436`). Adding a Wake control without tightening
that rule weakens the P18 gate.

**Primary recommendation:** build in four slices. (A) WOL probe feeds `can-wake-lan`. (B) Broker core: a pure
service with injected clock, sender, store and authorizer, plus dedupe, adoption and stages, with full unit tests.
(C) RPC, capability, durability contract and CLI wiring (`orca wake target|grant ...`, `orca serve --wake-broker`),
plus a SCRIPTED CLIENT leg on a disposable serve host with a loopback UDP positive control. (D) Defer the mobile Wake
control under D-13's escape clause, and record that in the phase summary. Only update the claims config where the
probe's new evidence requires it.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| WOL capability measurement | Host main process (`src/main/runtime`) | OS tools (PowerShell, powercfg, ethtool, pmset) | Only the host can read its own adapters; read-only, off the hot path |
| `can-wake-lan` announcement | Host main (`host-availability-producer.ts`) | `status.get` RPC | One shared producer for serve and desktop (phase 18) |
| Wake target and grant registry | Broker host main + userData file | CLI (local only) | D-05/D-07: MACs and grants never leave the broker |
| Wake authorization | Broker RPC handler (effect boundary) | Dispatch-time device gate | D-08: judged at the effect, keyed by target and device |
| Magic packet send | Broker main (`dgram`) | — | D-06: no shell, no native module |
| Stage composition (host-announced, runtime-ready) | Client (phone or scripted client) | Shared pure module | The broker cannot observe the target's Host Service; D-11 forbids it inferring that |
| Wake control on the card | Mobile (deferred, see §6) | — | Cross-host mapping is larger than the slice |

## Standard Stack

No new packages. Everything uses Node built-ins and in-repo modules.

| Module | Source | Purpose |
|--------|--------|---------|
| `node:dgram` | Node built-in | UDP broadcast of the magic packet |
| `node:child_process` `execFile` | Node built-in, wrapped as in `host-autostart-probe.ts:39-60` | Probe spawns with argv, no shell |
| `zod` | already used by every RPC method (`core.ts` `ZodType`) | Param validation |
| `src/shared/secure-file.ts` `writeDurableSecureJsonFile` | in repo (`:95-97`) | Crash-durable, ACL-hardened publish |
| `src/main/runtime/device-authorization.ts` | in repo | Effect-time device judgement |

**Installation:** none.

## Package Legitimacy Audit

No external packages are installed in this phase. `dgram` and `child_process` are Node core modules.
**Packages removed due to [SLOP] verdict:** none. **Packages flagged as suspicious [SUS]:** none.

## 1. WOL probe and `can-wake-lan`

### Evidence
- The producer hard-codes the value today: `'can-wake-lan': { value: 'not-configured', reason: 'no_wake_broker', evidence: announced }`
  `[VERIFIED: src/main/runtime/host-availability-producer.ts:103-108]`.
- `HostAvailabilitySources` is `{ processKind; relayReadiness: () => HostRelayReadiness; webSocketEndpoint: () => string | null; autostart: { read: () => HostCapability } }`
  `[VERIFIED: host-availability-producer.ts:8-13]`.
- Both start paths register the producer and prime the probe:
  serve `hostAvailabilityProducer.register({ processKind: 'serve', ..., autostart: hostAutostartProbe })` then
  `hostAutostartProbe.read()` `[VERIFIED: src/main/index.ts:3403-3410]`; desktop the same with `processKind: 'desktop'`
  `[VERIFIED: src/main/index.ts:3506-3513]`. The probe is built once at module scope:
  `const hostAutostartProbe = createHostAutostartProbe(defaultHostAutostartProbeDeps())` `[VERIFIED: index.ts:440]`.
- The reuse pattern is `host-autostart-probe.ts`. It injects deps `{ platform, env, now, exec(file, args, {env}) }`
  (`:19-31`). `execFile` runs with `{ timeout: EXEC_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }` and maps a spawn
  error to `code: -1` (`:39-60`). It refreshes on demand: `read()` starts a refresh when `completedAt === null || now - completedAt >= AUTOSTART_STATUS_MAX_AGE_MS`
  and returns the cached value (`:145-157`). `AUTOSTART_STATUS_MAX_AGE_MS = 300_000` (`:14`). The comment
  `// Why no timer: reads are request-driven and bounded to one PowerShell per max age per process (R4).` (`:106`).
  The CLI copy uses the same `execFile` wrapper in `src/cli/runtime/serve-autostart.ts:64-85`
  `[VERIFIED: both files read this session]`.
- Evidence kinds available: `'live-response', 'transport-observed', 'host-announced', 'relay-reported', 'os-probe'`
  `[VERIFIED: src/shared/host-availability.ts:3-9]`. Values:
  `'supported', 'not-supported', 'not-configured', 'needs-owner-setup', 'unknown'` `[VERIFIED: host-availability.ts:155-161]`.

### Recommendation
Create `src/main/runtime/host-wol-probe.ts` exporting `createHostWolProbe(deps): { read(): HostCapability; settled(): Promise<void> }`
and `defaultHostWolProbeDeps()`. Structure it like `createHostAutostartProbe`: the same `exec` dep type, `now`, `platform`,
plus `readFile` for the sysfs path. Extend `HostAvailabilitySources` with `wakeOnLan: { read: () => HostCapability }`
and replace the hard-coded `can-wake-lan` with `sources?.wakeOnLan.read() ?? unknownCapability('wol_reader_unregistered')`.
Register it at both `index.ts:3403` and `:3506`, and prime it right after `hostAutostartProbe.read()`.
`can-wake-remote` stays `not-configured / no_wake_broker` (phase 20).

Split it into a pure parser module (`host-wol-verdict.ts`: platform output to `HostCapability`) and the spawning
probe. The parser then gets table tests without spawning anything.

**Per platform (one fixed argv each, no interpolation):**

| Platform | Spawn | Parse | Verdict mapping (D-02) |
|----------|-------|-------|------------------------|
| win32 | `powershell.exe -NoProfile -NonInteractive -Command <static script>`. The script runs `Get-NetAdapter -Physical` and joins it with `Get-NetAdapterPowerManagement`, selects `Name, InterfaceDescription, MediaType, WakeOnMagicPacket`, then `ConvertTo-Json -Compress`. Then `powercfg.exe /devicequery wake_armed` as a second execFile | JSON (language independent); powercfg prints one device friendly name per line | no physical 802.3 adapter with `WakeOnMagicPacket` Enabled: `not-supported` / `no_wake_capable_adapter`. Enabled, but no `wake_armed` line equals its `InterfaceDescription`: `needs-owner-setup` / `os_not_armed`. Both: `unknown` / `firmware_unverified`. Spawn or parse failure: `unknown` / `wol_probe_unreadable` |
| linux | list `/sys/class/net/*` entries that have a `device` link (physical) and are not `lo`; per interface `ethtool <if>`; fallback `readFile(/sys/class/net/<if>/device/power/wakeup)` | `Supports Wake-on:` contains `g`, and `Wake-on:` contains `g` | supports-g none: `not-supported`; supports-g but Wake-on `d`: `needs-owner-setup`/`os_not_armed`; g armed: `unknown`/`firmware_unverified`; ethtool ENOENT or EPERM with no sysfs answer: `unknown`/`wol_tool_unavailable`; no physical NIC (WSL, container): `unknown`/`wol_not_observable` |
| darwin | `pmset -g` | line `womp <0|1>` | 1: `unknown`/`firmware_unverified`; 0: `needs-owner-setup`/`os_not_armed`; line absent: `unknown`/`womp_not_reported` (absence is not evidence of no hardware) |

Use evidence `{ kind: 'os-probe', observedAt }` on every non-unknown verdict, and `evidence: null` on unknown. That
mirrors `capabilityFromStatus` (`host-autostart-probe.ts:78-93`).

Never emit `supported` in this phase. D-02 needs an observed wake (a host-announced resume after a broker packet).
Under D-15 that observation is OWNER_BOUND, and the target host has no channel to learn which broker sent a packet.
The verdict type therefore has no `supported` branch at all. Record that in the summary.

### Recurring work
No new timer: the refresh is request-driven with a max age (`status.get` calls `describe()` calls `read()`). That is
the same justification as the autostart probe. `check:recurring-work` sweeps timer, interval and watcher sites
(inventory fields are documented at `config/recurring-work-inventory.jsonc:7-19`: `responsibility, cadence,
lifetime, scaling, hidden, dormant, spawns, disposition, bound, note`) `[VERIFIED: read this session]`. A cache with
no `setTimeout` or `setInterval` creates no site. If the plan adds any timer (for example an adoption-window expiry),
it must be classified. Prefer lazy pruning on the next request so none is created. Recommended max age: 10 min,
since adapter arming changes only through an Owner act.

### Windows caveats
- `Get-NetAdapterPowerManagement` may need elevation on some builds `[ASSUMED]`. The brief measured the values, but
  the session's elevation is unknown. The live leg (below) settles it; if unelevated reads fail, the verdict is
  `unknown`/`wol_probe_unreadable`, never `not-supported`.
- `powercfg /devicequery wake_armed` lists friendly names. Brief: on this machine it lists only HID devices
  (`19-CONTEXT.md` specifics), so the expected live verdict here is `needs-owner-setup`/`os_not_armed`.
- Fast Startup (on, per the brief) affects S5 wake only. That is phase 20; do not fold it into the verdict.

## 2. RPC registry, auth context, capability

### Evidence
- Method shape: `defineMethod({ name, params: ZodType | null, handler(params, ctx), effect? })`. `RpcMethodEffect = 'launch'`
  is the only effect `[VERIFIED: src/main/runtime/rpc/core.ts:114-140]`. A `launch` method receives `waitSignal`
  instead of `signal`, so a socket close does not abort it: `return 'effect' in method && method.effect === 'launch' ? { waitSignal: signal } : { signal }`
  `[VERIFIED: core.ts:184]`.
- Method groups are exported arrays spread into the registry: `import { STATUS_METHODS } from './status'` and
  `...STATUS_METHODS,` `[VERIFIED: rpc/methods/index.ts:2,54]`. `host.*` names already exist: `host.platform`,
  `host.wsl.isAvailable`, `host.wsl.listDistros`, `host.pwsh.isAvailable`, `host.gitBash.isAvailable`
  `[VERIFIED: rpc/methods/host-capabilities.ts:8-32]`.
- `RpcContext` fields relevant here: `clientId?: string` ("paired mobile device token"), `pairedDeviceId?: string`,
  `clientKind?: 'mobile' | 'runtime'`, `clientCapabilities?`, `connectionId?` `[VERIFIED: core.ts:64-82]`.
- The WebSocket dispatch path authorizes before dispatch and fills the context:
  `const authorization = this.deviceRegistry ? assertDeviceStillAuthorized(this.deviceRegistry, token) : null`; on
  failure it replies `unauthorized` with `deviceRefusalDetail(...)`; then
  `if (device.scope === 'mobile' && !MOBILE_RPC_METHOD_ALLOWLIST.has(request.method))` replies `forbidden`
  `[VERIFIED: src/main/runtime/runtime-rpc.ts:1766-1786]`. The context passed to dispatch includes
  `clientId: token, pairedDeviceId: device.deviceId, clientKind: device.scope, clientCapabilities: authenticatedSocket?.clientCapabilities`
  `[VERIFIED: runtime-rpc.ts:1846-1855]`. The allowlist begins `const MOBILE_RPC_METHOD_ALLOWLIST = new Set([` at
  `runtime-rpc.ts:238` and contains `'host.platform'` (`:374`) and `'status.get'` (`:470`) `[VERIFIED]`.
- `assertDeviceStillAuthorized(registry, token)` returns `{ ok: true, device } | { ok: false, reason: 'device_revoked' | 'unknown_token' | 'registry_unavailable' }`
  `[VERIFIED: src/main/runtime/device-authorization.ts:3-29]`.
- Local caller test: `isLocalRpcCaller(ctx)` is false when any of `ctx.pairedDeviceId || ctx.clientKind || ctx.clientId || ctx.connectionId`
  is set, or when there is a non-local fingerprint `[VERIFIED: src/main/runtime/rpc/local-rpc-caller.ts:8-16, seen via grep -A output]`.
  Precedent refusal: `throw new OrchestrationError('remote_caller_refused', 'mission-place is local-only.')`
  `[VERIFIED: rpc/methods/orchestration-mission.ts:62-63]`.
- Error mapping: `mapRuntimeError` passes a thrown error's `.code` through only if the code is in one of the
  passthrough sets. `STRUCTURED_RUNTIME_PASSTHROUGH_CODES` (`errors.ts:82-139`) already holds `'remote_caller_refused'`,
  `'capability_unsupported'` and `'invalid_argument'`. Anything else becomes `errorResponse(id, meta, 'runtime_error', message)`
  `[VERIFIED: src/main/runtime/rpc/errors.ts:141-211]`.
- Capability constants: `export const HOST_AVAILABILITY_RUNTIME_CAPABILITY = 'host.availability.v1' as const`
  (`protocol-version.ts:150`), listed in the static `RUNTIME_CAPABILITIES` (`:193`). Runtime-conditional precedents
  are documented in comments: `browser.headless.v1` "Advertised only when that backend is actually available" and
  `conversations.v1` "advertised only once the host has wired its conversation service"
  `[VERIFIED: src/shared/protocol-version.ts:64-71]`.
- Name collision check: no `host.wake`, `wake-broker`, `wakeBroker` or magic-packet code exists under `src/`. The only
  `dgram`-or-similar hit is `src/main/ipc/developer-permissions.ts`, which is unrelated `[VERIFIED: grep this session]`.

### Recommendation
New file `src/main/runtime/rpc/methods/host-wake.ts` exporting `HOST_WAKE_METHODS`, spread into `methods/index.ts`.

| Method | Caller | Params (zod; Rule 1 strips unknown keys) | Result | Mobile allowlist |
|--------|--------|------|--------|--------|
| `host.wake.targets` | paired device | none | `{ targets: [{ targetId, label }] }`, only targets this device holds a grant for, never a MAC | add |
| `host.wake.request` (`effect: 'launch'`) | paired device | `{ targetId: string(1..64), requestId: string(8..128) }` | `{ wakeId, targetId, replayed: boolean, adopted: boolean, stages: WakeStageRecord[] }` | add |
| `host.wake.status` | paired device | `{ wakeId: string }` | `{ wakeId, stages }` (broker stages only) | add |
| `host.wake.admin.targetAdd/targetRemove/targetList` | local only | MAC, broadcast, port, label / targetId | target rows including MAC (local only) | never |
| `host.wake.admin.grantAdd/grantRemove/grantList` | local only | `{ deviceId, targetId }` | grant rows with device name | never |

Why `effect: 'launch'`: once authorized, a client disconnect must not cancel the send ("a client disconnect after
the effect started is not a release"). It also matches AGENTS.md's effect vocabulary. `[ASSUMED]`: no gate
currently enumerates `effect: 'launch'` methods and requires registration. Grep `effect: 'launch'` in `config/scripts`
during planning.

Effect-time authority inside `host.wake.request`, in this order:
1. Broker disabled: throw `wake_broker_disabled`.
2. No `ctx.pairedDeviceId` (a local caller): throw `wake_device_required`. Grants are per device (D-07); the local
   Owner path is out of scope.
3. `assertDeviceStillAuthorized(registry, ctx.clientId)`: not ok throws `device_revoked` (or `wake_device_unauthorized`
   for other reasons). Repeat it immediately before `send`, after any adoption wait. The dispatch-time check
   (`runtime-rpc.ts:1766`) is a separate, earlier moment.
4. Target lookup: missing throws `wake_target_unknown`. Grant lookup `(deviceId, targetId)`: missing throws
   `wake_grant_missing`. Order the checks so an ungranted device cannot probe which target ids exist: check the grant
   first and return `wake_grant_missing` for an unknown id too, or accept the enumeration risk explicitly. Recommend
   grant-first.
5. Dedupe and adopt (§5), then send.

Put the codes in `src/shared/host-wake-codes.ts`:
`WAKE_BROKER_REFUSAL_CODES = ['wake_broker_disabled', 'wake_broker_unavailable', 'wake_device_required', 'device_revoked', 'wake_device_unauthorized', 'wake_grant_missing', 'wake_target_unknown', 'wake_send_failed', 'wake_unknown']`.
Spread them into `STRUCTURED_RUNTIME_PASSTHROUGH_CODES`, or they arrive as `runtime_error`. Throw an `Error` with
`.code` and, where useful, `.data`.

The handler reaches the registry and the broker through a module-scope holder registered at startup. Precedent:
`hostAvailabilityProducer` at module scope (`host-availability-producer.ts:128-129`) is used by `status.ts:3`. The
`DeviceRegistry` is built inside `runtime-rpc.ts` (`deviceRegistry = new DeviceRegistry(this.userDataPath)` at
`:1198`), so register the broker's `authorize: (token) => assertDeviceStillAuthorized(registry, token)` and
`deviceExists` there. Keep the broker service itself free of the registry type, for tests.

**Capability:** `export const HOST_WAKE_BROKER_RUNTIME_CAPABILITY = 'host.wake-broker.v1' as const` in
`protocol-version.ts`. Make it **runtime-conditional**, not part of the static `RUNTIME_CAPABILITIES` array: it is
advertised only when `--wake-broker` is on, so "a broker announces it this session" (D-13) holds. `[ASSUMED]`: the
conditional append happens where `orca-runtime.ts` `getStatus()` builds `capabilities` for `browser.headless.v1`
and `conversations.v1`. That was not read this session; locate it during planning.

## 3. Broker state persistence and revocation

### Evidence
- Device files live in userData: `this.registryPath = join(userDataPath, DEVICE_REGISTRY_FILENAME)` and
  `this.revocationsPath = join(userDataPath, DEVICE_REVOCATIONS_FILENAME)` `[VERIFIED: device-registry.ts:44-46]`. They
  are published with `writeDurableSecureJsonFile` (`device-registry.ts:8`). Its definition is
  `export function writeDurableSecureJsonFile(targetPath: string, value: unknown): void { writeSecureFile(targetPath, JSON.stringify(value, null, 2), { durable: true }) }`
  `[VERIFIED: src/shared/secure-file.ts:95-97]`.
- `durable-file-write.ts` API: `writeFileDurable(tmpPath, finalPath, payload, options)` (`:62`),
  `writeFileDurableIfCurrent` (`:77`), `writeFileDurableSync` (`:215`), `durableWriteTempPath(finalPath)` (`:170`)
  `[VERIFIED]`.
- The contract schema rules: tiers `["crash-durable", "atomic-only", "regenerable"]`. A crash-durable write must route
  through `durable-file-write.ts` "or, where the state is a credential or an identity that also needs the 0600/ACL
  publish, through the durable variants of src/shared/secure-file.ts". `proofRequiredForTiers` and
  `failureSemanticsRequiredForTiers` are both `["crash-durable"]`, and the latter is ratcheted through
  `config/durability-failure-semantics-baseline.txt` `[VERIFIED: config/durability-contracts.jsonc:14-41]`. Entry
  fields: `id, state, writer, tier, lostIf, onFailure, provenBy, knownGaps` `[VERIFIED: :76-88]`.
- Revoke semantics to copy: "a revoke inverts the grant ordering — memory first, so a failed write can never leave
  the device valid" `[VERIFIED: device-registry.ts:171-177]`. Device ids are `randomUUID()` (`:97`), so a removed id
  never returns.
- Revocation call site: `revokeDeviceAndTerminateConnections(this.deviceRegistry, device, (token) => ...)`
  `[VERIFIED: runtime-rpc.ts:722; the only non-test caller]`. The function itself is at `device-authorization.ts:45-59`.

### Recommendation
- One file, `<userData>/orca-wake-broker.json`: `{ "schema": 1, "targets": [{ targetId, mac, broadcast, port, label, createdAt }], "grants": [{ deviceId, targetId, grantedAt }] }`.
  Write it with `writeDurableSecureJsonFile`. The MAC is LAN topology, so the ACL-hardened publish is right. Owner
  in `src/main/runtime/wake-broker-store.ts`. The file is read and written only by the running broker process (§4).
- Target ids: `wt_` plus 12 hex characters from `randomBytes(6)`. Mint them, never derive them from the MAC, so an
  id reveals nothing.
- Add contract `runtime.wake-broker-state`, tier `crash-durable`. `lostIf`: lost targets cost Owner re-registration.
  A lost grant **removal** would resurrect wake access, which is the security case. `onFailure`: grant add persists
  before the memory swap; grant and target removal swap memory first and then save, and the error propagates. An
  unparseable file is preserved as `.corrupt-<ms>` and the broker fails closed (`wake_broker_unavailable`), never
  treated as empty. `provenBy`: `src/main/runtime/wake-broker-store.test.ts`, with an injected publish failure as in
  `device-registry-durability.test.ts`. Run `pnpm check:durability-contracts`.
- **Revocation drops grants, but safety must not depend on that drop.** At the effect, a grant counts only while
  `assertDeviceStillAuthorized` is ok for the caller's token and the grant's `deviceId === device.deviceId`. A crash
  between `removeDevice` and the grant purge therefore authorizes nothing: the device row is gone and UUIDs are not
  reused. This is AGENTS.md's "prefer a retry gate that can re-derive the truth over one that trusts the flag".
  Then add hygiene: (a) after `revokeDeviceAndTerminateConnections` returns true at `runtime-rpc.ts:722`, call
  `wakeBroker.dropGrantsForDevice(device.deviceId)`, so an empty grant list is what the CLI shows; (b) on broker load,
  prune grants whose `deviceId` is not in the registry.

## 4. CLI and the `--wake-broker` flag

### Evidence
- Specs are `CommandSpec` objects with `path`, `summary`, `usage`, `allowedFlags: [...GLOBAL_FLAGS, ...]`, `notes`, `examples`.
  `serve autostart status|install|remove` are separate specs `[VERIFIED: src/cli/specs/serve.ts:10-73]`.
- Handlers are a `Record<string, CommandHandler>` keyed by the space-joined path; local results are wrapped by
  `localSuccess` and printed with `printResult(..., json, formatter)` `[VERIFIED: src/cli/handlers/serve-autostart.ts:13-53]`.
  Runtime-backed handlers call `client.call<T>('method', params)` and print the response, for example
  `client.call<ParkResult>('app.park', {...})` `[VERIFIED: src/cli/handlers/core.ts:153-159]`.
- Serve flag plumbing, a 6-point chain:
  1. spec `allowedFlags` (`serve.ts:16-25`);
  2. handler `flags.get('no-pairing') === true` passed into `serveOrcaApp({...})` (`handlers/core.ts:109-151`);
  3. `childArgs.push('--serve-no-pairing')` (`src/cli/runtime/launch.ts:107-109`);
  4. CLI-form translation `['--no-pairing', '--serve-no-pairing']` in `CLI_TO_SERVE_FLAG` (`src/main/startup/serve-mode-argv.ts:13-18`);
  5. `getServeOptions` reads `noPairing: argv.includes('--serve-no-pairing')` (`src/main/index.ts:2045-2054`);
  6. `'no-pairing'` also appears in `src/cli/args.ts:42` (a known-flag list; its exact role was not read) `[VERIFIED: all six read or grepped]`.
- SSH relay guard: `assertLocalInvocation(env)` throws `remote_invocation_refused` when `env.ORCA_CLI_CWD` is set
  `[VERIFIED: src/cli/runtime/serve-autostart.ts:145-154]`.

### Recommendation
- `orca serve --wake-broker`: add `'wake-broker'` at all six points, with argv flag `--serve-wake-broker` and option
  `wakeBroker: boolean`. In the serve branch of `index.ts` (after `runtimeRpc.start()`, near `:3403`), enable the
  broker only when `serveOptions.wakeBroker` is set. The desktop path never enables it in this phase. Print one
  line in `printServeReady` ("wake broker: enabled, N targets") without MACs.
- New `src/cli/specs/wake.ts` (`WAKE_COMMAND_SPECS`) registered in `src/cli/specs/index.ts`, and
  `src/cli/handlers/wake.ts` (`WAKE_HANDLERS`) registered wherever `SERVE_AUTOSTART_HANDLERS` is.
  - `orca wake target add --mac <aa:bb:..> [--broadcast <ipv4>] [--port <n>] [--label <text>] [--json]`
  - `orca wake target remove <targetId>` and `orca wake target list`
  - `orca wake grant add --device <deviceId> --target <targetId>`, `orca wake grant remove ...`, `orca wake grant list`
  New flag names (`mac`, `broadcast`, `label`, `device`, `target`) may need the `args.ts` known-flag list `[ASSUMED]`.
- **Talk to the running runtime, never write the file from the CLI.** The broker holds the state in memory and is
  the only writer. That way the device-revocation purge and a CLI edit cannot race a read-modify-write that
  resurrects a grant. The CLI calls the `host.wake.admin.*` methods over the local runtime transport (`client.call`).
  Each admin handler refuses `!isLocalRpcCaller(ctx)` with `remote_caller_refused` (already a passthrough code). The
  CLI handler calls `assertLocalInvocation(process.env)` first, because a CLI run through the SSH relay bridge reaches
  the runtime as a local caller. If no runtime is reachable, fail with "start `orca serve --wake-broker` first". If a
  runtime is reachable but is not a broker, return `wake_broker_disabled`. Validate the MAC at the CLI and again in
  the handler's zod schema (`/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i`, normalized to lowercase colon form). Validate
  the broadcast address with `net.isIPv4`.
- Grant add must check `registry.getDevice(deviceId) !== null`, which refuses a grant for an unknown or revoked device.

## 5. Magic packet, dedupe, adoption, stages

### Recommendation (pure core plus an injected sender)
`src/main/runtime/wake-broker.ts` exports `createWakeBroker(deps)`, where
`deps = { now, store, authorize(token), sendMagicPacket(frame: Buffer, address: string, port: number): Promise<void>, newWakeId() }`.

```ts
// frame: 6 x 0xFF then 16 x MAC = 102 bytes (D-06)
export function buildMagicPacket(mac: string): Buffer {
  const macBytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex') // length 6, validated upstream
  const frame = Buffer.alloc(6 + 16 * 6, 0xff)
  for (let i = 0; i < 16; i++) macBytes.copy(frame, 6 + i * 6)
  return frame
}
```

Default sender, `src/main/runtime/wake-magic-packet-sender.ts`, using `node:dgram`:
`createSocket({ type: 'udp4' })`, then `bind(0)`; in the bind callback call `setBroadcast(true)`, then
`send(frame, port, address, cb)`, then `close()` in a `finally`. Resolve only in the `send` callback with no error:
that callback is the `packet-sent` evidence (D-11). Add an error listener so a socket `'error'` rejects instead of
crashing main. `setBroadcast` works only on a bound socket and throws `EBADF` otherwise; calling it inside the `bind`
callback avoids that `[ASSUMED: Node dgram docs, not fetched this session]`.

- **Windows and multi-NIC:** the limited broadcast `255.255.255.255` goes out one interface (the route-selected one)
  on Windows `[ASSUMED]`. Make the per-target `broadcast` default `255.255.255.255`, but recommend that the Owner
  registers the subnet-directed broadcast (for example `192.168.1.255`) and print that hint on `target add`. Default
  port 9 (D-06). Windows Firewall does not block outbound UDP by default `[ASSUMED]`.
- **Burst:** send one frame per accepted wake, so D-14's "a duplicate request sends exactly one packet" is literally
  checkable. Keep `burstCount` a constant of 1 and name it, so a later change has to be explicit.
- **Dedupe (D-09):** an in-memory `Map<string, Entry>` keyed `${targetId}\u0000${requestId}`, window 60 s. A replay
  returns the original result with `replayed: true`. The authority check (§2 steps 1-4) **runs before** the lookup, so
  a revoked or ungranted device never gets a replay.
- **Adopt (D-09):** a per-target `inFlight` record. A different `requestId` for the same target within 10 s (rec)
  returns the existing `wakeId` with `adopted: true` and sends nothing. Key it by target (the subject), never by
  device (the requester): two devices waking one target must contend.
- **Bounds without timers:** prune expired entries lazily at the start of each request and cap the map (for example
  256 entries, oldest evicted). No `setTimeout`, so there is no recurring-work site (see §1).
- **Stages** (`src/shared/host-wake-stages.ts`, pure and shared by broker and clients):
  `HOST_WAKE_STAGES = ['requested', 'authorized', 'packet-sent', 'host-announced', 'runtime-ready'] as const`, and
  each record is `{ stage, observedAt, observer: 'broker' | 'client' }`. The broker only ever writes the first three.
  `host.wake.status` returns broker stages. The client composes `host-announced` (the target answered `status.get`
  live, after `packet-sent.observedAt`) and `runtime-ready` (`graphStatus === 'ready'` in that answer) with a pure
  `composeWakeProgress(brokerStages, targetObservation)`. A failed send records `packet-send-failed` with the error
  code and throws `wake_send_failed`. The mutant "packet-sent reported as host-announced" is caught by asserting that
  no broker-written record has stage `host-announced`.
- **Retention:** keep stage records for `host.wake.status` in the same bounded map (60 s to 5 min). After that,
  `status` answers `wake_unknown` (in the refusal-code set above).

### Tests
- Unit: inject a recording `sendMagicPacket` and a test clock. Assert one call for duplicate `requestId`s, one call
  for adopted requests, zero calls for each refusal, and stage order.
- Positive control (Node, single file, runs on this laptop): `dgram.createSocket('udp4')` listener bound to
  `127.0.0.1:0`, a real default sender aimed at `127.0.0.1:<port>`, then assert `msg.length === 102`, the first 6
  bytes are `0xff`, and every 6-byte block after them equals the registered MAC. Add a negative control: a different
  MAC must not match. Use unicast loopback, not `255.255.255.255`, because receiving limited broadcast on loopback is
  platform-dependent `[ASSUMED]`. Close both sockets in `afterEach`.

## 6. Mobile side: estimate and recommendation

### Evidence
- Claims config: `"card": "mobile/src/components/MobileHostCard.tsx"`, `"presenter": "mobile/src/components/host-availability-presentation.ts"`,
  and actions `host-card-open` and `host-card-actions` are both `"kind": "navigation"`
  `[VERIFIED: config/host-card-claims.jsonc:19-20,139-148]`. Capability-value evidence lists:
  `not-supported` is `["host-announced"]` (`:110-115`), `needs-owner-setup` is `["host-announced"]` (`:122-127`),
  `supported` is `["host-announced", "relay-reported", "os-probe"]` (`:104-109`). `capability.can-wake-lan` has the
  why "Naming LAN wake is not offering it: the card has no wake control, only the announced value" (`:79-83`).
- Checker rules: `EFFECT_VERB = /\b(?:wake|power[\s-]?on|turn\s+on|boot|start\s+orca)\b/i`; `POWER_LOSS` includes
  `asleep|sleeping|hibernat|\boffline\b` (`check-host-card-claims.mjs:38-40`). Label families are fixed:
  `power, orca, capability, capability-value, capabilities` (`:49-55`). An effect action must name an `rpc` that
  appears as `define\w*Method({ name: '...' })` in a non-test file under `src/main/runtime/rpc/methods` (`:108-119`,
  `:319-324`). **If any effect action exists, the card-copy effect-wording check is skipped entirely**
  (`const effectBacked = ... some(...)`, `if (!effectBacked) { ... }` at `:427-436`) `[VERIFIED: read this session]`.
- Card controls are `testID="host-card-open"` (`MobileHostCard.tsx:90`) and `testID="host-card-actions"` (`:150`).
  Status comes through `fetchHomeHostStatus(client: RpcClient, hostId, ...)` with
  `sendSingleFlightRequest(client, hostId, 'status.get', undefined)`. The mobile client type is `RpcClient` from
  `mobile/src/transport/rpc-client.ts`, and other sites call `client.sendRequest('status.get')`
  `[VERIFIED: mobile/src/transport/home-host-status-fetch.ts:1-42; grep]`.

### Estimate: defer the control (D-13 escape clause)
A real Wake control is larger than this slice, for four reasons:
1. **Cross-host routing.** The card belongs to the sleeping target host, but the RPC goes to a *different* paired host
   (the broker). That is a different `RpcClient`. The phone must map target card to (broker hostId, targetId). That
   needs the broker to record the target's identity (runtimeId or host-key fingerprint), `host.wake.targets` to
   return it, and the phone to match it to its saved host. That is new phone state across hosts.
2. **A new label family.** Stage labels (`wake.requested`, ...) need a new vocabulary and a `FAMILY_VOCABULARY`
   entry in the checker.
3. **A checker weakening.** The first effect control disables the card-wide effect-wording check (`:427-436`). Doing
   this safely means scoping the check per control (effect words only inside an effect-classified control), plus a
   new mutant.
4. **Testing cost.** Mobile tests run only on GEX44 (D-16).

Recommended: the SCRIPTED CLIENT drives `host.wake.*`, and the summary records "Wake control deferred (D-13)". The
phase still owes these claims-config edits, because the probe now emits `not-supported` and `needs-owner-setup` with
`os-probe` evidence:
- add `"os-probe"` to the `evidence` lists of `capability-value.not-supported` and `capability-value.needs-owner-setup`,
  and update their `why`;
- keep `capability.can-wake-lan`'s why ("the card has no wake control") because it stays true.

Re-run `pnpm check:host-card-claims` and `config/scripts/check-host-card-claims.test.mjs`. `[ASSUMED]`: the
presenter renders `reason` strings through a table or generically. Check
`mobile/src/components/host-availability-presentation.ts` for unknown-reason handling before adding `os_not_armed`
and `firmware_unverified`. `[ASSUMED]`: `REASON_PATTERN` in `host-availability.ts` accepts snake_case reasons
(the parser falls back to `'unspecified'` otherwise, `:213-216`).

## 7. Test harness

| Model test | What to copy |
|------------|--------------|
| `src/main/runtime/host-autostart-probe.test.ts` | injected `exec`, clock, `settled()`; table of outputs to capability |
| `src/main/runtime/host-availability-producer.test.ts` | register sources, assert `can-wake-lan` from the new reader |
| `src/main/runtime/rpc/methods/status.test.ts` | calling a method directly: `method.handler(params, { runtime: fakeRuntime(), ... })` after an `isStreamingMethod` guard `[VERIFIED: status.test.ts:30-36]`; add `clientId` and `pairedDeviceId` to the ctx for the wake methods |
| `src/main/runtime/device-authorization.test.ts` | a registry with a removed device, which gives `device_revoked` |
| `src/main/runtime/device-registry-durability.test.ts` | injected publish failure, write ordering (V-REV-SAVE-FAILURE pattern) |
| `src/cli/runtime/serve-autostart-task.live.test.ts` | env-gated live leg (`ORCA_LIVE_*=1`), skipped by default |
| `config/scripts/check-host-card-claims.test.mjs` | mutant drills for the claims config |

**Single-file command (proven in phase 18):** `pnpm exec vitest run --config config/vitest.config.ts <file>`
`[CITED: 18-03-SUMMARY.md:61]`. Phase 18 ran `status.test.ts` and the probe tests as single files the same way
(`18-01-SUMMARY.md:89-92`). `[ASSUMED]`: `config/vitest.config.ts` also includes `src/main/**`. Wave 0 confirms that
by running `src/main/runtime/rpc/methods/status.test.ts` alone first.

**Gates proven on this laptop in phase 18** `[CITED: 18-01-SUMMARY.md:98-102]`: `pnpm run typecheck:node`,
`pnpm run typecheck:cli`, `pnpm run check:recurring-work`, `pnpm run check:durability-contracts`; plus
`pnpm check:host-card-claims` (phase 18-03).

**Live legs (read-only, env-gated):**
- `ORCA_LIVE_WOL_PROBE=1`: runs the real probe on this laptop and records the verdict. Expected
  `needs-owner-setup`/`os_not_armed` per the brief. Positive control: the same run must print at least one adapter
  row with a non-null `WakeOnMagicPacket`, which proves the reader is not blind.
- SCRIPTED CLIENT leg on a disposable serve host (`--serve-wake-broker`, loopback bind, E2E disposable home, phase 9
  pattern): pair two scripted devices, `orca wake target add --broadcast 127.0.0.1 --port <listener>`, grant one,
  then exercise grant-missing, revoked (`removeDevice`), accepted, duplicate (listener counts exactly 1 frame),
  stages ending at `packet-sent`, and the 102-byte frame. Mutants: grant check skipped, dedupe off, packet-sent
  labelled host-announced. Each must be PLANT_CONFIRMED, CAUGHT and RESTORE_VERIFIED.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (4.1.9 on GEX44 per 18-02-SUMMARY:60; laptop version not checked) |
| Config file | `config/vitest.config.ts` |
| Quick run command | `pnpm exec vitest run --config config/vitest.config.ts <single file>` |
| Full suite command | not on this laptop (STATE law); GEX44 disposable root only |

### Phase Requirements to Test Map
| Req | Behavior | Type | File (new = Wave 0) |
|-----|----------|------|------|
| SC1 / D-01..03 | verdict table per platform; never `supported`; unknown on failure | unit | `src/main/runtime/host-wol-verdict.test.ts` (new) |
| SC1 | producer announces probe value on `can-wake-lan` | unit | `host-availability-producer.test.ts` (extend) |
| SC1 | real read-only probe on this laptop | live, env-gated | `src/main/runtime/host-wol-probe.live.test.ts` (new) |
| D-08 | refusals: disabled, revoked, grant-missing, target-unknown, local caller | unit | `src/main/runtime/rpc/methods/host-wake.test.ts` (new) |
| D-09 | replay within 60 s, adopt within 10 s, one send | unit | `src/main/runtime/wake-broker.test.ts` (new) |
| D-06 | exact 102-byte frame over real UDP loopback | integration | `src/main/runtime/wake-magic-packet-sender.test.ts` (new) |
| D-10 | durable write ordering, corrupt file fails closed, revoke purges grants | unit | `src/main/runtime/wake-broker-store.test.ts` (new) |
| D-11 | broker never writes host-announced; client composition | unit | `src/shared/host-wake-stages.test.ts` (new) |
| D-12 | capability advertised only when enabled; codes pass through | unit | `host-wake.test.ts`, `status.test.ts` |
| D-13 | claims config with os-probe evidence | gate | `pnpm check:host-card-claims` + `check-host-card-claims.test.mjs` |

### Sampling Rate
- Per task: the single test file(s) touched.
- Per wave: the files above, plus `typecheck:node`, `typecheck:cli`, `check:durability-contracts`, `check:recurring-work`, `check:host-card-claims`.
- Phase gate: all of the above plus the SCRIPTED CLIENT leg and the mutant drills.

### Wave 0 Gaps
- [ ] Confirm the single-file command on `status.test.ts`.
- [ ] Create the new test files listed above.

## Common Pitfalls

1. **Refusal code collapses to `runtime_error`.** A handler `throw` with `.code` is mapped only through the passthrough
   sets (`errors.ts:141-211`). Add the wake codes to `STRUCTURED_RUNTIME_PASSTHROUGH_CODES`, and test the mapped
   response, not the thrown error.
2. **Phone gets `forbidden`.** New phone methods must be in `MOBILE_RPC_METHOD_ALLOWLIST` (`runtime-rpc.ts:238`).
   Admin methods must not be, and they still need `isLocalRpcCaller`, because runtime-scope paired devices skip the
   allowlist.
3. **SSH relay plants grants.** The CLI through the relay is a local caller; guard with `ORCA_CLI_CWD`
   (`serve-autostart.ts:145-154`).
4. **Fallback-code overlap.** An old host answers `method_not_found` for `host.wake.*`. A client gated on
   `host.wake-broker.v1` never calls it, and must never map `method_not_found` or `wake_*` to "try something else"
   (for example a direct packet from the phone). Wake codes must not reuse `unauthorized`, `forbidden`,
   `capability_unsupported` or `runtime_error`. Note: a revoked device is refused at dispatch with `unauthorized` plus
   `data.reason: 'device_revoked'` (`device-authorization.ts:32-39`) before the handler runs. The handler's own
   `device_revoked` code covers only the window between dispatch and send. Tests must cover both layers.
5. **Rule 3 content change.** `can-wake-lan` changes from a constant to measured values. The vocabulary is unchanged,
   so phase-18 clients render it, but new reasons pass through `REASON_PATTERN` (verify it).
6. **Replay leaks across devices.** Run authority before the dedupe lookup. Key replays by (target, requestId), but
   never return a replay to a device that fails the grant check.
7. **Adoption keyed by device.** It must be keyed by target, or two phones send two bursts.
8. **Grant resurrection after revoke.** Covered by deriving at effect time (§3). Test it with a store that still holds
   the grant after `removeDevice`.
9. **Empty-on-unreadable.** An unparseable state file read as `{targets: [], grants: []}` and then rewritten loses
   every target. Fail closed and preserve the file (the device-registry pattern).
10. **MAC leakage.** Never return the MAC from phone methods, `status.get` or logs. `host.wake.targets` returns
    `{targetId, label}` only. Add a test that serializes every phone-method result and asserts no MAC-shaped string.
11. **`setBroadcast` before bind** throws. Call it in the bind callback.
12. **A timer sneaks in** (an expiry `setTimeout` for dedupe). It would need a recurring-work entry; use lazy pruning.
13. **WSL and SSH hosts.** A WSL distro's `eth0` is virtual (no `device` link). Return `unknown`/`wol_not_observable`,
    never `not-supported`. On a Linux host where `ethtool` needs CAP_NET_ADMIN to read Wake-on `[ASSUMED]`, EPERM
    gives unknown.
14. **Effect-wording gate weakening** if a Wake control is added later (§6.3).

## Security Domain

| ASVS Category | Applies | Control |
|---------------|---------|---------|
| V2 Authentication | yes | existing device token; `assertDeviceStillAuthorized` at dispatch and at send |
| V3 Session Management | no | — |
| V4 Access Control | yes | per-(device, target) grant; admin methods local-only plus the `ORCA_CLI_CWD` refusal |
| V5 Input Validation | yes | zod params; MAC regex; `net.isIPv4` broadcast; port 1-65535 |
| V6 Cryptography | yes (minor) | `randomBytes` for target and wake ids; no hand-rolled crypto |
| V7 Errors / Logging | yes | no MAC or token in logs or error messages |

| Threat | STRIDE | Mitigation |
|--------|--------|-----------|
| Paired but ungranted device wakes a host | Elevation | grant check at effect; pairing never implies wake |
| Revoked device replays a request | Spoofing | authority before dedupe; dispatch-time and send-time checks |
| Wake flood (DoS, power cycling) | DoS | per-target adoption window; one frame per accepted wake |
| Target enumeration by id guessing | Info disclosure | grant-first ordering; random ids |
| MAC exposure to phone | Info disclosure | phone methods return id and label only |
| Remote shell edits grants | Elevation | `isLocalRpcCaller` + `ORCA_CLI_CWD` refusal |
| Grant survives revoke after a crash | Elevation | grant valid only while the device authorizes (derived at effect) |

## Environment Availability

| Dependency | Required by | Available here | Fallback |
|------------|-------------|----------------|----------|
| PowerShell, `Get-NetAdapterPowerManagement`, `powercfg` | Windows probe live leg | Windows 10 laptop (yes; elevation needs unverified) | verdict `unknown` |
| `ethtool` | Linux probe | not on this laptop; GEX44 unverified | sysfs `power/wakeup`, else `unknown` |
| `pmset` | macOS probe | no Mac | unit tests only (recorded output fixtures) |
| UDP loopback | positive control | yes (Node built-in) | — |
| Always-on LAN node + BIOS/OS arming | LAN Product Reality | no (D-15) | OWNER_BOUND |

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|-------|---------|---------------|
| A1 | `Get-NetAdapterPowerManagement` readable unelevated | §1 | live verdict reads unknown; the probe must not misreport |
| A2 | `ethtool` Wake-on read needs CAP_NET_ADMIN on some kernels | §1, pitfall 13 | Linux verdict unknown more often |
| A3 | Windows limited broadcast leaves one interface | §5 | packet misses the target's subnet; directed broadcast mitigates |
| A4 | loopback limited-broadcast receive is platform-dependent | §5 | use unicast 127.0.0.1 in the control |
| A5 | the conditional capability append lives in `orca-runtime.ts` `getStatus()` | §2 | planner must locate it |
| A6 | no gate requires registering `effect: 'launch'` methods | §2 | a gate fails; register the method |
| A7 | `config/vitest.config.ts` covers `src/main/**` | §7 | Wave 0 finds the right config |
| A8 | `REASON_PATTERN` accepts new snake_case reasons; presenter handles unknown reasons | §6 | reasons render as `unspecified` |
| A9 | `args.ts:42` list gates which flags the CLI accepts | §4 | new flags rejected until listed |
| A10 | `pmset -g` absent `womp` means no data, not no hardware | §1 | conservative unknown chosen |
| A11 | `dgram` `setBroadcast` throws `EBADF` before bind | §5 | harmless if wrong; bind-callback order works either way |

## Open Questions

1. **Who observes `host-announced` for the D-02 `supported` upgrade?** Only a client that both requested the wake and
   reconnects to the target. Recommendation: never emit `supported` in phase 19; design the evidence channel in phase
   20 (pre-suspend and resume announcements are already deferred there).
2. **Local Owner wake (`orca wake send`) without a device?** Out of scope (grants are per device); refuse with
   `wake_device_required`.
3. **Target identity for future card routing.** Recommend an optional `--host-fingerprint` on `target add` now (never
   sent with the MAC) so phase 20 or the card slice can map cards to targets. This is optional; omit it if the slice
   is tight.

## Sources

### Primary (HIGH, read this session)
- `src/main/runtime/host-availability-producer.ts`, `host-autostart-probe.ts`, `device-authorization.ts`, `device-registry.ts:1-200`
- `src/main/runtime/rpc/core.ts:55-185`, `rpc/errors.ts:60-242`, `rpc/methods/status.ts`, `rpc/methods/host-capabilities.ts`, `runtime-rpc.ts:232-243,1100-1180,1745-1870`
- `src/shared/protocol-version.ts`, `src/shared/host-availability.ts` (vocabulary), `src/shared/secure-file.ts` (exports), `src/main/durable-file-write.ts:1-80`
- `src/cli/specs/serve.ts`, `src/cli/handlers/serve-autostart.ts`, `src/cli/handlers/core.ts:95-165`, `src/cli/runtime/launch.ts:80-130`, `src/cli/runtime/serve-autostart.ts`, `src/main/startup/serve-mode-argv.ts`, `src/main/index.ts:2030-2064,3380-3529`
- `config/durability-contracts.jsonc:1-100`, `config/recurring-work-inventory.jsonc:1-50`, `config/host-card-claims.jsonc`, `config/scripts/check-host-card-claims.mjs:1-63,100-139,280-444`
- `docs/reference/remote-wire-compatibility.md:1-95`, `mobile/src/transport/home-host-status-fetch.ts`
- Phase 18 summaries 18-01 (gates, live leg) and 18-03 (vitest command)

### Secondary
- Node `dgram` behaviour (`setBroadcast` on a bound socket): training knowledge, not fetched this session (A11).

## Metadata
**Confidence:** in-repo integration HIGH; OS probe outputs MEDIUM (fixtures from training, settled by live legs); Linux privileges LOW.
**Research date:** 2026-10-27. **Valid until:** 2026-11-26 (stable internal code; recheck if `runtime-rpc.ts` dispatch changes).
