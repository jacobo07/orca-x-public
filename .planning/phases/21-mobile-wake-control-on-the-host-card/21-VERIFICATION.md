---
phase: 21-mobile-wake-control-on-the-host-card
status: human_needed
verified: 2026-10-28
owed:
  - "The phone leg (D-11): a real phone or a labelled emulator, paired to both the broker node and the target, opens the home screen while the target sleeps and its broker is bound; the target's card shows Wake; a press shows requested, authorized and packet-sent, and host-announced appears only from that host's own answer after it reconnects. Not run. Nothing here is REAL DEVICE, PHYSICAL or emulator."
  - "OWNER_BOUND on 19/20 step b: BIOS Resume by PCI-E / LAN on and ErP off on the target PC (the OS cannot read it)."
  - "OWNER_BOUND on 19/20 step c: an always-on LAN node running `orca serve --wake-broker` (the sleeping PC cannot be its own broker)."
  - "OWNER_BOUND binding: the Owner runs `orca wake host-key` on the target, then `orca wake target bind <targetId> --host-key <key>` on the broker (after `orca wake target add` and `orca wake grant add`). With no binding the card draws no Wake control, by design."
  - "The optional SCRIPTED CLIENT leg for host.wake.* with a bound target was not run and is not claimed."
  - "Residual: Hermes base64 padding is unmeasured. The phone derivation is pinned on Node by the 21-02 vector, and the canonical re-pad in hostKeyFromPublicKeyB64 guards it; the real engine is owed to the phone leg."
---

# Phase 21 Verification: Mobile Wake control on the host card

Recorded HEAD for every laptop line below: `9ae14b45b992df7eff0064d4756fd3d040a8e927` (branch
`mobile/host-availability`, worktree `C:\owx-haf`, local, never pushed). Product code last changed at `9ae14b45b`
(a comment in `src/shared/host-wake-proxy.ts`). Before that it last changed at `696f4002f` (21-05 GREEN). The drills
in 21-06-MUTANTS.md ran at `18f0d037e`, which has the same product bytes as `696f4002f`.

## Labels

- **UNIT laptop** = vitest on this laptop, one file per run.
- **UNIT GEX44** = mobile vitest (and in full mode oxlint, oxfmt and mobile tsc) on GEX44, in a disposable
  `/tmp/orca-phone-p18-<ts>` root through the phase 18 runner. Every run printed `TEARDOWN procs=0 root=absent` and
  `PROOF ROOT_ABSENT_CONFIRMED`. Render tests use react-test-renderer; nothing was drawn on a screen.
- **GATE** = a repository check (`check:host-card-claims`, `check:recurring-work`, `check:durability-contracts`) or a
  typecheck, exit code read from its log.
- **MUTANT** = a planted change on the real tree, caught, then restored by byte copy (21-06-MUTANTS.md).

Nothing here is PHYSICAL, REAL DEVICE, emulator, OWNER-OBSERVED or SCRIPTED CLIENT. No phone was used. Nothing slept,
armed or reconfigured the Owner's PC. The only MAC in the fixtures is the fictitious locally administered
`02:00:5e:20:00:01`. This record cites test names and result lines only.

## Success criteria

| SC | Criterion | Evidence | Label | Verdict |
|---|---|---|---|---|
| SC1 | Cross-host routing from evidence: Wake only when a broker answered this session with a target bound to the host's identity; the request goes to that broker; no binding, no control; no MAC on the phone | 21-01: broker binding by hostKey (sha256 of the host E2EE key, base64url). `host.wake.targets` adds an optional `hostKey`, never a MAC. `targetBind` and `hostKey` are local-only admin methods. 21-02: `composeHostWakeRoute` routes only when exactly one current broker (never the card's own host) lists exactly one target with that exact key. It refuses `no_host_key`, `no_bound_target` and `ambiguous_broker`. The phone derivation equals the host fingerprint, and the vector is pinned. 21-05: a press recomposes the route and sends exactly one `host.wake.request` on the routed broker's own client, and none to the target. Mutants P21-B1, P21-B2 and P21-A1 are CAUGHT | UNIT laptop + UNIT GEX44 + MUTANT | PASS at unit and render level; phone leg owed |
| SC2 | One presenter table for the stages; host-announced only from the target's own answer; never Woken from a broker stage; refusal codes as their own states | 21-04: `presentHostCardWake` and 19 `wake.*` labels. Broker stages are rebased to the phone-observed reply. host-announced and runtime-ready come only from the target's own answer, on a connection after the press. Eleven refusal codes each have their own label, and anything else reads `wake.unknown`. The ambiguity text is "Wake unavailable: ambiguous broker", with no control. 21-05: re-read happens on focus, with no timer, and a `wake_device_revoked` reply stays a wake state outside the revocation latch. Mutant P21-W1 is CAUGHT twice (G7 W3 and the presenter text law) | UNIT GEX44 + GATE + MUTANT | PASS at unit and render level; phone leg owed |
| SC3 | The claims gate classifies the control and the labels, scopes effect wording per control, mutants CAUGHT; mobile tests on GEX44; phone leg owed | 21-03: G5 scope per control (innermost control must be an effect with a known rpc), the G7 wake family and observer rule, `wakeModel`. 21-04: `host-card-wake` is classified `effect` / `host.wake.request`, and the success line is pinned at 41 labels and 3 controls. Seven 21-06 mutants are CAUGHT and RESTORE_VERIFIED: S1, S2, R1, W1, B1, B2, A1. GEX44 runs are listed below | GATE + MUTANT + UNIT GEX44 | PASS; phone leg owed as human_needed |

