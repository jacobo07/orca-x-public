# Phase 20: Off-LAN wake, OOB boundary and institutional close (M3, M4) - Research

**Researched:** 2026-10-27
**Domain:** relay-delivered RPC authority, host capability producers, read-only OS probes, claims-gate ratchet, institutional close
**Confidence:** HIGH for code seams (files read this session); MEDIUM for OS probe commands outside Windows; LOW where tagged [ASSUMED]

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- D-01: Off-LAN wake is the same `host.wake.request` / `host.wake.status` call, delivered to the broker host over
  the existing relay transport the phone already uses for that host. No second remote-control transport (law),
  no public inbound port, no public wake endpoint. Authority stays at the broker's effect (19 D-08), whatever the
  transport. The relay is provenance, never identity.
- D-02: Prove transport independence in code: a wake arriving through the relay dispatch path meets the same
  authorization, dedupe and refusal codes as one arriving direct. Use the narrowest real seam the relay
  frames reach, and mutant-check that a relay-delivered request cannot skip the device check.
- D-03: The live off-LAN leg (phone on 5G → relay → broker on the LAN → target wakes → fresh terminal output) is
  OWNER_BOUND: a broker host needs cloud auth for the relay (`host-relay-startup.ts`: `cloud_auth_not_configured`),
  and a disposable host has none; the LAN has no always-on node (Owner step c); the BIOS step (b) is outstanding.
  Record the exact steps and the ordered procedure. Never present the unit or SCRIPTED legs as M3.
- D-04 (rec): `can-wake-remote` on a host stays non-`supported` unless there is evidence. A broker host that is
  enabled, has relay readiness `supported` and at least one registered target may announce that it can accept
  remote wake requests (reason e.g. `broker_relay_ready`). A target host never claims it can be woken remotely
  from configuration alone. The planner settles which host announces what. Rule: no `supported` without the
  evidence kind that proves it; a packet sent is not a host woken.
- D-05 (rec): `wake-proxy-available` connectivity is composed on the phone side only from a broker answer
  received in this session. It never comes from cached or assumed state; unknown stays unknown.
- D-06: A generic OOB power interface (power-on, power-state read) with a test double used only by tests. There is
  no real implementation in production paths. Nothing in production may report a powered-on result from the
  double (Reality Contract).
- D-07 (rec): `can-power-on-oob` is measured read-only: AMD CPU: `not-supported`, reason `HARDWARE_BOUND` (AMT is
  Intel-only), evidence `os-probe`; Intel without a management engine interface detected: `unknown`; probe
  failure: `unknown`. It is never `supported` in this phase. The board is measured as an AMD platform (MSI MS-7B89).
- D-08: M4 (powered off) is HARDWARE_BOUND. WOL from S5 with Fast Startup off is OWNER_BOUND and never assumed.
- D-09: Rows K (broker offline: no wake offered; any request reported unknown/unreachable, never powered-off or
  woken), L (revoked phone: refused at the effect; reuse 19's in-process proof, extended to the relay-delivered
  path), M (version mismatch: an old broker without `host.wake-broker.v1` gets no wake request; an old client still
  sees phase 18 fields only). Each row has a positive control. Mutants report PLANT_CONFIRMED, CAUGHT, RESTORE_VERIFIED.
- D-10 (rec): The baseline ratchet extends an existing gate rather than adding a parallel one: no `supported`
  for `can-wake-lan`, `can-wake-remote` or `can-power-on-oob` without an evidence producer, and no wake or
  power control without a backend method. Likely home: `check:host-card-claims` or a sibling under
  `config/scripts`. Wired into CI the way 18-03 did.
- D-11: Knowledge Vault and UKDL entries live outside this repo (`~/.claude/knowledge_vault/`, the UKDL of the
  project), as in phase 10. Local, internal, reversible files: one lesson and one rule per law learned. Inside the
  repo, durable knowledge goes to `docs/reference/` only where AGENTS.md already points (rec: a short
  `docs/reference/host-wake-broker.md` linked from AGENTS.md is allowed if the planner finds a precedent).
- D-12: Fresh-agent test: a read-only agent with no chat context answers a fixed question set (branch and laws,
  phase status and resume commands, Owner-only steps, what is proven vs owed for 17-20, next action) from
  durable state only, with file:line citations. Gaps found are fixed in STATE.md.
- D-13: Two-layer handoff in STATE.md: Owner-facing summary plus agent-facing resume block. Milestone audit,
  complete and cleanup are NOT run while phases are human_needed.
- D-14: Node-side tests run as single files here; heavy builds and mobile runs go to a GEX44 disposable root with
  teardown proof. No Owner-PC effects. Never push. UDP to loopback only.

### Claude's Discretion
Interface and file names, the exact `can-wake-remote` reason vocabulary, which gate file the ratchet extends, and
the fresh-agent question wording.

### Deferred Ideas (OUT OF SCOPE)
- The mobile Wake control (19 D-13): needs cross-host routing from a target card to its broker.
- Host pre-suspend announcement as evidence for `sleeping`.
- Broker discovery and target auto-registration.
- 19-REVIEW info items IN-01..IN-05.
</user_constraints>

## Summary

