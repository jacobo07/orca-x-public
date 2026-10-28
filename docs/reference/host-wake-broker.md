# Host Wake Broker

A sleeping PC cannot answer a phone. Something else on its LAN has to send the magic packet, and
that something has to decide who may ask. This note covers that broker, what the host says it can
do, and the out-of-band (OOB) power boundary.

## Status

| Piece | Status | Proof |
| --- | --- | --- |
| LAN Wake Broker (`orca serve --wake-broker`) | LIVE, SCRIPTED CLIENT (phase 19) | `src/main/runtime/wake-broker-scripted-client.live.test.ts` |
| Same broker reached through the relay | UNIT in-process relay (phase 20); never M3 | `src/main/runtime/wake-broker-relay-dispatch.test.ts` |
| Off-LAN wake from a phone on 5G (M3) | OWNER_BOUND | ordered procedure in `.planning/phases/20-*/20-VERIFICATION.md` |
| Real OOB power-on (M4) | HARDWARE_BOUND on this host (measured board: AMD B450M consumer board, no AMT); the wire reads `unknown` | `src/main/runtime/host-oob-probe.live.test.ts` |
| Mobile Wake control on the host card | DEFERRED (19 D-13) | `check:host-card-claims` still classifies 2 controls, both navigation |

## The broker role

The broker runs on an always-on node on the same LAN as the target, never on the target itself. It
starts only behind `orca serve --wake-broker` (serve mode; never the desktop app). While it is
enabled, `status.get` advertises `host.wake-broker.v1`; without the flag every `host.wake.*` call
answers `wake_broker_disabled`.

- Core: `src/main/runtime/wake-broker.ts` (authority, dedupe, stages) and
  `src/main/runtime/wake-broker-host.ts` (enable, capability, device authority attach).
- Phone methods: `src/main/runtime/rpc/methods/host-wake.ts` (`host.wake.request`, `host.wake.status`,
  `host.wake.targets`). The phone sees a target id and label, never a MAC.
- Owner administration: `src/main/runtime/rpc/methods/host-wake-admin.ts` behind
  `orca wake target add|list|remove` and `orca wake grant add|remove|list`
  (`src/cli/handlers/wake.ts`). Every admin method refuses a non-local caller
  (`remote_caller_refused`); the CLI refuses an SSH relay or remote client before any call.
- Targets and grants are crash-durable (`src/main/runtime/wake-broker-store.ts`); a revoke drops the
  device's grants.

## Authority lives at the effect, keyed by device

The broker judges device, grant and target when the request arrives and again just before the
packet is sent. The key is the paired device. The transport is provenance, never identity: a
request that arrived over the relay meets the same checks, dedupe and refusal codes as one that
arrived direct. There is no relay-specific branch to forget, because the dispatch context carries
no transport field.

That claim is proven through real relay frames, not inferred from the absence of a branch.
`src/main/runtime/wake-broker-relay-dispatch.test.ts` drives a simulated E2EE phone through a
loopback relay cell (`src/main/runtime/relay/loopback-relay-cell.ts`) and a real
`CloudRelayTransport` into the server's own `src/main/runtime/rpc/mobile-socket-wiring.ts`. A relay
leg bound to one device that presents another device's token is refused there (`e2ee_error`); a
revoke inside the dispatch window is refused at the effect with `wake_device_revoked`. Mutants
P20-L1 and P20-L2 prove both rows can fail. This is the label **UNIT in-process relay**; it is not
the live off-LAN leg.

An unreadable device registry is **unknown**, never present: the device check returns
present/absent/unknown, and unknown refuses the request and keeps the grants
(`src/main/runtime/wake-broker.ts`, 19 WR-01).

## The stage law

A wake packet sent is not a host woken. The broker can only write `requested`, `authorized`,
`packet-sent` (or `packet-send-failed`): `HOST_WAKE_BROKER_STAGES` in `src/shared/host-wake.ts`
plus that failure stage are the only stages a broker record may carry. `host-announced` comes only from the target's own answer after
the packet, and `runtime-ready` from its runtime. A broker that wrote `host-announced` itself would
be reporting its own send as the target's state (mutant P19-M3).

