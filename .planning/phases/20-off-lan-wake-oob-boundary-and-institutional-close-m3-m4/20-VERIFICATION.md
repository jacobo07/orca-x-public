---
phase: 20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4
status: human_needed
verified: 2026-10-28
owed:
  - "M3 off-LAN wake (phone on 5G -> relay -> broker on the LAN -> target wakes -> fresh terminal output), OWNER_BOUND: cloud auth for the relay on the broker host (today `cloud_auth_not_configured`), Owner step (b) BIOS Resume by PCI-E / LAN on and ErP off, Owner step (c) an always-on LAN node running `orca serve --wake-broker`; then the ordered procedure in the M3 section below."
  - "M4 powered off: HARDWARE_BOUND (measured board: AMD B450M consumer board, no AMT; can-power-on-oob MEASURED unknown / amd_no_amt_oob_unmeasured since review fix WR-02, earlier not-supported / hardware_bound_amd_no_amt). WOL from S5 with Fast Startup off is OWNER_BOUND and unmeasured (Fast Startup is on)."
  - "The mobile Wake control on the host card: DEFERRED (19 D-13). Until it exists, an off-LAN request can only come from a scripted client, labelled SCRIPTED CLIENT, which never counts as the phone leg."
  - "Fresh-agent test (D-12): run by the orchestrator after 20-05; result appended below."
---

# Phase 20 Verification: Off-LAN wake, OOB boundary and institutional close (M3, M4)

Recorded HEAD for every gate line below: `ac107b5b9dadfdf56b49ef5324b6a189086ec249` (branch `mobile/host-availability`,
worktree `C:\owx-haf`, local, never pushed). Nothing under `src`, `config` or `mobile` changed after `90b0c0044`
(the 20-04 close); commits after `ac107b5b9` touch only `.planning/`.

## Labels

- **UNIT laptop** = vitest on this laptop, single files or small sets.
- **UNIT in-process relay** = `src/main/runtime/wake-broker-relay-dispatch.test.ts`: a simulated E2EE v2 phone, a
  loopback relay cell (`relay/loopback-relay-cell.ts`, bound to 127.0.0.1), a real `CloudRelayTransport`, the server's
  own `MobileSocketWiring` and a real `OrcaRuntimeRpcServer`. No real relay or cloud was contacted.
- **MEASURED read-only probe** = `src/main/runtime/host-oob-probe.live.test.ts` with `ORCA_LIVE_OOB_PROBE=1` on this
  laptop: Get-CimInstance reads only.
- **MUTANT** = a planted change on the real tree, caught, then restored by byte copy (protocol in 20-01-MUTANTS.md and
  20-04-MUTANTS.md).

Nothing here is REAL DEVICE, PHYSICAL, OWNER-OBSERVED or M3. No leg here is labelled SCRIPTED CLIENT for phase 20 (the
phase 19 SCRIPTED CLIENT leg is LAN-only and is not reused as M3). Nothing touched the Owner's PC power state, BIOS or
Fast Startup; nothing was elevated. No frame left 127.0.0.1; the only MAC in the tests is the fictitious locally
administered `02:00:5e:20:00:01`.

## Success criteria