The relay already delivers phone frames into the very same dispatch function as the direct WebSocket. Both
transports attach to one `MobileSocketWiring` (`runtime-rpc.ts:1432-1435`), whose `onText` calls
`handleWebSocketMessage` (`runtime-rpc.ts:1450-1459`). That function runs the device re-authorization
(`:1789-1796`), the mobile allowlist (`:1798`) and builds the `RpcContext` (`:1869-1883`). The context carries
`clientId`, `pairedDeviceId`, `clientKind`, `connectionId` and **no transport field**. `host.wake.*` handlers read
only `ctx.clientId` and `ctx.pairedDeviceId` (`rpc/methods/host-wake.ts:30-31`). So transport independence already
holds by construction. Phase 20 has to **prove** it through the real relay path. The narrowest real seam that
needs no cloud auth is the one `relay/mobile-relay-e2ee.integration.test.ts` already uses: a local `ws`
WebSocketServer acting as the relay cell, a real `CloudRelayTransport`, and `SimulatedMobileE2EEV2Peer`. Phase 20
re-points it at a real `OrcaRuntimeRpcServer`'s `getMobileSocketWiring()` instead of a standalone wiring.

The capability work is small and local: `host-availability-producer.ts:106-112` hard-codes `can-wake-remote` and
`can-power-on-oob`. A read-only OOB probe modelled on `host-wol-probe.ts` replaces the second. Measured here:
`AuthenticAMD`, board `B450M MORTAR MAX (MS-7B89)`, 0 `Management Engine` PnP entities. One trap is live: the
reason `HARDWARE_BOUND` from D-07 **fails the wire reason pattern** `^[a-z0-9_]{1,64}$`
(`src/shared/host-availability.ts:190`), so the phone would parse it as `unspecified`. The wire reason must be
lowercase.

`wake-proxy-available` needs no new host field. A phone already gets, in this session, the broker's
`status.get` (capability `host.wake-broker.v1`) and its `host.wake.targets` answer. A pure shared composer over
those two answers is the whole of D-05, and it carries rows K and M. The ratchet extends
`check-host-card-claims.mjs` with a G6 "capability producer" check, which is already in CI (`pr.yml:131-132`). The
institutional close writes to `~/.claude/knowledge_vault/lessons/` and to the Power Pack UKDL
`~/.claude/skills/claude-power-pack/vault/knowledge_base/ukdl-universal.md`. Note that `INDEX.md` does not exist.

**Primary recommendation:** prove relay transport independence with a real-server + local-relay-cell test, keep every capability non-`supported` except the D-04 broker announcement, use lowercase reasons, and extend the existing claims gate rather than add a sibling.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Off-LAN wake delivery | Relay transport (CloudRelayTransport → MobileSocketWiring) | API (runtime-rpc dispatch) | Relay only carries frames; it never chooses identity (`mobile-socket-wiring.ts:163-167`) |
| Wake authority / dedupe / refusals | API: broker effect (`wake-broker.ts`) | — | 19 D-08: judged at the effect, keyed by device, not by transport |
| `can-wake-remote`, `can-power-on-oob` | Host process (producer + read-only probe) | Shared parser | Host announces; phone parser degrades malformed to unknown |
| `wake-proxy-available` | Phone side (shared pure composer, `src/shared`) | — | D-05: only from this session's broker answers |
| OOB interface | Host process (type only) + tests (double) | — | D-06: no production implementation |
| Ratchet | CI gate (`config/scripts`) | — | Extends `check:host-card-claims` |
| Vault / UKDL / handoff | Outside repo + `.planning/STATE.md` | `docs/reference/` | D-11..D-13 |

## 1. Relay dispatch: how a relay frame reaches the handlers

**Path, every step read this session:**
1. `DesktopRelayService` constructor takes `runtimeRpc.getMobileSocketWiring()` (`relay/desktop-relay-service.ts:61`).
   It passes it to `RelaySessionBroker.connect({ mobileSocketWiring, ... })` (`:79-89`), which attaches the
   relay's `CloudRelayTransport`. [VERIFIED: desktop-relay-service.ts:59-95]
2. `MobileSocketWiring.attachTransport(transport, getMetadata)` (`rpc/mobile-socket-wiring.ts:97-116`). A relay
   transport supplies metadata of the shape quoted verbatim from `:12-20`:
   ```ts
   | { transport: 'direct' }
   | { transport: 'relay'; relayHostId: string; relayDeviceId: string; basisConnId: string; credentialKind: 'invite' | 'resume' }
   ```
3. On the first frame the wiring builds an `E2EEChannel` with `requireV2: metadata.transport === 'relay'`
   (`:154`). `resolveAuthenticatedDevice` runs `assertDeviceStillAuthorized(deviceRegistry, token)` and **for relay
   additionally requires `metadata.relayDeviceId === device.deviceId`** (`:157-169`). This is the one place where the
   relay path is *stricter* than direct.
4. After the handshake, `onReady` stores `{ ws, connectionId, device, clientCapabilities, transport: metadata }`
   (`:170-183`). Plaintext then goes to `onText`.
5. `OrcaRuntimeRpcServer.ensureMobileSocketWiring` sets `onText` to call
   `handleWebSocketMessage(plaintext, reply, sendBinary, undefined, socket.ws, socket.device.deviceToken, socket)`
   (`runtime-rpc.ts:1447-1460`). The comment at `:1432-1435` states that direct WS and cloud relay share this one
   wiring.
6. `handleWebSocketMessage` (`runtime-rpc.ts:1749-1888`) does the following, in order:
   - checks the token mismatch (`:1779`);
   - re-authorizes per message with `assertDeviceStillAuthorized` (`:1789-1796`);
   - applies the mobile allowlist (`:1798`). The allowlist includes `'host.wake.request'`, `'host.wake.status'` and
     `'host.wake.targets'` (`:378-380`), and no `host.wake.admin.*` (grep for `host\.wake` in runtime-rpc.ts hits
     only 378-380);
   - applies long-poll admission;
   - calls `dispatcher.dispatchStreaming(request, reply, { authenticatedCallerFingerprint, connectionId, clientId: token, pairedDeviceId: device.deviceId, clientKind: device.scope, clientCapabilities, pairing, signal, sendBinary, registerBinaryStreamHandler })`
     (`:1869-1883`).