## Re-run at the recorded HEAD (laptop)

Unit set, one file per vitest run (`pnpm exec vitest run --config config/vitest.config.ts <file>`), all exit 0:

| File | Result |
|---|---|
| `src/main/runtime/rpc/methods/host-wake-admin.test.ts` | `Tests 51 passed (51)` |
| `src/main/runtime/rpc/methods/host-wake.test.ts` | `Tests 12 passed (12)` |
| `src/shared/host-wake.test.ts` | `Tests 7 passed (7)` |
| `src/main/runtime/wake-broker-store.test.ts` | `Tests 37 passed (37)` |
| `src/main/runtime/wake-broker.test.ts` | `Tests 10 passed (10)` |
| `src/cli/handlers/wake.test.ts` | `Tests 51 passed (51)` |
| `src/shared/host-wake-proxy.test.ts` | `Tests 49 passed (49)` |
| `src/main/runtime/host-key-fingerprint.test.ts` | `Tests 10 passed (10)` |
| `config/scripts/host-card-effect-claims.test.mjs` | `Tests 31 passed (31)` |
| `config/scripts/check-host-card-claims.test.mjs` | `Tests 32 passed (32)` |
| `config/scripts/host-capability-producer-gate.test.mjs` | `Tests 32 passed (32)` |

Gates, all exit 0:
- `pnpm run typecheck:node`: rc=0
- `pnpm run typecheck:cli`: rc=0
- `pnpm exec tsc --noEmit -p config/tsconfig.tc.web.json`: rc=0
- `pnpm run check:host-card-claims`: `check-host-card-claims: 41 labels classified, 3 controls classified, 600 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified, 3 capability emitters scanned.`
- `pnpm run check:recurring-work`: `Recurring-work inventory OK [total=236 interval=48 watcher=8 self-rescheduling-timeout=102 worker=13 helper=36 self-rescheduling-frame=29] debt=0`.
  The count is unchanged since phase 20, so phase 21 added no timer under `src/`.
- `pnpm run check:durability-contracts`: `Durability contract check passed for 22 contract(s); 19 grandfathered durability publisher(s); 38 grandfathered direct state writer(s); 2 grandfathered durable-primitive delegate(s); 4 grandfathered durable publisher caller(s); no new ones.`
- `git diff --quiet -- src config mobile`: 0.

## GEX44 runs (UNIT GEX44, cited from the plan summaries)

All of these ran on host kobicraft-gex44 with node v24.21.0 and pnpm 12.15.0, through the phase 18 runner.

- 21-04 full gate, `/tmp/orca-phone-p18-20261028T152515Z`: `RUNNER vitest_rc=0` (2 files, 86/86),
  `RUNNER oxlint_rc=0 oxfmt_rc=0 tsc_rc=2`, `RUNNER tsc_errors_touched=0` (the 3 errors are pre-existing),
  `RUNNER result=PASS`, `TEARDOWN procs=0 root=absent`, `PROOF ROOT_ABSENT_CONFIRMED`, `LOCAL exit=0`.
- 21-04 regression at `b08379286`, `/tmp/orca-phone-p18-20261028T152859Z`: 3 files, 102/102, `RUNNER result=PASS`.
- 21-05 final full gate, `/tmp/orca-phone-p18-20261028T154651Z`: `Test Files 3 passed (3)`, `Tests 109 passed (109)`,
  `RUNNER oxlint_rc=0 oxfmt_rc=0 tsc_rc=2`, `RUNNER tsc_errors_touched=0`, `RUNNER result=PASS`,
  `TEARDOWN procs=0 root=absent`, `PROOF ROOT_ABSENT_CONFIRMED`, `LOCAL exit=0`.
- 21-06 drills:
  - P21-W1 plant, `/tmp/orca-phone-p18-20261028T155530Z`: `RUNNER result=FAIL`.
  - P21-B1 plant, `/tmp/orca-phone-p18-20261028T155613Z`: `RUNNER result=FAIL`.
  - Batched restore run, `/tmp/orca-phone-p18-20261028T155726Z`: `Test Files 2 passed (2)`, `Tests 86 passed (86)`,
    `RUNNER result=PASS`, `TEARDOWN procs=0 root=absent`, `PROOF ROOT_ABSENT_CONFIRMED`, `LOCAL exit=0`.