| SC | Criterion | Evidence | Label | Verdict |
|---|---|---|---|---|
| SC1 | Off-LAN wake through an authorized broker, no new transport, no inbound port | Transport independence: a `host.wake.request` delivered over the relay reaches the broker effect and sends exactly one 102-byte loopback frame; over the relay the replay keeps its wakeId, an ungranted phone gets `wake_grant_missing`, a foreign wake reads `wake_unknown`, admin gets `forbidden`, a relay leg bound to another device is refused (`e2ee_error`), a revoke in the dispatch window gets `wake_device_revoked` then `unauthorized/device_revoked`. Re-run here: 3 files `Tests 21 passed (21)`. P20-L1, P20-L2 CAUGHT. The live off-LAN leg was not run: section M3 below | UNIT in-process relay + MUTANT; live leg OWNER_BOUND | **OWNER_BOUND** (transport independence PASS at unit level; the live leg is not PASS) |
| SC2 | Honest powered-off story: generic OOB interface, test-only double, measured `can-power-on-oob` | `oob-power.ts` types only (powerOn capped at `command-accepted`), recording double imported only by `oob-power.test.ts` (whole-src sweep, station control 14355 files, positive control hit); `can-power-on-oob` MEASURED `unknown / amd_no_amt_oob_unmeasured` (evidence `null`) on this laptop since review fix WR-02 (live leg below; before it, `not-supported / hardware_bound_amd_no_amt / os-probe`). Real OOB: HARDWARE_BOUND, never presented as real. P20-O1, P20-O2 CAUGHT | UNIT laptop + MEASURED + MUTANT | PASS (interface and measurement); real OOB HARDWARE_BOUND |
| SC3 | Failure matrix, mutants, ratchet, institutional close | Rows K, L, M PASS with positive controls (matrix below); twelve mutants CAUGHT and RESTORE_VERIFIED; G6 PASS (`check:host-card-claims` line below); Knowledge Vault lesson written; UKDL PROPOSAL written, not applied; reference note + AGENTS.md `## Host Wake`; STATE.md two-layer handoff; fresh-agent test: run by the orchestrator after 20-05; result appended below | UNIT laptop + MUTANT + files on disk | PASS (fresh-agent row pending the orchestrator run) |

## Live read-only OOB leg (MEASURED, this laptop)

Command at `ac107b5b9`: `$env:ORCA_LIVE_OOB_PROBE='1'`, `$env:ORCA_LIVE_OOB_EVIDENCE` = this phase's
`20-oob-probe-evidence.json`, then `pnpm exec vitest run --config config/vitest.config.ts src/main/runtime/host-oob-probe.live.test.ts`:
`Test Files  1 passed (1)`, `Tests  1 passed (1)`, exit 0 (passed, not skipped).

Current verdict line (from `20-oob-probe-evidence.json`, re-run 2026-10-28 after review fix WR-02, same command,
`Tests  1 passed (1)`, exit 0):
`{"value":"unknown","reason":"amd_no_amt_oob_unmeasured","evidence":null}`, positive control `"vendor": "AuthenticAMD"`,
`"meiCount": 0`.

Historical, before WR-02 (the `ac107b5b9` run, superseded in the evidence file):
`{"value":"not-supported","reason":"hardware_bound_amd_no_amt","evidence":{"kind":"os-probe","observedAt":1793187695765}}`,
positive control `"vendor": "AuthenticAMD"`, `"meiCount": 0`. A reader that saw nothing has no vendor string and no
finite count, so it cannot pass.

The 20-02 run (2026-10-28 12:06 local, job tmp file, not durable) read the same:
`{"verdict":{"value":"not-supported","reason":"hardware_bound_amd_no_amt","evidence":{"kind":"os-probe","observedAt":1793185595560}},"vendor":"AuthenticAMD","meiCount":0,"observedAt":1793185595561}`.
Both pre-WR-02 measurements agree; the vendor and MEI count are unchanged in the re-run, only the verdict mapping moved.

## Failure matrix K, L, M

