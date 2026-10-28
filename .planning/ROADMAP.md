# Roadmap: Phone control of a live Orca X session, then DWS convergence

## Overview

Prove the existing mobile RPC path (paired phone to a live laptop PTY, fresh output, reconnect, revocation) before any DWS work, then extend it with host and runtime scoping, the Agent prompt path, and DWS semantics (rows 33, 39, 70, 75). DWS extends the mobile owner; it never duplicates it. Remote-control Product Reality and cross-host-continuation Product Reality are separate gates.

## Phases

- [x] **Phase 1: Reality close and RED** - Re-read the full reasons of DWS rows 12, 33, 39, 75; confirm mobile slices 1-4 are intact on this tree; map the canonical owners; write the RED test for a fresh-output oracle (nonce after a marker, never history).
- [x] **Phase 2: Scoped terminal input and fresh-output oracle** - Mobile input is scoped by host and by runtime; newest-terminal targeting, wrong host, wrong runtime and stale generation are refused; the oracle rejects historical text.
- [x] **Phase 3: Reconnect and revocation** - Disconnect does not kill the remote PTY; reconnect restores the same session identity without a duplicate; a revoked device with a live socket is refused at the next mutation.
- [x] **Phase 4: Host and runtime selector truth** - Hosts and runtimes come from real producers only; switching host changes scope and leaks nothing; unknown stays UNKNOWN; no background streams for unselected hosts.
- [ ] **Phase 5: Composer, copy and paste, visual Product Reality** - One bottom command textbox, Copy and Paste through canonical permissions, no duplicate prompt line or Terminal header; captures at target sizes in dark mode with long names and many runtimes.
- [x] **Phase 6: Agent prompt path** - Mobile sends a turn through the canonical conversation owner into the Agent's own project; provider-independent layers proven; a quota or login block is classified EXTERNAL_BLOCKED, never PASS.
- [ ] **Phase 7: Real laptop Product Reality** - The real Windows app hosts the PTY and a paired phone (physical if available, else labelled emulator) drives it end to end; wrong-host and revoked-device legs run live.
- [x] **Phase 8: DWS reconciliation** - Rows 33 and 39 (generation fencing, desktop and mobile stale writes), X16 placement reaches dispatch, X18 relay observation aperture with a positive control, and a verdict on X05, X06, X16, X18 and X19.
- [ ] **Phase 9 (partial, human_needed): Two-host Product Reality and Continue here** - Extend the Windows and GEX44 harness with the mobile controller; row 75 and row 70 re-measured; mutation drills with PLANT_CONFIRMED, CAUGHT, RESTORE_VERIFIED.
- [x] **Phase 10: Institutionalize and close** - Knowledge Vault, UKDL rules and traps, the constitutive baseline ratchet, the fresh-agent test, the DWS matrix re-run, and the two-layer handoff.
- [ ] **Phase 17: Host Service and Orca-closed availability (M1)** - `orca serve` becomes the Host Service: it starts the relay, autostarts on Windows logon as a restart-on-failure Scheduled Task, reports version and capabilities, and starts the runtime idempotently; a phone reaches a host whose Electron UI is closed. Brief: .planning/HOST-AVAILABILITY-PLAN.md.
- [ ] **Phase 18: Availability state, capabilities and a truthful host card** - Three composed dimensions (power, orca, connectivity), capabilities kept apart from state and authority, and a mobile host card that never renders powered-off or Wake without evidence, enforced by a gate.
- [ ] **Phase 19: Wake-on-LAN capability and the LAN Wake Broker (M2)** - Measured WOL capability, a broker role inside the Host Fabric, a REMOTE_WAKE grant, idempotent requests and evidence-staged readiness transitions; the LAN Product Reality is OWNER_BOUND on the admin and BIOS steps.
- [ ] **Phase 20: Off-LAN wake, OOB boundary and institutional close (M3, M4)** - Phone on 5G to broker over the outbound relay; the OOB interface with a test-double boundary (no AMT on this hardware: HARDWARE_BOUND); failure injection, mutants, Knowledge Vault, UKDL, baseline ratchet, fresh-agent test and the two-layer handoff.
- [ ] **Phase 21: Mobile Wake control on the host card** - Wake from a sleeping host's card through the broker that answered this session (target bound to host identity, no MAC on the phone), evidence-staged labels, the claims gate scoped per control with mutants; phone leg owed.