7. **The context has no transport field.** Transport metadata reaches only the `pairing` sub-context
   (`:1845-1867`). `host.wake.*` reads `{ token: ctx.clientId, deviceId: ctx.pairedDeviceId }`
   (`rpc/methods/host-wake.ts:30-31`). Admin methods refuse any caller with `pairedDeviceId`, `clientKind`,
   `clientId` or `connectionId` (`rpc/local-rpc-caller.ts:8-16`), so a relay caller can never reach admin even if
   the allowlist were bypassed.

**Answer:** yes. A relay-delivered `host.wake.request` already gets the identical device re-authorization, mobile
allowlist and broker effect as the direct WebSocket. There is no relay-specific branch to forget, so the proof must
drive the real relay frames through the real server.

**Narrowest real seam for D-02 (no cloud auth):** a new test, `src/main/runtime/wake-broker-relay-dispatch.test.ts`.
It combines the following:
- Server setup copied from `wake-broker-revoke-in-process.test.ts:59-108`:
  - `new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: true, wsPort: 0 })`, then `start()`.
    `enableWebSocket` is required, because the wiring is only created in the WS start path (`runtime-rpc.ts:1411`).
  - `createPairingOffer({ address: '127.0.0.1', name: 'phone', scope: 'mobile' })`, `decodePairingOffer`, seed the
    target and grant, then `startWakeBroker(userDataPath)`.
- Relay copied from `relay/mobile-relay-e2ee.integration.test.ts:63-241`:
  - a local `new WebSocketServer({ port: 0 })` relay cell that splices `/v1/host/data/<connId>` with
    `/v1/connect/<relayHostId>`;
  - `new CloudRelayTransport({ cellUrl, relayHostId, generation: 1 })`, then
    `server.getMobileSocketWiring()!.attachTransport(transport, (s) => transport.metadataFor(s))`, `start()`,
    `openConnection({ connId, connTicket, kind: 'invite', relayDeviceId: offer.deviceId, attachDeadlineMs })`;
  - `SimulatedMobileE2EEV2Peer(nacl.box.keyPair(), desktopPublicKey, relayHostId)`. The desktop public key comes
    from `server.getE2EEKeypair()` (used at desktop-relay-service.ts:60), and `relayHostId` from
    `deriveRelayHostId(publicKey)`.
  - The e2ee_auth carries `deviceToken`, as at `:197-203`.

Assertions and the mutant each one should catch:
- Positive control: ACCEPTED, stages `requested, authorized, packet-sent`, exactly 1 frame of 102 bytes at a
  loopback dgram listener.
- Replay: the same requestId returns the same wakeId with `replayed: true` and +0 frames.
- An ungranted second device over the relay is refused `wake_grant_missing`.
- After `revokeMobileDevice`: a relay frame is refused `unauthorized` / `device_revoked`, and an in-flight dispatch
  is refused `wake_device_revoked`. Listener unchanged.
- A `host.wake.admin.targetList` sent over the relay is refused `forbidden` (mobile allowlist).
- A relay connection whose `relayDeviceId` differs from the authenticating device never becomes ready
  (`mobile-socket-wiring.ts:165`).

Existing relay tests fake the transport in two ways:
- A real `CloudRelayTransport` against a local `ws` server (the integration test above).
- A standalone `MobileSocketWiring` with a fresh `DeviceRegistry` (`:123-151`).

Neither touches cloud auth. `RelayAuthCoordinator` / `readRelayAuthContext` is bypassed because
`DesktopRelayService` is not constructed. [VERIFIED: files read this session]

## 2. can-wake-remote and wake-proxy-available

**Current host values** (`host-availability-producer.ts:104-112`, quoted):
```ts
'can-wake-remote': { value: 'not-configured', reason: 'no_wake_broker', evidence: announced },
'can-power-on-oob': unknownCapability('oob_not_measured'),
```
- Sources type: `HostAvailabilitySources` (`:8-14`) holds `processKind`, `relayReadiness`, `webSocketEndpoint`,
  `autostart`, `wakeOnLan`.
- Registration: in serve at `src/main/index.ts:3409-3415`, and in desktop at `:3529-3534`.
- In serve, the broker starts **after** the producer is registered (`index.ts:3421-3433`, `startWakeBroker`). That is
  fine for a read-at-describe source.
- Relay readiness type (`relay/host-relay-startup.ts:11-13`):
  `{ state: 'started'; status: MobileRelayStatus | null } | { state: 'unavailable'; reason: HostRelayUnavailableReason }`.
  `describeRelayCapability` already maps it (`producer:20-45`), giving `supported` with `relay-reported` evidence.

**Recommended change (D-04):**
- Add `wakeBroker: () => { state: 'enabled'; targetCount: number } | { state: 'unavailable'; reason: string } | null`
  to `HostAvailabilitySources`, read from `wakeBrokerHost.current()?.store.targets().length` and
  `wakeBrokerHost.unavailableReason()` (`wake-broker-host.ts:22-30, 49-50`).