The mobile tsc carries the same 3 pre-existing errors throughout (MermaidDiagram.tsx TS2307,
terminal-webview-html.ts TS2307, mobile-workspace-client.ts TS2366). None of them is in a phase 21 file.

## D-13 closure (19-VERIFICATION.md, "D-13: the mobile Wake control is DEFERRED")

1. **Cross-host routing.**
   - Closed by **21-01**: the broker target is bound to the woken host's hostKey, and the Owner sets the binding
     locally.
   - Closed by **21-02**: `composeHostWakeRoute` maps a card to (broker host, targetId) from this session's answers
     only. Two bindings give no control.
   - Closed by **21-05**: the answers live in React state per session, and a press goes to the routed broker's own
     client.
   - Mutants B1, B2 and A1 are CAUGHT.
2. **A new stage label family.**
   - Closed by **21-03**: the `wake` family, `wakeModel` and the W1-W3 observer rule.
   - Closed by **21-04**: 19 `wake.*` labels, classified, rendered by `presentHostCardWake`.
   - Mutant W1 is CAUGHT.
3. **The checker weakening.**
   - Closed by **21-03**: the card-wide effect short-circuit is replaced by a per-control scope, so the first effect
     control legitimizes only its own extent, and a nested effect control fails.
   - Mutants S1 (gate code), S2 (real card) and R1 (unknown rpc) are CAUGHT.
4. **Testing cost.**
   - Closed by **21-04** and **21-05**: the mobile tests ran on GEX44 disposable roots with teardown proof.
   - Closed by **21-06**: the W1 and B1 drills ran their mobile catchers there too.

What D-13 left in place is now superseded: `check:host-card-claims` classifies 3 controls. One of them,
`host-card-wake`, is an effect backed by `host.wake.request`.

## Mutants (21-06-MUTANTS.md)

| Mutant | Rule | Catcher | Verdict |
|---|---|---|---|
| P21-R1 | Wake classified with a non-existent rpc | `check:host-card-claims` | CAUGHT, RESTORE_VERIFIED |
| P21-S1 | scope condition in the gate made always true | `host-card-effect-claims.test.mjs` (8 rows) | CAUGHT, RESTORE_VERIFIED |
| P21-S2 | `Wake now` inside host-card-open | `check:host-card-claims` | CAUGHT, RESTORE_VERIFIED |
| P21-W1 | `Woken` on packet-sent | `check:host-card-claims` (W3) + GEX44 presenter text law | CAUGHT twice, RESTORE_VERIFIED |
| P21-B1 | control drawn without `showControl` | GEX44 `MobileHostCard.test.tsx` (2 rows) | CAUGHT, RESTORE_VERIFIED |
| P21-B2 | hostKey equality always true | `host-wake-proxy.test.ts` (2 other-host rows) | CAUGHT, RESTORE_VERIFIED |
| P21-A1 | ambiguous broker resolved to the first match | `host-wake-proxy.test.ts` (2 D-04 rows + reason coverage) | CAUGHT, RESTORE_VERIFIED |

Before these, plan-local mutants were CAUGHT in 21-02 (route R1-R4, R6; derivation D2-D6; purity P1, P2) and in 21-04
(M1-M5). 21-02 D1 survived on Node, because Node's atob accepts unpadded text. That is the Hermes residual above.

## Owner procedure (ordered)

1. Do step b on the target PC: BIOS "Resume by PCI-E / LAN" on and ErP off. Then do step c: run an always-on LAN node
   with `orca serve --wake-broker`. Confirm step a still reads armed (19-VERIFICATION.md, "LAN Product Reality").
2. Pair the phone with both the node and the target PC.
3. On the target PC, run `orca wake host-key` and note the 43-character key.
4. On the broker node:
   1. If the target is not yet registered: `orca wake target add --mac <the PC's MAC> --broadcast <subnet-directed broadcast> --label <name>`.
   2. `orca wake grant add --device <phone device id> --target <targetId>`.
   3. `orca wake target bind <targetId> --host-key <key from step 3>`.
5. Put the target PC to sleep.
6. Open the phone's home screen, with the broker node connected. The target's card shows Wake.
7. Press Wake. The stage line reads Wake requested, then Wake authorized, then Wake packet sent. It never reads woken
   from a broker stage.
8. "Host answered after wake" appears only after the target reconnects and answers status.get itself.
9. Run `/gsd-verify-work 21`. Steps 1-4 also unblock `/gsd-verify-work 19`.

## Named residuals

- Hermes base64 padding is unmeasured. It is guarded by the canonical re-pad and pinned on Node by the vector.
- `useHostCardWake` has no direct render test. Its decisions live in tested pure selectors, and its React wiring is
  proven by tsc and oxlint only (21-05). On a device it is owed.
- The off-LAN path (M3) stays OWNER_BOUND under phase 20. Phase 21 adds no transport.
