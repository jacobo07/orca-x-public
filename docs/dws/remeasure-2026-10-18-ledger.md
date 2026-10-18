# DWS re-measure ledger, 2026-10-18 (milestone 2, phase 8)

Scope: rows 6 16 25 26 28 30 31 32 37 39 40 41 43 47 48 49 50 51 55 75 of `config/dws-completion-matrix.jsonc`. Classes: MET, MEASURABLE, SMALL-GAP, LARGE-GAP, OUT-OF-PROGRAM. Only rows 30 and 32 were stamped PASS here; every other row keeps its state. Matrix after this phase: 43 of 76 PASS, checker exit 1 (rows still open), `config/scripts/check-dws-completeness.test.mjs` 30/30.

## Tests actually run in this phase

`node node_modules\vitest\vitest.mjs run` over `routed-conversation-turn.test.ts`, `routed-agent-provider-switch.test.ts`, `agent-identity-cross-host.test.ts`, `node-manifest-eligibility.test.ts`, `agent-identity.test.ts` (all in `src/main/conversation` or `src/shared`): 5 files, 29 tests passed. `provider-routing-composition.test.ts`: 1 test passed. No other test was run for the other rows; they are classed from searches and say so.

## Summary

| Row | Name | Class | State after |
|---|---|---|---|
| 6 | Mission integration | OUT-OF-PROGRAM | PARTIAL |
| 16 | Workspace Capsule | OUT-OF-PROGRAM | PARTIAL |
| 25 | Model availability | SMALL-GAP | PARTIAL |
| 26 | Model residency | MEASURABLE | ABSENT |
| 28 | Cognitive Routing | LARGE-GAP | PARTIAL |
| 30 | Provider quota | MET | PASS |
| 31 | Agent identity portability | LARGE-GAP | PARTIAL |
| 32 | Model switching | MET | PASS |
| 37 | Verification policy | OUT-OF-PROGRAM (judge half) | PARTIAL |
| 39 | Multi-client consistency | OUT-OF-PROGRAM | ABSENT |
| 40 | Observability | LARGE-GAP | ABSENT |
| 41 | Execution correlation | LARGE-GAP | ABSENT |
| 43 | Economics telemetry | LARGE-GAP | ABSENT |
| 47 | Failure recovery | MEASURABLE | PARTIAL |
| 48 | Protocol versioning | SMALL-GAP per verb | PARTIAL |
| 49 | Security | LARGE-GAP | ABSENT |
| 50 | Performance | SMALL-GAP | PARTIAL |
| 51 | Product Reality | MEASURABLE | ABSENT |
| 55 | Inheritance verification | SMALL-GAP | ABSENT |
| 75 | HF Real two-host Production Reality | MEASURABLE | PARTIAL |

## Rows 6 to 39

### Row 6 Mission integration - done: task carries Workstream subject
- Search `rg -i workstream src/main` finds 5 files (rpc errors, rpc methods index, `workstream-cancel.ts` and its test); `src/main/runtime/orchestration` and `tests/` return none. Control: the same search finds `workstream-cancel.ts`. The "subject" word in orchestration is the review subject, a different concept.
- `workstream-cancel.ts` refuses with `WORKSTREAM_AUTHORITY_UNAVAILABLE` naming `uwcp.control/1`; the matrix rows 1, 2, 4 and 7 record the same re-measure, and row 7 calls the row 6 carrier the only Orca-side part.
- Class: OUT-OF-PROGRAM. The Workstream identity that a task would carry is minted by UWCP, which is not in this repo; a task field with nothing to fill it would be a scaffold.

### Row 16 Workspace Capsule - done: UWCP S2 gate
- `**/workspace*.py` finds nothing in this repo; control: `**/dws-inference-*.py` finds `config/scripts/dws-inference-bakeoff.py`. "capsule" appears in docs/dws only in the row 65 and row 76 evidence, neither about the S2 gate.
- Class: OUT-OF-PROGRAM (owner is UWCP `workspace.py`).

### Row 25 Model availability - done: availability states fail closed
- `src/main/conversation/conversation-provider-routing.ts` excludes, then filters on tool support, quota, then auth; with no eligible provider it returns `refused` with a reason for every provider skipped. `routed-conversation-turn.test.ts` line 185 ("refuses with every reason and commits nothing when no provider can run the turn") passed.
- Gap read from code, not run: `entry.checkAuth()` is awaited without a try/catch in `routeConversationTurn`, so a rejecting auth check surfaces as a thrown error and not as a refusal with reasons. Quota silence reads `unobserved` and is treated as worth trying (fail-open by design).
- Class: SMALL-GAP (convert a rejecting `checkAuth` to a refusal reason, red-first test). Phase 9 decides.

### Row 26 Model residency - done: AVAILABLE != RESIDENT drill
- `src/shared/node-manifest.ts` `residentModelOf` returns `unknown` when no endpoint answers; `src/shared/node-manifest-eligibility.ts` judges `model-not-resident`; `node-manifest-eligibility.test.ts` ("resident model: named model present is eligible, absent is ineligible") passed. `docs/dws/live-2026-10-18-row-17-tunnel-evidence.md` records qwen3-coder-30b on GEX44 :8081.
- Not found: a drill that makes an available model non-resident and watches the verdict change on the real host.
- Class: MEASURABLE (GEX44 leg, phase 9).