- Add a pure `describeRemoteWakeCapability(broker, relay: HostCapability, nowMs)`:
  - broker null → keep `not-configured` / `no_wake_broker` / host-announced. This is today's value on every
    non-broker host, and a target never claims more.
  - broker unavailable → `unknown(<reason>)`. Store reasons are already lowercase.
  - enabled with 0 targets → `not-configured` / `broker_no_targets` / host-announced.
  - enabled, targets ≥ 1, relay not `supported` → `needs-owner-setup` / `broker_relay_needs_setup` when the relay
    reason is `cloud_auth_not_configured`; otherwise `unknown('broker_relay_' + reason)`. Check the 64-char cap.
  - enabled, targets ≥ 1, relay `supported` → `supported` / `broker_relay_ready`, with evidence `relay-reported` and
    the relay's `observedAt`. This passes the parser: the evidence kind exists (`host-availability.ts:3-9`).
  - Mutant: return `supported` on a target from config, and the table test catches it.
- **Semantic pitfall (falsifier already in hand):** the card renders `capability.can-wake-remote` as
  `"Remote wake: yes"` (`mobile/.../host-availability-presentation.ts:31,35`). On the broker's own card that reads
  "this host can be woken remotely", which is false: the broker is the always-on node. The planner must choose one
  of the following:
  - (A) accept D-04 literally, and update the claims `why` for `capability.can-wake-remote` and the model comment
    to say the line means "accepts remote wake for registered targets";
  - (B) keep `can-wake-remote` non-`supported` everywhere, and let the phone learn acceptance from
    `host.wake-broker.v1` plus `host.wake.targets` (below).

  Recommendation: **(B)**. It needs no card copy change and no host change for D-05, and it fully satisfies "no
  `supported` without evidence". (A) is allowed by D-04 but costs a gate `why` edit and a mobile test on GEX44.

**wake-proxy-available (D-05), recommended as a pure shared composer:**
- File `src/shared/host-wake-proxy.ts`, which mobile can import exactly as the presenter imports `src/shared`
  (`host-availability-presentation.ts:1-11`).
- Inputs:
  - the broker connection `{ connected, verdictKind, lastConnectedAt }`;
  - the broker's latest `status.get` snapshot `{ observedAt, result }`, counted only if
    `observedAt >= lastConnectedAt`, the same currency rule as the presenter at `:124-128`;
  - this session's `host.wake.targets` answer `{ observedAt, targets }` under the same rule.
- Output:
  - `{ value: 'wake-proxy-available', evidence: { kind: 'live-response', observedAt } }` only when all three hold:
    connected, the capability list includes `HOST_WAKE_BROKER_RUNTIME_CAPABILITY` (`'host.wake-broker.v1'`,
    `src/shared/protocol-version.ts:152`), and targets ≥ 1;
  - otherwise unknown, with reason `broker_not_connected` (row K), `broker_not_announced` (row M),
    `no_status_this_session` or `no_granted_target`.
- The capability string is the only broker answer the phone needs. The targets reply is already per-device and
  grant-first (19-VERIFICATION live table).

`HOST_CONNECTIVITY_STATES` already contains `'wake-proxy-available'` (`host-availability.ts:31-38`), but
`composeHostAvailability` only ever emits `transport.verdictKind` (`:131-134`). `ConnectionVerdict.kind` is
`normal|warning|unreachable|auth-failed` (`mobile/src/transport/connection-health.ts:31-40`). Two consequences:
- **Do not** widen `ConnectionVerdict` or `composeHostAvailability`. The proxy value belongs to the *target* host's
  connectivity, and the routing from a target card to its broker is the deferred mobile Wake control.
- The composer has no UI consumer in phase 20. State that as WIRED-BUT-UNRENDERED in VERIFICATION, never as a phone
  feature.

**host-card-claims constraints for new labels/evidence:**
- Every `HOST_CARD_LABELS` key must be classified (G1). A claim family needs evidence; an unknown or name family
  must carry none (G3, `check-host-card-claims.mjs:254-284`).
- Effect wording (`wake|power on|...`, `:40`) in card copy fails unless an effect control names an existing RPC
  (`:427-436`).

If phase 20 adds no label (recommended), the gate config needs no new label rows. `capability-value.not-supported`
already lists `os-probe` evidence (`host-card-claims.jsonc:110-115`), so `can-power-on-oob: not-supported` with
os-probe evidence needs no jsonc label change. Its `why` mentions only WOL and should be widened by one clause.

## 3. OOB: interface, double and read-only probe

**Interface:** `src/main/runtime/oob-power.ts`, types only plus refusal codes. Recommended shape:
```ts
// Names are recommendations (Claude's discretion); no production implementation exists (D-06).
export type OobPowerState = 'on' | 'off' | 'unknown'
export type OobPowerResult = { ok: true; stage: 'command-accepted' } | { ok: false; code: 'oob_unavailable' | 'oob_refused' | 'oob_unreachable' }
export interface OobPowerController {
  powerOn(targetId: string): Promise<OobPowerResult>
  readPowerState(targetId: string): Promise<{ state: OobPowerState; observedAt: number }>
}
```
- `powerOn` returns at most `command-accepted`, never "powered on". This is the same law as packet-sent ≠ woken.
- The double is a recording fake **defined inside** `oob-power.test.ts`, or in a file named `*.test-double.ts`
  imported only by tests. Prove it with a test that greps every non-test import of the double and expects 0, and a
  positive control that the grep sees the test's own import.
- Reality Contract tension: an interface with no production implementer is close to a scaffold. Mitigate by making
  the type the documented contract that `can-power-on-oob` refers to (doc comment plus
  `docs/reference/host-wake-broker.md`). Never instantiate it in `src/main/index.ts`.