## Phase Details

### Phase 1: Reality close and RED

**Goal**: The ownership graph is written down and a RED test fails for the real missing proof. **Depends on**: Nothing (first phase)
**Success Criteria** (what must be TRUE):

1. The full reasons of rows 12, 33, 39 and 75 are quoted in a phase artifact.
2. A grep-backed list names the canonical owner of host selection, runtime selection, terminal input and Agent turns.
3. The RED test fails because no fresh-output proof exists today, not because of a syntax error.

### Phase 2: Scoped terminal input and fresh-output oracle

**Goal**: A mobile send reaches exactly one PTY and is proven by fresh output. **Depends on**: Phase 1
**Success Criteria** (what must be TRUE):

1. Output present before the send never satisfies the oracle.
2. Mutants (newest terminal, host ignored, generation ignored) are CAUGHT.

### Phase 3: Reconnect and revocation

**Goal**: Reconnect keeps identity and revocation holds at the effect. **Depends on**: Phase 2
**Success Criteria** (what must be TRUE):

1. Session ids before and after reconnect are equal and the PTY count did not grow.
2. A revoked device's next mutation is refused with a distinct code.

### Phase 4: Host and runtime selector truth

**Goal**: Every host and runtime shown has a real producer. **Depends on**: Phase 2
**Success Criteria** (what must be TRUE):

1. Switching host A to B shows none of A's rows and mutates nothing on A.
2. Never-connected renders as unknown, not offline.

### Phase 5: Composer, copy and paste, visual Product Reality

**Goal**: The approved compact black and white mobile terminal is real. **Depends on**: Phase 4
**Success Criteria** (what must be TRUE):

1. Captures registered as truth current for keyboard open, keyboard closed, selector open and long names.
2. Pixel values come from mobile-theme.ts, not from the mockups.

### Phase 6: Agent prompt path

**Goal**: A mobile Agent turn is admitted by the canonical owner. **Depends on**: Phase 4
**Success Criteria** (what must be TRUE):

1. Host and project cannot be overridden by the request when the Agent owns them.
2. The live provider leg is PASS with evidence, or EXTERNAL_BLOCKED with the exact reason.

### Phase 7: Real laptop Product Reality

**Goal**: The first milestone is proven on the real app. **Depends on**: Phase 3, Phase 5
**Success Criteria** (what must be TRUE):

1. Paired client, laptop PTY, nonce, fresh output, reconnect and revocation all observed live.
2. Emulator evidence is labelled emulator.

### Phase 8: DWS reconciliation

**Goal**: DWS extends the mobile owner. **Depends on**: Phase 7
**Success Criteria** (what must be TRUE):

1. Stale desktop and stale mobile writes are both refused; the current controller is accepted.
2. A relay zero is only reported with a positive control that could have seen the event.

### Phase 9: Two-host Product Reality and Continue here

**Goal**: Host switching and continuation are proven on two real hosts. **Depends on**: Phase 8
**Success Criteria** (what must be TRUE):

1. Row 75 is re-measured on Windows and GEX44 with a mobile controller, or stays PARTIAL with the named residual.
2. Continue here preserves logical project identity, dirty state and Workstream identity, or is not offered.

### Phase 10: Institutionalize and close

**Goal**: A fresh agent can answer every question without this chat. **Depends on**: Phase 9
**Success Criteria** (what must be TRUE):

1. The verifier is re-run and its counts are recorded.
2. The fresh-agent test passes from durable state only.

### Phase 17: Host Service and Orca-closed availability (M1)

**Goal**: A paired phone reaches and uses a host whose Electron UI is closed, with no desktop interaction. **Depends on**: Phase 10
**Success Criteria** (what must be TRUE):

1. RED first: with the UI closed and serve running, the phone cannot reach the host off-LAN because serve never starts the relay; this is captured as a failing test before the fix.
2. serve starts the relay when cloud auth exists and reports `relay: unavailable` otherwise; a Windows logon Scheduled Task (restart on failure) starts serve, and repeated starts never create a second runtime (single-instance lock, exit code 3).
3. Live, on the Owner's PC: UI closed, serve running, a paired client opens a terminal, a unique command returns fresh output, the runtime count stays 1; idle RAM, CPU and startup time of serve are recorded.

