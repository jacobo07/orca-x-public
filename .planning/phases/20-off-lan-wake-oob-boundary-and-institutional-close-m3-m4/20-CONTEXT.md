# Phase 20: Off-LAN wake, OOB boundary and institutional close (M3, M4) - Context

**Gathered:** 2026-10-27
**Status:** Ready for planning
**Mode:** Smart discuss, autonomous (worker epoch 2 of mission m-cf9e66a07a6f; 17, 18, 19 deferred human
verification). Grey areas resolved from the Owner-approved brief (`.planning/HOST-AVAILABILITY-PLAN.md` decisions
5, 6, 7, 8, M3, M4 and the laws); where the brief is silent the recommended option was taken and is marked (rec).

<domain>
## Phase Boundary

Wake from 5G through an authorized broker, and an honest powered-off story. In scope:
- the off-LAN wake path: phone → relay (outbound only) → broker host → magic packet, reusing phase 19's
  `host.wake.*` methods and authority, with no new transport and no inbound port;
- truthful `can-wake-remote` and the connectivity value `wake-proxy-available`;
- a generic OOB power interface with a test double and a measured `can-power-on-oob`;
- failure matrix rows K (broker offline), L (revoked phone), M (version mismatch), with mutants;
- the institutional close: Knowledge Vault, UKDL, baseline ratchet, fresh-agent test, two-layer handoff.

Out of scope: a real OOB controller (no AMT on this hardware), any Owner-PC power or BIOS change, the mobile Wake
control (deferred in 19 under D-13), and Node Manifest edits in `C:\ox` (proposal only).

</domain>

<decisions>
## Implementation Decisions

### Off-LAN wake path (SC1)
- D-01: Off-LAN wake is the same `host.wake.request` / `host.wake.status` call, delivered to the broker host over
  the existing relay transport the phone already uses for that host. No second remote-control transport (law),
  no public inbound port, no public wake endpoint. Authority stays at the broker's effect (19 D-08), whatever the
  transport. The relay is provenance, never identity.
- D-02: Prove transport independence in code: a wake arriving through the relay dispatch path meets the same
  authorization, dedupe and refusal codes as one arriving direct. Use the narrowest real seam the relay
  frames reach, and mutant-check that a relay-delivered request cannot skip the device check.
- D-03: The live off-LAN leg (phone on 5G → relay → broker on the LAN → target wakes → fresh terminal output) is
  OWNER_BOUND:
  - a broker host needs cloud auth for the relay (`host-relay-startup.ts`: `cloud_auth_not_configured`), and a
    disposable host has none;
  - the LAN has no always-on node (Owner step c);
  - the BIOS step (b) is outstanding.
  Record the exact steps and the ordered procedure. Never present the unit or SCRIPTED legs as M3.

### Capabilities and connectivity (SC1, SC2)
- D-04 (rec): `can-wake-remote` on a host stays non-`supported` unless there is evidence. A broker host that is
  enabled, has relay readiness `supported` and at least one registered target may announce that it can accept
  remote wake requests (reason e.g. `broker_relay_ready`). A target host never claims it can be woken remotely
  from configuration alone. The planner settles which host announces what. Rule: no `supported` without the
  evidence kind that proves it; a packet sent is not a host woken.
- D-05 (rec): `wake-proxy-available` connectivity is composed on the phone side only from a broker answer
  received in this session. It never comes from cached or assumed state; unknown stays unknown.

### OOB boundary (SC2)
- D-06: A generic OOB power interface (power-on, power-state read) with a test double used only by tests. There is
  no real implementation in production paths. Nothing in production may report a powered-on result from the
  double (Reality Contract).
- D-07 (rec): `can-power-on-oob` is measured read-only:
  - AMD CPU: `not-supported`, reason `HARDWARE_BOUND` (AMT is Intel-only), evidence `os-probe`;
  - Intel without a management engine interface detected: `unknown`;
  - probe failure: `unknown`.
  It is never `supported` in this phase. The board is measured as an AMD platform (MSI MS-7B89).
- D-08: M4 (powered off) is HARDWARE_BOUND. WOL from S5 with Fast Startup off is OWNER_BOUND and never assumed
  (brief M4).