**Probe:** `src/main/runtime/host-oob-probe.ts` (I/O) + `host-oob-verdict.ts` (pure table). Copy the WOL pattern:
- deps injection `{ platform, now, exec, readText, exists }` (`host-wol-probe.ts:20-26`);
- an `UNREADABLE` constant;
- `execFile` with timeout and `windowsHide`, argv only (`:40-57`);
- a cached read with a single-flight `inFlight`, a max-age check and no timer (`:167-199`);
- `settled()` for tests.

Per-OS reads:
- **Windows:** one `powershell.exe -NoProfile -NonInteractive -Command <constant script>`. The script prints
  `(Get-CimInstance Win32_Processor | Select-Object -First 1).Manufacturer` and
  `@(Get-CimInstance Win32_PnPEntity -Filter "Name LIKE '%Management Engine%'").Count`. **Measured this session on
  this machine:** `AuthenticAMD`, `B450M MORTAR MAX (MS-7B89)` (Win32_BaseBoard), MEI count `0`.
  [VERIFIED: PowerShell read-only probe, 2026-10-27]
  - Spawn through `getWindowsSystemToolPath('WindowsPowerShell\\v1.0\\powershell.exe')`. It exists only as a
    **private** function at `src/shared/secure-path-windows-acl.ts:139-142`:
    `const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'; return pathWin32.join(systemRoot, 'System32', relativeSystem32Path)`.
    Export it, or move it to a concretely named module such as `src/shared/windows-system-tool-path.ts`. AGENTS.md
    bans `utils`/`helpers` names.
  - Do not change the WOL probe here: IN-03 is deferred.
- **Linux:** `readText('/proc/cpuinfo')` → first `vendor_id\s*:\s*(\S+)`; `exists('/dev/mei0')` (or `/dev/mei`).
  [ASSUMED: device node names]
- **macOS:** `exec('sysctl', ['-n', 'machdep.cpu.vendor'])`. Intel Macs print `GenuineIntel`; on Apple silicon the
  key is absent and the exit code is non-zero, which reads as unknown. [ASSUMED]

**Verdict table (D-07), reasons in wire format:**

| Input | Value | Reason (must match `^[a-z0-9_]{1,64}$`) | Evidence |
|---|---|---|---|
| vendor `AuthenticAMD` | `not-supported` | `hardware_bound_amd_no_amt` (rec) | `os-probe` |
| `GenuineIntel`, MEI absent | `unknown` | `intel_mei_not_detected` | null |
| `GenuineIntel`, MEI present | `unknown` | `intel_amt_unverified` | null |
| other vendor / probe fail / exit≠0 / unparseable | `unknown` | `oob_probe_unreadable` / `oob_not_observable_on_platform` | null |

The table never yields `supported`. Copy the "whole table never yields supported" test from 19 (P19-M4 shape).

**Pitfall:** D-07 writes `HARDWARE_BOUND`. On the wire, `parseCapability` maps a non-matching reason to
`'unspecified'` (`src/shared/host-availability.ts:190, 213-216`). Keep `HARDWARE_BOUND` as the *VERIFICATION
label* and put a lowercase reason on the wire.

**Feed:** add `oob: { read: () => HostCapability }` to `HostAvailabilitySources`. Register `hostOobProbe` in both
`index.ts` registrations (3409 and 3529), next to `hostWolProbe`, and replace `unknownCapability('oob_not_measured')`
with `sources?.oob.read() ?? unknownCapability('oob_reader_unregistered')`. `check:recurring-work` must stay
debt=0. The probe has no timer; 19 kept total 236 unchanged with the same pattern (19-VERIFICATION D-03 row).

## 4. Failure matrix K / L / M

What exists today:
- **No phone-side wake client exists.** The mobile control is deferred: grep for `host\.wake` in `mobile/src`
  returns nothing, and only the CLI admin and the shared module mention it. So K and M are proven at the shared
  composer (section 2) plus the host.
- **K, broker offline:**
  - Host side, the target's own availability already composes silence to unknown
    (`composeHostAvailability`, `host-availability.ts:135-139`: `not_connected` / `no_live_response`).
  - `composeWakeProgress(null | non-array, …)` returns `[]` (`host-wake.ts:120-126`), so no stage is invented.
  - New tests:
    - Composer: broker disconnected → unknown `broker_not_connected`, never `wake-proxy-available`. Positive
      control: connected, capability present, ≥ 1 target gives available.
    - A stale snapshot (`observedAt < lastConnectedAt`) is ignored. Mutant: drop the currency check → CAUGHT.
    - Optional: a laptop unit that sends a request to a closed loopback port through the phone-protocol client gets
      a transport error, which maps to unknown and is never `powered-off`. Positive control: `power.powered-off` has
      no label key (the claims gate G4 already enforces this).
- **L, revoked phone over the relay:** the new relay-dispatch test in section 1. Reuse the 19 assertions
  (`wake-broker-revoke-in-process.test.ts:111-153`).
  - Mutant P20-L1: `wake-broker.ts` `const verdict = authority.authorize(caller.token)` → forced ok, the P19-M6
    anchor. It must be CAUGHT by the relay test's in-flight refusal.
  - Mutant P20-L2: `mobile-socket-wiring.ts:165` relay device-id check → `false &&`. It must be CAUGHT by the
    "binding for device A, token for device B never gets ready" row.
  - Positive control: the same flow with matching ids reaches the broker.
