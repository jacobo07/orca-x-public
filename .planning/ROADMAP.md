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
- [x] **Phase 13: SEND-P0 nonce trace and RED** (complete 2026-10-27: Ctrl+U bundled with a paste-sized body leaves Claude Code unsubmitted; see 13-VERIFICATION.md) - Follow one unique nonce from the mobile send through the host write, the PTY, the desktop input line and the transcript turn on the Owner's installed Windows Orca X (scripted client); name the first missing receipt; RED at that owner. Brief: .planning/SEND-P0-PLAN.md.
- [ ] **Phase 14: SEND-P0 owner fix and truthful delivery states** - Fix the failing owner; the mobile bubble shows sending, written, delivered, unconfirmed, refused or failed from evidence; failures are visible with the narrowest recovery; no duplicate rows.
- [ ] **Phase 15: SEND-P0 terminal send, wrong target, reconnect, revocation, version** - Terminal send proven by fresh output on the exact PTY; wrong host, session or runtime is refused, never retargeted; reconnect is duplicate-safe; a revoked device is refused at the effect; an older host is not success.
- [ ] **Phase 16: SEND-P0 Product Reality, mutation and institutional close** - Real phone legs for Agent send, terminal send, send+scroll and send+lease; mutants; Knowledge Vault, UKDL, ratchet gate, fresh-agent test, two-layer handoff.

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

### Phase 13: SEND-P0 nonce trace and RED
**Goal**: The stage where a mobile message stops being real is named by evidence. **Depends on**: Phase 12
**Success Criteria** (what must be TRUE):
1. A scripted-client nonce trace on the installed Windows Orca X records the RPC response, the host write (ptyId, bytes), the PTY output, the desktop input line and the transcript turn, and names the first stage without the nonce. The scripted device is revoked at the end.
2. Each of the five hypotheses in SEND-P0-PLAN.md is CONFIRMED or REJECTED with evidence.
3. A deterministic test fails on the real regression at that owner, with the contract "the agent turn exists".

### Phase 14: SEND-P0 owner fix and truthful delivery states
**Goal**: A mobile Agent message reaches the agent as a turn, and its bubble never outruns its evidence. **Depends on**: Phase 13
**Success Criteria** (what must be TRUE):
1. The phase 13 RED is green, the fix is in the owning layer, and Law 2 is preserved (no generic send).
2. The bubble distinguishes written from delivered (transcript echo), shows unconfirmed after a bound and refused/failed with a reason, and Retry cannot create a duplicate turn.
3. A host refusal (refusedReason, lease, auth, capability) is never rendered as sent.

### Phase 15: SEND-P0 terminal send, wrong target, reconnect, revocation, version
**Goal**: Every send binds to its target at admission or is refused. **Depends on**: Phase 14
**Success Criteria** (what must be TRUE):
1. A terminal-runtime send is proven by fresh output on the exact PTY, with a second terminal untouched.
2. A runtime or host switch after typing, a stale session, a deleted session or a stale lease each refuses or binds to the original target; nothing retargets.
3. Disconnect then Send, and reconnect, produce at most one admitted message; a revoked device's next send is refused with no turn and no input; an older host shows unsupported.
4. Agent send is not gated by the terminal input lease unless the design says so, and terminal lease semantics are unchanged.

### Phase 16: SEND-P0 Product Reality, mutation and institutional close
**Goal**: The Owner's phone sends a prompt and a command that both really land. **Depends on**: Phase 15
**Success Criteria** (what must be TRUE):
1. Real phone + real Windows host: an Agent prompt reaches the desktop turn and the result reconciles without duplicates; a terminal command shows fresh output; send+scroll stays anchored; send+lease behaves as specified. Otherwise OWNER_BOUND with the exact missing step.
2. The 13 SEND-P0 mutants report PLANT_CONFIRMED, a verdict and RESTORE_VERIFIED.
3. Knowledge Vault incident, UKDL entries, the ratchet gate and a passing fresh-agent test from durable state; two-layer handoff in STATE.md.