| Row | Behaviour | Positive control | Test file | Mutant | Label |
|---|---|---|---|---|---|
| K broker offline | No wake is offered: disconnected or never connected this session reads `unknown / broker_not_connected`; stale status reads `no_status_this_session`; `planWakeRequest` refuses to send; no output ever says powered-off, woken, host-announced or awake | two `positive control` rows yield `wake-proxy-available` from current answers | `src/shared/host-wake-proxy.test.ts` | P20-K1, P20-K2 | UNIT laptop + MUTANT |
| L revoked phone | Refused at the effect over the relay: `wake_device_revoked` (never the latch reason), then the next relay frame `unauthorized / device_revoked`; frames stay at 1; grant gone in memory and on disk. Also a relay leg bound to another device is refused `e2ee_error` | tracer row: granted phone over the relay sends exactly one 102-byte frame; matching bindings ready with cause `authenticated` | `src/main/runtime/wake-broker-relay-dispatch.test.ts` (and 19's `wake-broker-revoke-in-process.test.ts`) | P20-L1, P20-L2 | UNIT in-process relay + MUTANT |
| M version mismatch | An old broker without `host.wake-broker.v1` (or with no capabilities) reads `unknown / broker_not_announced` and gets no wake request; an old client still parses exactly the six phase 18 capability ids | positive control rows (broker advertising the capability); additive pin parses a phase 20 announcement as the six ids | `src/shared/host-wake-proxy.test.ts`, `src/shared/host-availability.test.ts` | P20-M1, P20-M2 | UNIT laptop + MUTANT |

## Mutants (twelve, by reference)

Full plant, command and decisive line in `20-01-MUTANTS.md` (L1, L2) and `20-04-MUTANTS.md` (the other ten). Every
row: PLANT_CONFIRMED, CAUGHT, RESTORE_VERIFIED (sha256 equal before and after, diff-quiet 0, catcher green again).

| Mutant | Plant | Caught by | Verdict |
|---|---|---|---|
| P20-L1 | `wake-broker.ts:137` effect-time device authority forced ok (P19-M6 shape, through the relay) | relay row 9 at `:251`: received `wake_grant_missing`, expected `wake_device_revoked`; `Tests 1 failed \| 8 passed (9)` | CAUGHT, RESTORE_VERIFIED |
| P20-L2 | `rpc/mobile-socket-wiring.ts:165` relay device binding skipped | relay row 7 at `:196`: ready `expected true to be false` | CAUGHT, RESTORE_VERIFIED |
| P20-K1 | `host-wake-proxy.ts:52` status currency forced true | `status stale (before the latest connect)`; `Tests 2 failed \| 18 passed (20)` | CAUGHT, RESTORE_VERIFIED |
| P20-K2 | `host-wake-proxy.ts:49` disconnected branch never taken | all three K rows | CAUGHT, RESTORE_VERIFIED |
| P20-M1 | `host-wake-proxy.ts:58` `host.wake-broker.v1` inclusion forced true | both M rows and reason coverage | CAUGHT, RESTORE_VERIFIED |
| P20-M2 | `host-availability.ts:153` seventh capability id appended | additive pin (`Tests 1 failed \| 27 passed (28)`) and G6 R2 (`can-teleport is not classified`) | CAUGHT (two catchers), RESTORE_VERIFIED |
| P20-O1 | `host-oob-verdict.ts:48` AMD branch reads supported | verdict table (AMD rows, never-supported row) and G6 R5 | CAUGHT (two catchers), RESTORE_VERIFIED |
| P20-O2 | `host-oob-probe.ts:1` production imports the OOB test double | import sweep: `expected [ 'main/runtime/host-oob-probe.ts' ] to deeply equal []` | CAUGHT, RESTORE_VERIFIED |
| P20-W1 | `host-availability-producer.ts:25-27` describeRemoteWakeCapability reads supported | producer pin rows and G6 R5 | CAUGHT (two catchers), RESTORE_VERIFIED |
| P20-G1 | `config/host-card-claims.jsonc` can-power-on-oob entry removed | G6 R2 (not classified; 5 producers, floor 6) and the gate test's exact success line | CAUGHT (two catchers), RESTORE_VERIFIED |
| P20-G2 | `config/host-card-claims.jsonc` whole hostCapabilities section removed | G6 R1: `config has no hostCapabilities section` | CAUGHT, RESTORE_VERIFIED |
| P20-G3 | `mobile/src/components/MobileHostCard.tsx:90` `accessibilityHint="Wake this host"` on a navigation control | G5: effect wording on a navigation control, no effect control classified to a host RPC method | CAUGHT, RESTORE_VERIFIED (the jsonc `why` plant survived because G5 does not scan it; recorded in 20-04) |

## M3: OWNER_BOUND (D-03)

The live off-LAN leg is not PASS and was not run. What is missing:
- **Cloud auth for the relay on the broker host.** `src/main/runtime/relay/host-relay-startup.ts` reports
  `cloud_auth_not_configured` without it, and `can-relay` reads `needs-owner-setup` until then. A disposable host has
  none.
- **Owner step (c): an always-on LAN node** running `orca serve --wake-broker`. The measured LAN has none, and the
  broker cannot run on the sleeping target.
- **Owner step (b): firmware.** BIOS "Resume by PCI-E / LAN" on and ErP off. The OS cannot read this, so
  `can-wake-lan` is at best `unknown / firmware_unverified`.
- **The phone-side Wake control** is DEFERRED (19 D-13). Until it exists an off-LAN request can only come from a
  scripted client, labelled SCRIPTED CLIENT, and that does not count as the phone leg.

Ordered Owner procedure (M3 is not PASS until every step is observed):
1. Do (b) and (c), and configure cloud auth for the relay on the node.
2. On the node, confirm `status.get` shows `can-relay` `supported` and the runtime capability `host.wake-broker.v1`.
3. On the node: `orca wake target add --mac <the PC's MAC> --broadcast <the subnet-directed broadcast> --label <name>`,
   then pair the phone with the node and `orca wake grant add --device <the phone's device id> --target <targetId>`.
4. Put the PC to sleep.
5. From the phone on 5G with Wi-Fi off, send the wake through the relay to the node.
6. Observe the broker stages `requested`, `authorized`, `packet-sent`; then `host-announced` from the PC's own
   `status.get`, `runtime-ready`, and fresh terminal output from the woken PC (a new nonce, not history).
7. Confirm the router has no port forward to the node: no inbound public port.

Until step 6 is observed on a real phone, M3 stays OWNER_BOUND. Unit relay evidence is never M3.

## M4: HARDWARE_BOUND (D-08)

Measured on this laptop (read-only): CPU vendor `AuthenticAMD`, board `B450M MORTAR MAX (MS-7B89)` (20-RESEARCH
Win32_BaseBoard read, 2026-10-27), Intel management engine PnP count `0` (`20-oob-probe-evidence.json`). AMT is
Intel-only, and this is an AMD B450M consumer board with no AMT, so Orca has no OOB path to drive here: M4 stays
HARDWARE_BOUND as a verification label (measured board: AMD B450M consumer board, no AMT). On the wire `can-power-on-oob` reads `unknown / amd_no_amt_oob_unmeasured` (evidence `null`)
since review fix WR-02: a CPU vendor proves there is no AMT, not that DASH or a BMC is absent, and the probe reads
neither. (Before WR-02 it read `not-supported / hardware_bound_amd_no_amt / os-probe`.) `HARDWARE_BOUND` is the
verification label, not the wire reason (an uppercase reason would parse to `unspecified`).

WOL from S5 (soft off) with Fast Startup off is OWNER_BOUND and never assumed: Fast Startup is measured on, and
nothing here changed it. If the Owner turns Fast Startup off and does step (b), a wake from S5 can be tried with the
M3 procedure starting from a shut-down PC.

## Notes

- **D-04 option B.** `can-wake-remote` is `not-configured / no_wake_broker` on every host, from one producer
  (`describeRemoteWakeCapability`). A phone learns that a broker accepts remote wake from that broker's
  `host.wake-broker.v1` capability plus a current `host.wake.targets` answer. P20-W1 and G6 pin it.
- **wake-proxy-available**: UNIT, WIRED-BUT-UNRENDERED. `src/shared/host-wake-proxy.ts` composes it only from this
  session's broker answers; there is no UI consumer until the mobile Wake control exists.

## Institutional close

- Knowledge Vault lesson (outside the repo, not committed):
  `C:\Users\Jacobo\.claude\knowledge_vault\lessons\host-wake-packet-sent-is-not-a-host-woken.md`, sha256
  `8F7D1C59339F2C974F38FE694338C29A467ABFD3A7CD0D043F33DF57A7AC9851`; the path did not exist before the write.
- UKDL PROPOSAL (not applied): `20-UKDL-PROPOSAL.md`, five entries, zero collisions. The shared
  `ukdl-universal.md` sha256 `468CA6543674278D5E92922A133BAE1FCF189813C503BCB1E75CAEC7CF5C9D46` before and after
  (unchanged; read only).
- Reference note `docs/reference/host-wake-broker.md` and the AGENTS.md `## Host Wake` section linking it (ac107b5b9).
- STATE.md two-layer handoff (`## Owner summary`, `## Agent resume block`) and `20-FRESH-AGENT-QUESTIONS.md`.

## Gates at ac107b5b9

| Command | Result |
|---|---|
| `vitest run` wake-broker-relay-dispatch, wake-broker-revoke-in-process, rpc/methods/host-wake | `Test Files  3 passed (3)`, `Tests  21 passed (21)` |
| `vitest run` host-oob-verdict, host-oob-probe, host-availability-producer | `Test Files  3 passed (3)`, `Tests  71 passed (71)` |
| `vitest run` rpc/methods/status, startup/host-availability-wiring, shared/windows-system-tool-path, shared/secure-file | `Test Files  4 passed (4)`, `Tests  35 passed \| 2 skipped (37)` (the 2 skips are secure-file platform rows, as in 20-02) |
| `vitest run` shared/host-wake-proxy, shared/host-availability, shared/host-wake, runtime/oob-power | `Test Files  4 passed (4)`, `Tests  63 passed (63)` |
| `vitest run` config/scripts/host-capability-producer-gate.test.mjs, check-host-card-claims.test.mjs | `Test Files  2 passed (2)`, `Tests  50 passed (50)` |
| `pnpm run typecheck:node` | exit 0 |
| `pnpm exec tsc --noEmit -p config/tsconfig.tc.web.json` | exit 0 |
| `pnpm run typecheck:cli` | exit 0 |
| `pnpm run check:host-card-claims` | `check-host-card-claims: 22 labels classified, 2 controls classified, 598 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified, 3 capability emitters scanned.` (after review fix WR-01: G6 R7 scans the probe emitters; P20-O3 CAUGHT, 20-04-MUTANTS.md) |
| `pnpm run check:recurring-work` | `Recurring-work inventory OK [total=236 interval=48 watcher=8 self-rescheduling-timeout=102 worker=13 helper=36 self-rescheduling-frame=29] debt=0` |
| `pnpm run check:durability-contracts` | `Durability contract check passed for 22 contract(s); ... no new ones.` |
| `pnpm exec oxlint` on the ten phase 20 source modules | exit 0, no diagnostics |
| `git diff --quiet -- src config mobile` | exit 0 |

## Named residuals

- 19-REVIEW IN-01..IN-05 deferred (IN-01 effect re-judge refusal leaves a record at `authorized`; IN-02 `orca wake`
  from WSL refused as remote; IN-03 WOL probe spawns tools by bare name; IN-04 quarantined state file becomes an empty
  broker without a hint; IN-05 `commitAddition` assumes a throwing publish wrote nothing).
- The mobile Wake control (19 D-13).
- Host pre-suspend announcement as evidence for `sleeping`.
- Broker discovery and target auto-registration.
- Research assumptions A1 (Linux MEI node name `/dev/mei0`) and A2 (macOS `sysctl -n machdep.cpu.vendor` absent on
  Apple silicon): both read unknown if wrong, never supported; unmeasured.
- The `oob-available` connectivity state has no producer and is never emitted.

## Decision traceability

| Decision | Where it is held | Evidence |
|---|---|---|
| D-01 off-LAN wake is the same `host.wake.*` call over the existing relay; no new transport, no inbound port | `rpc/methods/host-wake.ts` dispatched through `MobileSocketWiring` on the relay | relay rows 1-9; no new method or listener |
| D-02 transport independence at the narrowest real seam, mutant-checked | `wake-broker-relay-dispatch.test.ts` | 21/21 here; P20-L1, P20-L2 CAUGHT |
| D-03 live off-LAN leg OWNER_BOUND | this file, M3 section | cloud auth, steps b and c, ordered procedure |
| D-04 `can-wake-remote` never supported without evidence (option B) | `describeRemoteWakeCapability` | producer pin rows; P20-W1 CAUGHT; G6 `supported: null` |
| D-05 `wake-proxy-available` only from this session's broker answers | `src/shared/host-wake-proxy.ts` | 20 rows; P20-K1, K2, M1 CAUGHT; UNIT, WIRED-BUT-UNRENDERED |
| D-06 generic OOB interface, test-only double, no production implementer | `oob-power.ts`, `oob-power-test-double.ts` | import sweep 8/8; P20-O2 CAUGHT |
| D-07 `can-power-on-oob` measured read-only, never supported | `host-oob-verdict.ts`, `host-oob-probe.ts` | live leg unknown/amd_no_amt_oob_unmeasured since WR-02 (earlier not-supported/hardware_bound_amd_no_amt); P20-O1 CAUGHT |
| D-08 M4 HARDWARE_BOUND; WOL from S5 OWNER_BOUND | this file, M4 section | measured AuthenticAMD, MEI 0; Fast Startup on, untouched |
| D-09 rows K, L, M with positive controls and mutants | matrix above | twelve mutants CAUGHT, RESTORE_VERIFIED |
| D-10 ratchet extends the existing gate | G6 in `check:host-card-claims` | success line above; P20-G1, G2, G3, M2, O1, W1 caught by the gate |
| D-11 durable knowledge: reference note, vault lesson, UKDL as proposal | `docs/reference/host-wake-broker.md`, vault lesson, `20-UKDL-PROPOSAL.md` | hashes above; UKDL unchanged |
| D-12 fresh-agent test from durable state | `20-FRESH-AGENT-QUESTIONS.md` | run by the orchestrator after 20-05; result appended below |
| D-13 two-layer handoff; no milestone actions while human_needed | STATE.md `## Owner summary`, `## Agent resume block` | milestone audit, complete and cleanup not run |
| D-14 single files here, no Owner-PC effects, never push, UDP to loopback | this file | no build, no GEX44 this plan; nothing pushed |

## Not run, by decision

Milestone audit, complete and cleanup are not run: phases 5, 7, 9, 17, 18, 19 and 20 are human_needed, and completing
would archive unverified legs as done (STATE Decisions, 2026-10-26; orchestrator decision 8).

## Fresh-agent test (orchestrator)

Run 2026-10-28 after the 20-05 commits. One read-only agent (Read, Grep, Glob only; no chat context) answered the
Questions section of `20-FRESH-AGENT-QUESTIONS.md` verbatim from durable files under `C:\owx-haf`, without the rubric,
in 9 tool calls.

- Score: **8/8**. Every required fact in the Rubric was stated with `file:line` citations; no answer was "not found".
- Citations: 12 sampled by the orchestrator (STATE.md:22, 48, 63, 66, 92, 139, 147; 20-VERIFICATION.md:3, 49, 109,
  116; docs/reference/host-wake-broker.md:75) all resolve to a line that contains the fact. Failed: none.
- Q6 note: the agent named the probe's evidence label MEASURED and HARDWARE_BOUND the M4 verdict label; both hold
  (this file :24-25 and :116), so it is not a gap.
- Gap fixed: STATE.md Current Position still said the next step was this test; it now records the result and points
  at the phase 20 code review.