- **M, version mismatch:**
  - (i) Old broker: a `status.get` without `host.wake-broker.v1` makes the composer return `broker_not_announced`,
    and a phone-side `planWakeRequest` returns "do not send". Positive control: with the capability, it sends.
  - (ii) Host side: a host without the flag already refuses `wake_broker_disabled`
    (`wake-broker-host.ts:61-63`; 19 live table).
  - (iii) Old client: the announcement stays additive. Pin it with a test that:
    - `HOST_CAPABILITY_IDS` remains the 6 ids (`host-availability.ts:147-154`);
    - `hostAvailability` keys are exactly `schema, processKind, observedAt, capabilities`;
    - the phase-18 parser over a phase-20 announcement yields the same six entries.
  - Mutant: add a 7th capability id → CAUGHT.
  - An old host has no `host.wake.request` method at all. The dispatcher's code for an unknown method is
    [ASSUMED `method_not_found`]; verify in `rpc/core` or the dispatcher before asserting it.

Mutant protocol: use the 19-VERIFICATION driver exactly (`19-VERIFICATION.md:80-84`). Run it with `pnpm.cmd`, not
`pnpm.ps1`: `pnpm.ps1` joined two test paths into one filter (`:99-100`).

## 5. Baseline ratchet (D-10)

**Structure:** `check-host-card-claims.mjs` exports a pure `evaluateHostCardClaims({ config, files, read, rpcMethods, vocab })`
(`:374-443`) and a `main` (`:472-497`).
- Gates G1-G5 are listed in the header (`:24-28`).
- Floors: `MIN_LABELS=20`, `MIN_PRESSABLES=2`, `MIN_RPC_METHODS=20` (`:35-37`).
- `EFFECT_VERB` (`:40`).
- RPC method names are scanned from `config.rpcMethodsDir` (`:453-470`).
- Config: `config/host-card-claims.jsonc` holds `card`, `presenter`, `model`, `rpcMethodsDir`, `labels` and
  `actions` (`:19-148`).
- Unit tests: `config/scripts/check-host-card-claims.test.mjs`, collected by `config/vitest.config.ts:26-27`
  (`'config/scripts/**/*.test.mjs'`).
- CI: `.github/workflows/pr.yml:131-132` (`pnpm run check:host-card-claims`); script at `package.json:51`.
- Extending the same script needs **no CI or package change**.

**Cleanest extension: G6 "capability producers".** Add a `hostCapabilities` section to the jsonc:
```jsonc
"hostCapabilities": {
  "can-wake-lan":     { "producer": "src/main/runtime/host-wol-verdict.ts",           "supported": null, "why": "..." },
  "can-wake-remote":  { "producer": "src/main/runtime/host-availability-producer.ts", "supported": null, "why": "..." },
  "can-power-on-oob": { "producer": "src/main/runtime/host-oob-verdict.ts",           "supported": null, "why": "..." }
}
```
- Rule: with comments stripped (reuse `stripComments`, `:199`), the producer file may contain the literal
  `value: 'supported'` only when `supported` is `{ "evidence": [...kinds], "why" }`. Each kind must be in
  `HOST_EVIDENCE_KINDS`.
- With option (A) from section 2, `can-wake-remote` becomes `{ "evidence": ["relay-reported"] }`.
- Floor: each producer file exists and contains at least one `value: '` literal, so a renamed file cannot pass
  vacuously. Every `HOST_CAPABILITY_IDS` member in this trio must be classified.
- **Known blind spot:** `host-availability-producer.ts:40-44` already emits `value: 'supported'` for `can-relay`.
  Key the scan per producer file *and* per id. For the shared producer file, either restrict the check to the
  `describeRemoteWakeCapability` function body, or classify `can-relay`/`can-direct` too (both `supported` with
  their evidence). Classifying all six ids is the cleanest and least clever option.
- "No wake or power control without a backend method":
  - G5 already fails effect wording without an effect control (`:427-436`), and fails an effect control whose `rpc`
    is not a scanned method (`:320`).
  - Add: an action whose testID or `why` matches `EFFECT_VERB` must be `kind: "effect"`. A power-on control must
    name a method; none exists (no OOB RPC), so any such control fails today.
- Mutants for the gate itself:
  - plant `value: 'supported'` in `host-oob-verdict.ts` → gate exit 1 → restore;
  - plant an unclassified id → exit 1.

## 6. Institutional close (D-11..D-13)

- **Knowledge Vault:** `C:\Users\<owner>\.claude\knowledge_vault\` contains only `core/apex-completion-standard.md`,
  `core/HARD-RULES-DIGEST.md`, `global_vetoes.md` and `lessons/` (3 files). **`INDEX.md` does not exist**, even
  though the global CLAUDE.md references it. [VERIFIED: Glob]
  - Lesson format, as in `lessons/mobile-chat-send-written-is-not-admitted.md:1-32`: no front matter;
    `# <claim> (Orca X <ID>, <date>)`, `## Incident`, `## Why it hid`, `## How it was found`, `## Rules earned`
    (HR / PR / TRAP candidates), `Repo evidence: <path> (branch ...)`.
  - Write new lessons there, e.g. `host-wake-packet-sent-is-not-a-host-woken.md`,
    `host-unreadable-registry-is-unknown.md`, `lint-staged-stale-index-after-commit.md`.