**Plans:** 3/3 plans executed
Plans:

- [x] 17-01-PLAN.md — RED wiring test, one relay owner for serve and desktop, appVersion + relay in readiness (wave 1)
- [x] 17-02-PLAN.md — `orca serve autostart install|remove|status` (Windows logon task), lock-held exit 0 for autostart (wave 2)
- [x] 17-03-PLAN.md — live legs: disposable serve host (SCRIPTED CLIENT) + disposable task, measurements, OWNER_BOUND checkpoint (wave 3)

### Phase 18: Availability state, capabilities and a truthful host card

**Goal**: The phone says what Orca knows, what it can do and what it cannot know. **Depends on**: Phase 17
**Success Criteria** (what must be TRUE):

1. Power, orca and connectivity are separate composed fields, and no response renders as unknown, never powered-off.
2. Capabilities (can-start-orca, can-wake-lan, can-wake-remote, can-power-on-oob) are separate from state and from grants; the Node Manifest change is additive and coordinated with the C:\ox DWS lane.
3. A gate fails when the host card can render powered-off without evidence or an action without a backend effect; mutants for both are CAUGHT.

**Plans:** 3/3 plans executed
Plans:

- [x] 18-01-PLAN.md — shared availability model + composer, capability set, status.get producer behind host.availability.v1, autostart probe, index.ts wiring (wave 1)
- [x] 18-02-PLAN.md — home status fetch, pure presenter + label table, MobileHostCard projection, GEX44 disposable mobile runs (wave 2)
- [x] 18-03-PLAN.md — `check:host-card-claims` gate + CI, mutant drills, 18-VERIFICATION.md, Node Manifest proposal (wave 3)

### Phase 19: Wake-on-LAN capability and the LAN Wake Broker (M2)

**Goal**: An authorized wake on the same LAN, proven as separate evidence stages. **Depends on**: Phase 18
**Success Criteria** (what must be TRUE):

1. WOL capability is measured (NIC, driver, OS arming, firmware) and reported as supported, not-supported, not-configured, needs-owner-setup or unknown.
2. The broker role issues the magic packet only for an authorized, unrevoked device with a REMOTE_WAKE grant; duplicate requests are idempotent; a packet sent is never reported as a host woken.
3. LAN Product Reality (host sleeping, wake, Host Service reconnects, terminal works) is PASS, or OWNER_BOUND naming the exact admin or BIOS step still missing.

**Plans:** 1/5 plans executed
Plans:

- [x] 19-01-PLAN.md — read-only WOL probe + verdict tables, can-wake-lan from the probe at both start paths, claims evidence (wave 1)
- [x] 19-02-PLAN.md — broker core: authority at the effect, dedupe/adopt, stages, dgram magic packet, crash-durable targets/grants, phone RPCs + passthrough codes (wave 1)
- [x] 19-03-PLAN.md — `orca serve --wake-broker` flag chain, serve-only enable, host.wake-broker.v1 in getStatus, device authority + revoke purge + mobile allowlist (wave 2)
- [x] 19-04-PLAN.md — `orca wake target|grant` CLI over local-only host.wake.admin.* methods, SSH-relay refusal (wave 2)
- [x] 19-05-PLAN.md — SCRIPTED CLIENT live leg with UDP positive control, WOL probe measured, mutants M1-M6, 19-VERIFICATION.md (LAN Product Reality OWNER_BOUND a, b, c; Wake control deferred per D-13) (wave 3) — human_needed, 555cb218b

### Phase 20: Off-LAN wake, OOB boundary and institutional close (M3, M4)

**Goal**: Wake from 5G through an authorized broker, and an honest powered-off story. **Depends on**: Phase 19
**Success Criteria** (what must be TRUE):

1. Phone on 5G to relay to broker to target, with fresh terminal output and no inbound public port; or OWNER_BOUND when no always-on LAN node exists.
2. A generic OOB power interface with a test double; real OOB is HARDWARE_BOUND on this AMD host and is never presented as real.
3. Failure matrix rows K, L, M are proven; mutants report PLANT_CONFIRMED, CAUGHT and RESTORE_VERIFIED; Knowledge Vault, UKDL, the ratchet gate and a fresh-agent test pass from durable state; two-layer handoff in STATE.md.