## Capabilities: what the host may claim

Every value comes from a producer in `src/main/runtime/host-availability-producer.ts` and is
parsed by `src/shared/host-availability.ts`. None of the three wake or power capabilities may read
`supported` in this release.

- **can-wake-lan**: measured by a read-only probe (`src/main/runtime/host-wol-verdict.ts`). OS
  arming can be read; firmware cannot, so the best answer is `unknown / firmware_unverified`.
  `supported` is owed to an observed wake (a host-announced resume after a packet this broker sent).
- **can-wake-remote**: `not-configured / no_wake_broker` on every host, from one producer,
  `describeRemoteWakeCapability` (D-04 option B). A broker serves wake targets; it is not one. A
  target cannot know from its own configuration that some broker will wake it. A phone learns that
  a broker accepts remote wake from that broker's `host.wake-broker.v1` capability plus a current
  `host.wake.targets` answer, never from this capability.
- **can-power-on-oob**: measured read-only from the CPU vendor and the Intel management engine
  (`src/main/runtime/host-oob-verdict.ts`, `src/main/runtime/host-oob-probe.ts`). AMD reads
  `unknown / amd_no_amt_oob_unmeasured`: AMT is Intel-only, but a CPU vendor does not rule out DASH
  or a BMC, which the probe never reads. Intel and every read failure also read `unknown`. No branch
  yields `supported`, and none yields `not-supported`.
- **wake-proxy-available** (connectivity, phone side): composed in `src/shared/host-wake-proxy.ts`
  only from this session's broker answers (connected, a current `status.get` with
  `host.wake-broker.v1`, a current `host.wake.targets` with a well-formed target). Anything else is
  `unknown` with a named reason, and `planWakeRequest` refuses to send. It has no UI consumer yet:
  UNIT, WIRED-BUT-UNRENDERED.

### Wire reasons are lowercase

A reason on the wire must match `^[a-z0-9_]{1,64}$`; anything else parses to `unspecified`. The
uppercase words in verification files (`HARDWARE_BOUND`, `OWNER_BOUND`) are labels for people. They
are never wire reasons: `HARDWARE_BOUND` sent as a reason would reach the phone as `unspecified`.
The wire carries `amd_no_amt_oob_unmeasured`.

## OOB power contract

`src/main/runtime/oob-power.ts` is types only: power-on (capped at `command-accepted`, never
"powered on") and a power-state read. There is no production implementation. The one implementer
is a recording double, `src/main/runtime/oob-power-test-double.ts`, and
`src/main/runtime/oob-power.test.ts` sweeps all of `src` to prove only tests import it, with a
positive control and a station control. Nothing in production may report a powered-on result from
the double.

## The ratchet

`pnpm check:host-card-claims` (`config/scripts/check-host-card-claims.mjs`) runs G6
(`config/scripts/host-capability-producer-gate.mjs`) over the `hostCapabilities` section of
`config/host-card-claims.jsonc`. Every capability id is classified to a producer. A producer may
emit `supported` only under an evidence allowance whose kinds it quotes; `can-wake-lan`,
`can-wake-remote` and `can-power-on-oob` are pinned to `supported: null`. Each entry also lists its
`emitters`, the probe wrappers that construct the value `status.get` serves (`host-oob-probe.ts`,
`host-wol-probe.ts`, `host-autostart-probe.ts`), and R7 scans them under the same rule, so a
`supported` planted in a probe fails too (mutant P20-O3). A new capability id, a missing section or
`emitters` key, a vacuous producer or a stale allowance fails the gate. The success line ends
`6 capability producers classified, 3 capability emitters scanned.` G5 in the same gate refuses
a card control whose wording promises an effect (such as "Wake") without a host RPC behind it.

## Owner procedure

The live off-LAN leg needs cloud auth for the relay on the broker node (until then `can-relay`
reads `needs-owner-setup / cloud_auth_not_configured`, from
`src/main/runtime/relay/host-relay-startup.ts`), the BIOS step (Resume by PCI-E / LAN on, ErP off)
and an always-on LAN node. The ordered procedure is in the M3 section of
`.planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-VERIFICATION.md`;
the LAN-only procedure is in the phase 19 verification.