- **UKDL:** `C:\Users\<owner>\.claude\skills\claude-power-pack\vault\knowledge_base\ukdl-universal.md`.
  - Shape: `## <Topic> (<incident/date>)` sections with `### HR-|PR-|T-<NAME>-001` entries plus a short paragraph
    (e.g. `:259-271`). Precedent: `docs/dws/live-2026-10-18-rows-52-53-vault-and-ukdl.md:14-16` (search first for
    existing ids, then append under a dated section).
  - Recommend a section `## Host availability (Orca X phases 17-20, 2026-10-27)` with
    `T-WAKE-PACKET-SENT-IS-NOT-A-HOST-WOKEN-001`, `HR-UNREADABLE-REGISTRY-IS-UNKNOWN-NEVER-PRESENT-001` and
    `T-LINT-STAGED-STALE-INDEX-001`.
  - The Power Pack directory has `.gitignore`/`.gitattributes` at its root and is probably a git checkout
    [ASSUMED]. Appending dirties it. Do not commit there: local and reversible only, and record the before/after
    sha256.
- **docs/reference precedent:** AGENTS.md links one reference note per law section (e.g. `## Terminal Preview
  Observers` → `docs/reference/terminal-preview-observers.md`; `## Detach, Stop, Cancel` →
  `docs/reference/detach-stop-cancel-effects.md`). 27 notes exist and none covers host availability or wake.
  `docs/reference/host-wake-broker.md` with a 3-5 line `## Host Wake` section in AGENTS.md is precedented. It must
  stay short (AGENTS.md style: concise).
- **Fresh-agent test format** (`10-VERIFICATION.md:13`): "fresh read-only agent, no chat context, N questions (…):
  N/N correct with file:line cites; its gaps fixed in STATE". Record it as a SC row with PASS and the gap list.
- **STATE.md today** (`.planning/STATE.md`): sections Current Position, Completed phases, Deferred Verification
  (table with a Resume column, row 19 at `:51`), Owner decisions, Blocked, GEX44 recipe (`:66-70`), Decisions
  (unattended), Laws (`:89-100`), Facts, Owner-only (`:114-116`), Session. Add `## Owner summary` (what works, what
  needs the Owner in order: BIOS b, always-on node c, cloud auth on that node, then the ordered M2/M3 procedure)
  and `## Agent resume block` (branch, HEAD, deferred rows 17-20 with resume commands, laws pointer, next action).

## 7. Test commands proven on this laptop; GEX44 needs

- Single file: `pnpm exec vitest run --config config/vitest.config.ts <file>`. From a PowerShell driver use
  `pnpm.cmd` (`19-VERIFICATION.md:41, 99-100`). Measured about 7 s per file (STATE Laws `:98`).
- Typecheck: `pnpm typecheck:node` and `tsc --noEmit -p config/tsconfig.tc.web.json` (19-01/19-02 summaries). Also
  `typecheck:cli` if `src/shared` changes are reachable by the CLI (19-04 hit this).
- Gates: `pnpm check:host-card-claims`, `pnpm check:recurring-work`, `pnpm check:durability-contracts`.
- Laptop is enough for: the relay-dispatch test (Node + `ws` + tweetnacl, all loopback), the producer/probe/
  composer tests, the gate tests and every mutant.
- GEX44 is needed **only** if a `mobile/` file changes (presenter copy under option A, or a mobile test of the
  composer). Recipe: STATE `:66-70`.
- No out/ rebuild is needed: the off-LAN live leg is OWNER_BOUND (D-03) and cannot run on a disposable host
  without cloud auth.

## Common Pitfalls

1. **Uppercase wire reasons** (`HARDWARE_BOUND`) parse to `unspecified`. Use lowercase. Add a test that every
   probe reason matches the pattern.
2. **A dispatcher-direct test is not the relay path.** `callInFlight` (`wake-broker-revoke-in-process.test.ts:92-100`)
   skips the wiring, the E2EE and the allowlist. D-02 needs real relay frames.
3. **The relay test needs `enableWebSocket: true`**, or `getMobileSocketWiring()` is null (`runtime-rpc.ts:664, 1411`).
4. **`can-relay` already emits `supported`** in the producer file. A naive G6 literal scan fails or must exempt it.
   Classify all six ids.
5. **"Remote wake: yes" on a broker card** reads as a claim about the broker itself (option A). Decide A or B
   explicitly.
6. **A wake-proxy composer with no UI consumer** must be labelled honestly (no phone feature claimed).
7. **The OOB double leaking into production** is a Reality Contract violation. Back the guard with an import
   sweep that has a positive control.
8. **Recurring-work:** the OOB probe must be request-driven (no `setInterval`), or `check:recurring-work` fails.
9. **Writing the UKDL dirties the Power Pack checkout.** Never commit it, and record hashes.
10. Never present the UNIT relay leg or the SCRIPTED leg as M3 (D-03).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | Linux MEI node is `/dev/mei0` (or `/dev/mei`) | 3 | Intel+MEI host reads `intel_mei_not_detected` (still unknown, never supported) |
| A2 | macOS `sysctl -n machdep.cpu.vendor` is absent on Apple silicon (non-zero exit) | 3 | reads unknown; harmless |
| A3 | Unknown RPC method code is `method_not_found` | 4 | wrong expected code in the M test; check the dispatcher first |
| A4 | claude-power-pack dir is a git checkout | 6 | only affects how the UKDL append is recorded |
| A5 | The Win32_PnPEntity `'%Management Engine%'` name match finds an Intel MEI when present | 3 | an Intel host reads MEI absent → unknown (never supported) |

## Open Questions