### Row 28 Cognitive Routing - done: cite P3 gates
- Evidence is already in the matrix (`routed-conversation-turn.test.ts`, `routed-agent-provider-switch.test.ts`, `agent-identity.ts`). "P3 gates" resolves to no artifact in this repo (search of docs/dws and config returns none), as the row's own reason says. Rows 28 and 32 share one underlying claim.
- Class: LARGE-GAP (cannot be cited without the P3 gate list from another program).

### Row 30 Provider quota - done: quota read on the routing path
- `routed-conversation-turn.test.ts` passed 10/10, including line 84 ("skips a provider whose own quota report says exhausted, until that window resets") and line 98 ("still routes to a provider on a warning, which is not exhaustion"), the second being the discriminating control.
- `provider-routing-composition.ts:45` records claude quota observations; no codex quota is recorded, and `provider-routing-composition.test.ts` (1 test) does not exercise quota.
- Class: MET for the read on the routing path. Stamped PASS with the residual written in the evidence note.

### Row 31 Agent identity portability - done: cite P3 live evidence
- `agent-identity-cross-host.test.ts` and `agent-identity.test.ts` passed (hermetic two-store handover). Live two-machine P3 evidence is not in this repo.
- Class: LARGE-GAP (the `done` asks for live P3 evidence).

### Row 32 Model switching - done: same agent, provider X then Y, coherent
- `routed-agent-provider-switch.test.ts`: "keeps AgentId and history across a codex turn then a claude turn, each with its routing reason" and "goes red for a mutant that mints a new AgentId when the provider changes" both passed. The mutant is the negative control inside the test.
- Class: MET. Stamped PASS. Not covered: fake providers, no network.

### Row 37 Verification policy - done: policy-routed reviewer
- The matrix row already records a 2026-10-13 re-measure with a live leg of 4 real turns (review-flow, subject-bound-gates, approval-authority-aperture, agent-federation). Not re-run here. The remaining half is the UWCP judge.
- Class: OUT-OF-PROGRAM for the judge half; the review-policy half stays as recorded.

### Row 39 Multi-client consistency - done: stale client write refused
- `rg -i 'stale_?(client|write|revision)|expected_?revision|if_?match|base_?revision' src/main/runtime/orchestration src/shared/orchestration-rpc-contract.ts` returns nothing. Control: `rg -c -i revision src/main/runtime/orchestration/db.ts` returns 4.
- Class: OUT-OF-PROGRAM (owner is UWCP log ordering).
## Rows 40 to 75

### Row 40 Observability - done: end-to-end explain query
- Found: `src/main/observability/tracer.ts` (traceId/spanId, AsyncLocalStorage context; `tracer.test.ts` 15 `it(` blocks). Its users are crash-reporting, ai-vault scanner, worktree, clipboard copy, close attribution (rg `observability/tracer` src).
- Not found: any explain/query over an execution. Search `rg -n -i explain src/main/runtime src/shared --glob '!*.test.ts'` returned only unrelated hits (forced-sweep-settlement, commit-message, jira/linear types); control: same form finds `explain` in those files, so the search can see the word.
- Tests run in phase 8: none (nothing decides this `done`).
- Class: LARGE-GAP. Residual: no consumer ties an orchestration dispatch/run to a trace and no query reads one.

### Row 41 Execution correlation - done: one trace joins them
- Found: orchestration ids exist as columns (`dispatch_id`, `creator_dispatch_id`, `origin_dispatch_id`, `owner_dispatch_id` in `src/main/runtime/orchestration/db.ts`), and a tracer with traceId. Control for the search: `rg 'traceId|correlationId' src/main/observability/tracer.ts` finds traceId.
- Not found: any use of the tracer in `src/main/runtime/orchestration` (`rg -l 'observability/tracer|withSpan|startSpan' src/main/runtime` hits only close-attribution files). So the two id spaces are not joined.
- Tests run in phase 8: none.
- Class: LARGE-GAP (join key absent between orchestration ids and trace ids).

### Row 43 Economics telemetry - done: recorded per execution
- Found: usage and cost exist per automation run (`src/main/automations/run-usage-collection.ts`, `AutomationRunUsage` with `estimatedCostUsd`/`estimatedCostSource`) and in `src/main/claude-usage`, `src/main/codex-usage`.
- Not found: usage keyed by an orchestration execution/dispatch/task (`rg -n -i 'usage|tokens' src/main/runtime/orchestration --glob '!*.test.ts' -l` returns only `worker-transcript-payload.ts`; control: same form lists that file, and the claude-usage tree under `src/main` lists many).
- The recorded cost is an estimate by its own field name, so it cannot satisfy "measured meter, never an estimate labelled as spend" (milestone 2 phase 10 rule).
- Tests run in phase 8: none.
- Class: LARGE-GAP.