### Failure matrix and mutants (SC3)
- D-09: Rows:
  - K, broker offline: no wake is offered; any request is reported as unknown or unreachable, never as
    powered-off or woken.
  - L, revoked phone: refused at the effect (reuse 19's in-process proof, extended to the relay-delivered path).
  - M, version mismatch: an old broker without `host.wake-broker.v1` gets no wake request; an old client still
    sees phase 18 fields only.
  Each row has a positive control. Mutants report PLANT_CONFIRMED, CAUGHT, RESTORE_VERIFIED.
- D-10 (rec): The baseline ratchet extends an existing gate rather than adding a parallel one: no `supported`
  for `can-wake-lan`, `can-wake-remote` or `can-power-on-oob` without an evidence producer, and no wake or
  power control without a backend method. Likely home: `check:host-card-claims` or a sibling under
  `config/scripts`. Wired into CI the way 18-03 did.

### Institutional close (SC3)
- D-11: Knowledge Vault and UKDL entries live outside this repo (`~/.claude/knowledge_vault/`, the UKDL of the
  project), as in phase 10. Write them only as local, internal, reversible files: one lesson and one rule per
  law learned (e.g. "a wake packet sent is not a host woken"; "an unreadable registry is unknown, never present";
  "lint-staged stale index"). Inside the repo, durable knowledge goes to `docs/reference/` only where AGENTS.md
  already points (rec: a short `docs/reference/host-wake-broker.md` linked from AGENTS.md is allowed if the
  planner finds a precedent).
- D-12: Fresh-agent test: a read-only agent with no chat context answers a fixed question set (branch and laws,
  phase status and resume commands, Owner-only steps, what is proven vs owed for 17-20, next action) from
  durable state only, with file:line citations. Gaps found are fixed in STATE.md.
- D-13: Two-layer handoff in STATE.md: an Owner-facing summary (what works, what needs the Owner, in order) plus
  an agent-facing resume block. Milestone audit, complete and cleanup are NOT run while phases are
  human_needed (decision of 2026-10-26).

### Proof and laws
- D-14: Node-side tests run as single files here; heavy builds and mobile runs go to a GEX44 disposable root with
  teardown proof. No Owner-PC effects. Never push. UDP to loopback only.

### Claude's Discretion
Interface and file names, the exact `can-wake-remote` reason vocabulary, which gate file the ratchet extends, and
the fresh-agent question wording.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 19:
  - `src/main/runtime/wake-broker.ts` (authority, dedupe, stages, `wakeDeviceState`);
  - `rpc/methods/host-wake.ts` and `host-wake-admin.ts`;
  - `wake-broker-host.ts`;
  - `wake-broker-revoke-in-process.test.ts`;
  - `wake-broker-scripted-client.live.test.ts`;
  - `host-wol-probe.ts` and `host-wol-verdict.ts`, the read-only probe pattern for an OOB/CPU probe.
- `src/main/runtime/host-availability-producer.ts`: `can-wake-remote` (`no_wake_broker`) and `can-power-on-oob`
  (`oob_not_measured`) are still phase 18 values.
- `src/main/runtime/relay/host-relay-startup.ts`: relay readiness and the `cloud_auth_not_configured` reason.
- `src/main/runtime/runtime-rpc.ts`: dispatch, the mobile allowlist and how relay frames reach handlers.
- `config/host-card-claims.jsonc` and `config/scripts/check-host-card-claims.mjs`: ratchet candidate.
- `mobile/src/transport/connection-health.ts`: `ConnectionVerdict`.

### Established Patterns
- Effect-time authority keyed by subject, never by transport.
- Additive capability strings.
- Presenter tables plus a gate.
- Mutant drill protocol (18-VERIFICATION, 19-VERIFICATION).

### Integration Points
- `src/main/index.ts` producer registration (serve and desktop).
- The relay dispatch into `runtime-rpc.ts`.
- `.planning/STATE.md` for the handoff.

</code_context>

<specifics>
## Specific Ideas

- Laws: the machine is the node, not the UI; unreachable is not powered off; a wake packet sent is not a host
  woken; a host awake is not a runtime ready; no button without a backend effect.
- Measured: AMD MSI MS-7B89, no AMT. On this laptop the Realtek adapter is armed and magic packet is enabled
  (19-01). Fast Startup is on. The LAN has no always-on node.

</specifics>

<deferred>
## Deferred Ideas

- The mobile Wake control (19 D-13): needs cross-host routing from a target card to its broker.
- Host pre-suspend announcement as evidence for `sleeping`.
- Broker discovery and target auto-registration.
- 19-REVIEW info items IN-01..IN-05.

</deferred>