1. **D-04 option A or B?** Recommendation: B. The phone learns broker acceptance from `host.wake-broker.v1` plus
   `host.wake.targets`, and `can-wake-remote` stays non-supported, so the card is unchanged and no GEX44 run is needed.
2. **Classify can-relay / can-direct in G6 too?** Recommendation: yes, all six ids, so the scan has no exemption.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| PowerShell + CIM | Windows OOB probe | yes | measured this session | — |
| node / pnpm (junction node_modules) | single-file vitest | yes (19 runs) | — | — |
| `ws`, `tweetnacl` | relay-dispatch test | yes (used by existing integration test) | — | — |
| Cloud relay auth | live M3 leg | no | — | OWNER_BOUND (D-03) |
| Always-on LAN node | live M3 leg | no | — | OWNER_BOUND |
| GEX44 | mobile tests only | yes (ssh gex44) | — | not needed under option B |

## Validation Architecture

| Property | Value |
|---|---|
| Framework | vitest (`config/vitest.config.ts`) |
| Quick run | `pnpm exec vitest run --config config/vitest.config.ts <file>` |
| Gates | `pnpm check:host-card-claims`, `check:recurring-work`, `check:durability-contracts`, `typecheck:node` |

| Row/SC | Behavior | Test file (new unless noted) |
|---|---|---|
| SC1/D-02, L | relay-delivered wake: same auth, dedupe, refusals, revoke | `src/main/runtime/wake-broker-relay-dispatch.test.ts` |
| SC1/D-04 | remote-wake capability table | `src/main/runtime/host-availability-producer.test.ts` (extend) |
| SC2/D-06 | OOB interface + double, no prod import | `src/main/runtime/oob-power.test.ts` |
| SC2/D-07 | OOB verdict table never supported; reasons match pattern | `src/main/runtime/host-oob-verdict.test.ts`, `host-oob-probe.test.ts` |
| K, M, D-05 | wake-proxy composer + plan-request | `src/shared/host-wake-proxy.test.ts` |
| M (old client) | announcement additive, 6 ids | `src/shared/host-availability.test.ts` (extend) |
| D-10 | G6 ratchet | `config/scripts/check-host-card-claims.test.mjs` (extend) |

Wave 0: none. The framework and fixtures exist (`runtime-rpc-mobile-ws-test-harness`,
`runtime-rpc-worktree-store-fixtures`, `simulated-mobile-e2ee-v2-peer`).

## Security Domain

| ASVS | Applies | Control |
|---|---|---|
| V2 Authentication | yes | E2EE v2 device token; relay device-id binding (`mobile-socket-wiring.ts:163-167`) |
| V4 Access Control | yes | per-message `assertDeviceStillAuthorized`, mobile allowlist, broker grant + effect re-judge, admin `isLocalRpcCaller` |
| V5 Input Validation | yes | total parsers (`parseCapability`), reason pattern, probe output parsing with argv-only exec |
| V6 Cryptography | no new | reuse NaCl E2EE |

| Threat | STRIDE | Mitigation |
|---|---|---|
| Relay forwards a frame for a different device | Spoofing | E2EE resolve rejects a `relayDeviceId` mismatch; test + mutant P20-L2 |
| Revoked phone keeps a relay socket | Elevation | per-message re-auth + broker effect re-judge; P20-L1 |
| Probe command injection | Tampering | constant script, argv-only `execFile`, absolute System32 path |
| False "woken"/"powered on" | Repudiation/Info | stage law; OOB never beyond `command-accepted`; G6 ratchet |

## Sources

### Primary (HIGH, read this session)
- `src/main/runtime/runtime-rpc.ts:240,378-380,664,1411,1432-1493,1749-1888`
- `src/main/runtime/rpc/mobile-socket-wiring.ts:1-200`
- `src/main/runtime/relay/desktop-relay-service.ts:50-129`
- `src/main/runtime/relay/mobile-relay-e2ee.integration.test.ts`
- `src/main/runtime/relay/simulated-mobile-e2ee-v2-peer.ts`
- `src/main/runtime/wake-broker-revoke-in-process.test.ts`
- `src/main/runtime/wake-broker-host.ts`
- `src/main/runtime/rpc/methods/host-wake.ts:30-55`
- `src/main/runtime/rpc/local-rpc-caller.ts:8-16`
- `src/main/runtime/host-availability-producer.ts`
- `src/shared/host-availability.ts`
- `src/shared/host-wake.ts`
- `src/main/runtime/host-wol-probe.ts`
- `src/shared/secure-path-windows-acl.ts:139-142`
- `src/main/index.ts:3400-3433,3529-3534`
- `mobile/src/components/host-availability-presentation.ts`
- `mobile/src/transport/connection-health.ts:31-40`
- `config/host-card-claims.jsonc`
- `config/scripts/check-host-card-claims.mjs`
- `.github/workflows/pr.yml:131-132`
- `config/vitest.config.ts:26-27`
- 19-VERIFICATION, 19-REVIEW, 10-VERIFICATION, STATE, HOST-AVAILABILITY-PLAN
- vault lesson file, UKDL file, docs/dws rows 52-53 note
- Live read-only CIM probe (AuthenticAMD, MS-7B89, MEI 0)

## Metadata
- Standard stack: HIGH (no new packages; all reuse)
- Architecture: HIGH (dispatch path read end to end)
- Pitfalls: HIGH for 1-5, 7-9; MEDIUM for 6

**Research date:** 2026-10-27. **Valid until:** 2026-11-26 (stable internal code; re-check if runtime-rpc.ts or mobile-socket-wiring.ts change).

## RESEARCH COMPLETE
