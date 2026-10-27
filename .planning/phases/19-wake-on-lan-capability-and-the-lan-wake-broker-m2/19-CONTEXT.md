# Phase 19: Wake-on-LAN capability and the LAN Wake Broker (M2) - Context

**Gathered:** 2026-10-27
**Status:** Ready for planning
**Mode:** Smart discuss, autonomous (worker epoch 2 of mission m-cf9e66a07a6f, `/gsd-autonomous --from 17`;
17 and 18 are deferred human verification and were skipped). Grey areas resolved from the Owner-approved brief
(`.planning/HOST-AVAILABILITY-PLAN.md` decisions 5, 6, 7 and the laws); where the brief is silent the recommended
option was taken and is marked (rec).

<domain>
## Phase Boundary

An authorized wake on the same LAN, proven as separate evidence stages. In scope: a measured WOL capability for
the host (replacing phase 18's hard-coded `can-wake-lan: not-configured`), a Wake Broker role inside an Orca
host, a `REMOTE_WAKE` grant separate from pairing, an idempotent wake request RPC whose effect is a magic packet,
and staged readiness (requested, authorized, packet-sent, host-announced, runtime-ready). Out of scope: off-LAN
wake through the relay (20), OOB power-on (20), any Owner-PC admin or BIOS change (Owner-only steps a, b), and
Node Manifest edits in `C:\ox` (proposal only, as in 18).

</domain>

<decisions>
## Implementation Decisions

### WOL capability measurement (SC1)
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

### Broker role and target registry (SC2)
- D-04: The broker is a role of any paired Orca host (brief decision 5), enabled explicitly (e.g.
  `orca serve --wake-broker`), never by default. A host that is not a broker refuses wake requests with a
  distinct code (`wake_broker_disabled`).
- D-05 (rec): Wake targets (MAC, broadcast address, port, optional label) live only on the broker. The Owner
  registers them locally on the broker through a CLI (`orca wake target add|remove|list` or equivalent). MACs are
  never sent to the phone and never appear in `status.get` to the phone. The phone names a target by the
  broker-issued target id.
- D-06: The magic packet is the standard frame (6 x 0xFF + 16 x MAC) sent by Node `dgram` UDP broadcast
  (default port 9). No native module, no shell.

### Grant, authorization and idempotency (SC2)
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

### Evidence-staged readiness (SC2, SC3)
- D-11: A wake request returns and reports stages, never a single "woken":
  - `requested`, `authorized`, `packet-sent` (broker only; the dgram send callback succeeded);
  - `host-announced` (the target's Host Service answered `status.get` or reconnected);
  - `runtime-ready` (the target's runtime status is ready).
  A broker never reports `host-announced` from its own send. The law: a wake packet sent is not a host woken.
- D-12 (rec): The new RPC (e.g. `host.wake.request`, plus a stage read `host.wake.status`) is additive and behind
  a new runtime capability string (e.g. `host.wake-broker.v1`), following
  `docs/reference/remote-wire-compatibility.md`: optional fields only, no new stream opcode.

### Mobile projection
- D-13 (rec): The host card may show a Wake control only when all three hold: a broker announces it this
  session, the target capability is not `not-supported`, and the request is a real RPC. The control is
  classified in `config/host-card-claims.jsonc` with a backend effect, so `check:host-card-claims` still passes
  with the new control and the P18 mutants still catch. Wake progress is shown by stage and never as "On"
  until `host-announced`. If wiring the card proves larger than the slice, the control is deferred and the
  SCRIPTED CLIENT drives the RPC; that is recorded, not hidden.

### Proof and laws (SC3)
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

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/main/runtime/host-availability-producer.ts`: `can-wake-lan`/`can-wake-remote` are hard-coded
  `not-configured` / `no_wake_broker` (phase 18 D-05). This phase replaces `can-wake-lan` with the probe.
- `src/shared/host-availability.ts`: capability vocabulary, evidence kinds, and the `wake-proxy-available`
  connectivity value.
- `src/main/runtime/device-authorization.ts`: `assertDeviceStillAuthorized` (effect-time authority) and
  `revokeDeviceAndTerminateConnections`.
- `src/main/runtime/device-registry.ts` and `device-registry-stored-records.ts` (`DeviceScope`, stored records).
- `src/main/runtime/rpc/methods/status.ts` (`status.get`), `src/shared/protocol-version.ts`
  (`RUNTIME_CAPABILITIES`).
- `src/cli/runtime/serve-autostart.ts` and `src/cli/specs/serve.ts`: CLI subcommand pattern from phase 17.
- `config/host-card-claims.jsonc` and `config/scripts/check-host-card-claims.mjs`: the gate any Wake control
  must pass.
- `src/main/durable-file-write.ts`: crash-durable writes.

### Established Patterns
- Effect-time authority keyed by subject (`.claude` rule effect-authority-across-transports).
- Additive capability strings for wire changes.
- Presenter tables plus a gate for mobile claims.

### Integration Points
- `src/main/index.ts` serve and desktop start paths (one shared producer, phase 18).
- The RPC method registry under `src/main/runtime/rpc/methods/`.
- `mobile/src/components/MobileHostCard.tsx` and its presenter.

</code_context>

<specifics>
## Specific Ideas

- Laws: a wake packet sent is not a host woken; a host awake is not a runtime ready; no button without a backend
  effect; unreachable is not powered off.
- Measured hardware (brief): AMD MSI MS-7B89, no AMT; the Realtek driver has Wake on Magic Packet enabled but
  Windows has not armed it (`wake_armed` lists only HID). Fast Startup is on. The LAN has no always-on node.

</specifics>

<deferred>
## Deferred Ideas

- Host pre-suspend announcement as evidence for `sleeping` (powerMonitor `suspend`), so the card can say
  "asleep (announced)" (phase 20, or a later slice).
- Broker discovery and target auto-registration over the LAN.
- Off-LAN wake through the relay, `can-wake-remote` (phase 20).
- Proving S5 wake with Fast Startup off (M4, phase 20).

</deferred>