### Row 47 Failure recovery - done: node offline / client dies drills
- Found: `tests/e2e/dws-remote-continuity.spec.ts` (client quits normally, remote workload keeps the same serve MainPID; evidence cited in `docs/dws/phase-2-local-ram-offload-evidence.md` and `phase-3-detach-stop-cancel-evidence.md`). Daemon reconnect specs exist for the local daemon (`tests/e2e/daemon-generation-reconnect-safety.spec.ts`).
- Not found: a node-offline drill for the paired GEX44 runtime (`rg -l -i 'node offline|nodeOffline|client dies|client death' tests src docs/dws config` empty; control: `rg -l -i 'disconnect|offline|reconnect' tests/e2e` lists 12 files).
- Tests run in phase 8: none (needs a live two-host leg).
- Class: MEASURABLE (client-dies half has a spec; node-offline half needs a new drill on the disposable GEX44 root, phase 11).

### Row 48 Protocol versioning - done: mixed-version matrix for new verbs
- Found: mixed-version tests for older surfaces (`src/renderer/src/runtime/web-session-terminal-orphan-mixed-version.test.ts`, `tests/e2e/cross-version-wire/*`, `tests/e2e/daemon-version-skew-adoption.unit.test.ts`), doctrine in `docs/reference/remote-wire-compatibility.md`.
- The new verbs are in `src/shared/orchestration-rpc-contract.ts` (`missionPlace` count 1) with unit/CLI tests (`orchestration-mission.test.ts`, `orchestration-mission-place-cli.test.ts`) and two-host specs, but none pairs them with an old host. `rg -n -i 'method.?not.?found|unsupported|capabilit' src/cli/handlers/orchestration-mission-place-cli.test.ts` is empty.
- Tests run in phase 8: none.
- Class: SMALL-GAP per verb (an old-host fake answering method-not-found, red-first) but the full matrix over all new verbs is a LARGE-GAP; phase 11 decides how many verbs.

### Row 49 Security - done: every class controlled or named debt
- Found: gates for specific classes (for example `check:workspace-trust-authority`, `check:ipc-message-floor` named in AGENTS.md); no program threat model (`rg -l -i 'threat model|threat-model|STRIDE' docs config` returns only agent-skill-sharing plans; control: the form finds those two).
- Tests run in phase 8: none.
- Class: LARGE-GAP (needs the named threat list first; phase 12 decides against named threats, not a general review).

### Row 50 Performance - done: latency/hydration/reattach numbers
- Found: stream and reattach latency measured with N>=5 (`docs/dws/phase-2-stream-latency-remote.json`, `phase-2-reattach-latency.json`).
- Not found: a hydration latency instrument (`rg -l -i 'hydrationLatency|hydration.{0,20}latency' docs config tests src` returns only the matrix; control: same form finds the matrix mention).
- Tests run in phase 8: none.
- Class: SMALL-GAP (name the instrument, N>=5 on GEX44 in phase 11).

### Row 51 Product Reality - done: each golden PASS
- Found: golden specs `tests/e2e/golden-core-flows.spec.ts`, `golden-agent-tui-launch.spec.ts`, `golden-file-open-edit-save.spec.ts`, `golden-fresh-profile-terminal.spec.ts`, stub agent fixture `tests/e2e/fixtures/golden-stub-agent/`; `config/reliability-gates.jsonc` names goldens.
- Not run: they are Electron specs and need free RAM >= 6 GB and the build mode e2e.
- Class: MEASURABLE (phase 12 runs each golden once, one Electron at a time).

### Row 55 Inheritance verification - done: planted regression red
- Found: mutant/planted-regression tests inside gates (`config/scripts/check-durability-contracts.test.mjs`, `check-workspace-surface-claims.test.mjs`, `check-mobile-capability-aperture.test.mjs`, `run-dispatch-admission-drills.mjs`).
- No check exists for "inheritance" as a named gate; the PP side has the baseline ratchet (row 54 / `multi_host_fabric` B1 with a WEAKENED drill).
- Tests run in phase 8: none.
- Class: SMALL-GAP (pick the inheritance check, plant one regression on a copy, clean control; phase 12).

### Row 75 HF Real two-host Production Reality - done: every HF row claiming a cross-host property is exercised Windows<->GEX44 over real SSH
- Found: provisioner `config/scripts/hwf-two-host-disposable-root.sh`, driver `hwf-two-host-remote.mjs`, specs `hwf-two-host-remote-first.spec.ts`, `hwf-two-host-mission-locality.spec.ts`, `hwf-two-host-mission-dispatch.spec.ts`, `hwf-two-host-continue-here-resume.spec.ts`; rows 59, 70, 24, 17 re-passed REAL-TWO-HOST in milestone 1.
- Missing: the enumeration of HF rows that claim a cross-host property and a check that each has a REAL-TWO-HOST run.
- Tests run in phase 8: none.
- Class: MEASURABLE (build the enumeration from the matrix, phase 11).