**Plans:** 5/5 plans executed
Plans:

- [x] 20-01-PLAN.md — relay-delivered wake proof on a real RuntimeRpcServer (real CloudRelayTransport, loopback relay cell, simulated E2EE v2 phones): positive control, dedupe, refusals, revoke (row L), relay device binding; mutants P20-L1/L2 (wave 1)
- [x] 20-02-PLAN.md — read-only OOB probe + verdict tables (AMD -> not-supported/hardware_bound_amd_no_amt), can-power-on-oob from the probe at both start paths, can-wake-remote pinned non-supported (D-04 option B), one System32 path authority (wave 1)
- [x] 20-03-PLAN.md — shared wake-proxy-available composer (rows K, M; UNIT, unrendered), old-client additive pin, OOB power contract + test-only double + import sweep (wave 1)
- [x] 20-04-PLAN.md — G6 capability-producer ratchet inside check:host-card-claims (all six ids classified), rule table, ten mutants K/M/O/W/G (wave 2)
- [x] 20-05-PLAN.md — reference note + AGENTS.md link, one vault lesson, UKDL proposal, OOB live evidence, 20-VERIFICATION.md (M3 OWNER_BOUND, M4 HARDWARE_BOUND), STATE.md two-layer handoff, fresh-agent question set (orchestrator runs the agent) (wave 3)

### Phase 21: Mobile Wake control on the host card

**Goal**: A paired phone can ask its broker to wake a sleeping host from that host's card, and the card shows the wake's evidence stages truthfully. **Depends on**: Phase 20 (closes 19 D-13)
**Success Criteria** (what must be TRUE):

1. Cross-host routing from evidence: the card of a target host offers Wake only when a broker answered in this session (`host.wake-broker.v1` plus a `host.wake.targets` entry bound to that host's identity), and the request goes to that broker; no binding, no control. No MAC reaches the phone.
2. Stages render as labels from one presenter table (requested, authorized, packet-sent, then host-announced only from the target's own answer); "Woken" never renders from a broker stage; refusal codes render as their own states.
3. `check:host-card-claims` classifies the Wake control with its backend method and the new stage labels, the effect-wording check is scoped per control (no weakening when the first effect control lands), and mutants for both are CAUGHT; mobile tests run on a GEX44 disposable root; the phone leg is owed as human_needed.

**Plans:** 6 plans
Plans:

- [x] 21-01-PLAN.md — broker binding by hostKey (sha256 of the host E2EE key): store/schema (no bump), `host.wake.targets` additive hostKey (no MAC), local-only `host.wake.admin.targetBind` + `host.wake.admin.hostKey`, CLI `orca wake target bind|unbind` and `orca wake host-key` (wave 1)
- [x] 21-02-PLAN.md — shared route composer `composeHostWakeRoute` (one bound broker from this session's answers, `ambiguous_broker` refused, nothing persisted) + phone-side hostKey derivation proven equal to the host fingerprint, pinned vector (wave 2)
- [ ] 21-03-PLAN.md — claims gate first: per-control effect-wording scope replaces the card-wide short-circuit, `wake` label family and observer rule (target-only host-announced/runtime-ready) in a sibling .mjs, `wakeModel` (wave 2)
- [ ] 21-04-PLAN.md — `host-card-wake` Pressable (sibling, no confirm) + 19 `wake.*` labels and `presentHostCardWake` (phone-rebased stages, closed refusal table), jsonc classification, success line 41/3 pinned with notes; GEX44 render tests (wave 3)
- [ ] 21-05-PLAN.md — per-session broker answers, press to the routed broker with a fresh requestId, focus re-reads (no timer), refusals outside the revocation latch, index.tsx wiring; GEX44 full run (wave 4)
- [ ] 21-06-PLAN.md — seven mutants (scope x2, rpc, Woken, no-binding x2, ambiguous), 21-VERIFICATION.md human_needed (phone leg owed, OWNER_BOUND b/c), STATE.md row 21 (wave 5)
