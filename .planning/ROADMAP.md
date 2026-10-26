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
- [ ] **Phase 10: Institutionalize and close** - Knowledge Vault, UKDL rules and traps, the constitutive baseline ratchet, the fresh-agent test, the DWS matrix re-run, and the two-layer handoff.

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
