# Roadmap: DWS rows 59, 24, 27, 17, 76, 52, 53, 54 (rb-live + pp-dws-rows-wt)

## Overview

Close eight rows of `config/dws-completion-matrix.jsonc`. Orca work happens in this worktree (branch `rb-live`);
PP work (rows 17-adapter, 76, 52, 53, 54) happens ONLY in `C:\Users\User\Apps\pp-dws-rows-wt` (branch
`dws/pp-rows`). Each phase ends with committed changes, an evidence doc `docs/dws/live-2026-10-<dd>-row-<NN>-*.md`
(this repo), the matrix row restated from what was measured (PASS only when the row's whole `done` is met,
otherwise PARTIAL/ABSENT with the measured part and the named gap), and the Orca push (fast-forward) at phase end.
Owner decisions 2026-10-18 are in STATE.md and are binding.

## Phases

- [x] **Phase 1: Row 59 model turn on the owning host** - remote-first leg runs a real Claude prompt on GEX44 as orca-svc
- [x] **Phase 2: Row 24 freshness window** - a ready setup counts as hydrated only if updated in the last 7 days; unit + mutant + live rerun
- [x] **Phase 3: Row 27 local inference re-measure + bake-off** - GEX44 :8081 qwen3-coder-30b measured, then compared with Claude on a fixed prompt set
- [x] **Phase 4: Row 17 tunnel leg + UWCP node adapter** - laptop-to-GEX44 tunnel leg; PP adapter consuming the node manifest
- [x] **Phase 5: Row 76 multi_host_fabric family** - PP tower family + B0 from verified origins + a synthetic violation that goes red
- [x] **Phase 6: Rows 52 and 53 vault records and UKDL rules** - DWS lessons as vault records and evidence-backed UKDL entries in the PP
- [x] **Phase 7: Row 54 promoted standards** - promote the phase 5-6 standards through the CBR in the PP

### Milestone 2 (Owner "dale" 2026-10-18): re-measure the 20 open rows with no external blocker
- [x] **Phase 8: Re-measure ledger for all 20 rows** - read-only sweep + existing tests per row; stamp rows whose whole `done` is already met
- [ ] **Phase 9: Models and routing (rows 25 26 28 30 31 32)** - availability, residency, cognitive routing, quota, identity portability, model switching
- [ ] **Phase 10: Observability and mission integration (rows 6 40 41 43)** - explain query, one trace, economics per execution, Workstream subject on tasks
- [ ] **Phase 11: Robustness legs (rows 47 48 50 75)** - node offline / client dies drills, mixed-version matrix, hydration latency, two-host production reality
- [ ] **Phase 12: Remaining rows (16 37 39 49 51 55)** - workspace capsule, verification policy, multi-client consistency, security, product reality, inheritance

## Phase Details

### Phase 1: Row 59 model turn on the owning host
**Goal**: The one gap of row 59 ("no model turn") is measured: on the owning host, a real Claude prompt issued from the app runs in the host repo and its answer reaches the client.
**Depends on**: Nothing (first phase)
**Success Criteria** (what must be TRUE):
  1. Built on `tests/e2e/hwf-two-host-remote-first.spec.ts` plus the phase-70 orca-svc harness (`create-svc`, `seed-svc`, `svc-backup`, `svc-restore`, `svc-teardown`; driver modelled on `C:\Users\User\Apps\rbl\d4-p70.ps1`), not a new transport.
  2. Manual agent permissions (`agentDefaultArgs.claude = ''`); the Bypass Permissions dialog is never answered (poll returns `bypass-consent-asked`).
  3. A nonce prompt typed in the owning-host agent pane is answered (answer string never present in the prompt), and the existing 6 legs still pass.
  4. `SVC_HOME_RESTORED=True` with `HWF_CLAUDE_PROJECTS=0`, teardown REMAINING=0 PROC_COUNT=0, witness unchanged; row 59 restated.
**Plans**: TBD

### Phase 2: Row 24 freshness window
**Goal**: Placement treats a host's ready setup as hydrated only when its `updatedAt` is within 7 days; older ready setups rank as unhydrated (never ineligible).
**Depends on**: Phase 1
**Success Criteria** (what must be TRUE):
  1. One named constant (7 days) at the placement input; the clock is injected, never `Date.now()` inside the ranking.
  2. Unit tests: fresh hydrated, stale treated unhydrated, boundary at exactly 7 days, missing updatedAt treated unhydrated; written red first; a mutant (window ignored) goes red.
  3. tsc + oxlint + oxfmt clean on touched files; existing placement tests green.
  4. Live: the r24 leg reruns with a stale and a fresh setup and the persisted task_placements show the difference; row 24 restated.
**Plans**: TBD

### Phase 3: Row 27 local inference re-measure + bake-off
**Goal**: Replace "conflicting records" with a measurement of GEX44 local inference and a bake-off against Claude.
**Depends on**: Phase 2
**Success Criteria** (what must be TRUE):
  1. Re-measure: what serves on GEX44 :8081 (model id from the server itself), resident or not, tokens/s and first-token latency over N>=5.
  2. A fixed, committed prompt set (>=10 code tasks with machine-checkable expected answers) run against local qwen3-coder-30b and against Claude as orca-svc (`claude -p`), same prompts, same scorer.
  3. Results committed as JSON + doc with latency, throughput, pass rate per side; a control shows the scorer can fail an answer.
  4. Row 27 restated from the measurement (the `done` is "re-measured + bake-off").
**Plans**: TBD

### Phase 4: Row 17 tunnel leg + UWCP node adapter
**Goal**: Close the two named gaps of row 17: the laptop-to-GEX44 tunnel leg and the UWCP adapter that consumes the node manifest.
**Depends on**: Phase 3
**Success Criteria** (what must be TRUE):
  1. Laptop leg: `tests/e2e/dws-node-manifest-fanout.spec.ts` (or the runner `config/scripts/dws-node-manifest-run.ps1`) over an `ssh -L` tunnel to orca-dws-serve 127.0.0.1:6791, fields MATCH, serve MainPID unchanged, tunnel torn down.
  2. First locate the UWCP S4-22 definition in the PP; record where it is, or that it is undefined.
  3. PP adapter (in pp-dws-rows-wt only) reads `config/schemas/orca-node-manifest-1.schema.json`-shaped manifests with freshness bound, refuses stale/malformed ones, PP-style V-* tests incl. a red-first case and a mutant.
  4. Row 17 restated with both legs.
**Plans**: TBD

### Phase 5: Row 76 multi_host_fabric family
**Goal**: The PP tower has a `multi_host_fabric` family whose B0 is built from verified origins (rows already PASS in the matrix), and a synthetic future violation goes red.
**Depends on**: Phase 4
**Success Criteria** (what must be TRUE):
  1. `vault/tower/families/multi_host_fabric.json` in the same shape as the 4 existing families; `vault/tower/baselines/multi_host_fabric/B0.json` built with the existing `tools/family_baseline.py`, each origin citing a commit/evidence that exists.
  2. A `tools/test_tower_*`-style test: B0 passes; a synthetic violation goes red; a control proves the test reads the family.
  3. Existing tower tests still green.
  4. Row 76 restated.
**Plans**: TBD

### Phase 6: Rows 52 and 53 vault records and UKDL rules
**Goal**: The DWS lessons measured in this program are written as PP vault records (row 52) and as evidence-backed UKDL entries (row 53), in the locations the PP already uses.
**Depends on**: Phase 5
**Success Criteria** (what must be TRUE):
  1. Records in `vault/lessons/` (format of the existing 46 files), each citing commit + evidence path; at least: Ink CSI-C screen reading, service-home restore, bypass consent belongs to the Owner, Continue-here session transfer read-back.
  2. UKDL entries in the PP's existing UKDL files with evidence fields; no duplicate of an existing entry (grep first).
  3. The PP's vault validation (`python tools/vault_sync.py --validate` or the repo's own validator) passes.
  4. Rows 52 and 53 restated.
**Plans**: TBD

### Phase 7: Row 54 promoted standards
**Goal**: Standards from phases 5-6 are promoted through the Constitutive Baseline Ratchet (`modules/tower/ratchet.py`, `baselines.py`), not by hand-editing.
**Depends on**: Phase 6
**Success Criteria** (what must be TRUE):
  1. Promotion uses the ratchet's own entry point; the promoted record is read back.
  2. The ratchet's tests pass; a demotion/regression attempt is refused (control).
  3. Row 54 restated.
**Plans**: TBD

## Milestone 2 Phase Details

Rules for every phase 8-12: the rows are rows of `config/dws-completion-matrix.jsonc` whose `reason` names no
BLOCKED_EXTERNAL. Their reasons are mostly Stage Zero text ("not yet evidenced") that was never re-measured, so the
first act on a row is to find what already exists (code, tests, evidence, earlier phases) before building anything.
A product change is allowed only when the gap is one small, local change with a red-first test and a mutant; a
larger gap is NOT built here: the row is restated PARTIAL/ABSENT with the gap named precisely (file, function,
missing behaviour) and listed in the phase's VERIFICATION as residual. Live legs follow the STATE laws (RAM >= 6 GB,
one Electron at a time, teardown REMAINING=0 PROC_COUNT=0, witness unchanged). Matrix edits: exact string
replacement only, checker exit 1 (never 2), its vitest green. Push rb-live fast-forward at phase end.

### Phase 8: Re-measure ledger for all 20 rows
**Goal**: One committed ledger `docs/dws/remeasure-2026-10-18-ledger.md` classifies each of rows 6 16 25 26 28 30 31 32 37 39 40 41 43 47 48 49 50 51 55 75 from evidence, and rows whose whole `done` is already met are stamped.
**Depends on**: Phase 7
**Success Criteria** (what must be TRUE):
  1. For every row: the `done` text, the existing code/tests/evidence found (paths), the tests actually run with their counts, and one class: MET (done fully evidenced), MEASURABLE (an existing test/leg would decide it), SMALL-GAP (one local change), LARGE-GAP (named, not built here), OUT-OF-PROGRAM (named external dependency).
  2. Every "nothing found" claim carries the search that would have found it and a positive control (a known-present symbol found by the same search).
  3. MET rows restated PASS with evidence entries that resolve; no row is stamped PASS from code reading alone, only from a test or leg that ran.
  4. Phases 9-12 plans use this ledger, not the old reasons.
**Plans**: TBD

### Phase 9: Models and routing (rows 25 26 28 30 31 32)
**Goal**: Each row is decided by measurement: fail-closed availability states, AVAILABLE != RESIDENT drill (GEX44 :8081 is a real resident model), routing reads quota, agent identity across provider/model change.
**Depends on**: Phase 8
**Success Criteria** (what must be TRUE):
  1. Each row restated from what ran (tests and, where the `done` needs it, a GEX44 leg); rows 28 and 32 share one claim (row 28 reason) and are decided together.
  2. Every PASS has a negative control (the same check made to fail).
  3. Gaps beyond SMALL-GAP named as residual.
**Plans**: TBD

### Phase 10: Observability and mission integration (rows 6 40 41 43)
**Goal**: Decide whether one execution can be explained end to end, joined in one trace, and charged per execution, and whether a task carries its Workstream subject.
**Depends on**: Phase 9
**Success Criteria** (what must be TRUE):
  1. A real execution (not a fixture) is followed through the existing telemetry/ledgers; the join key is named or its absence is shown with a control.
  2. Economics per execution comes from a measured meter, never an estimate labelled as spend.
  3. Rows restated; gaps named.
**Plans**: TBD

### Phase 11: Robustness legs (rows 47 48 50 75)
**Goal**: Run the drills that exist or are one step from existing: node offline and client death during a two-host run, mixed-version client/host for the new verbs, hydration latency N>=5 with a named instrument, and the row 75 production-reality leg.
**Depends on**: Phase 10
**Success Criteria** (what must be TRUE):
  1. Each drill reports PASS / FAIL / NOT_RUN / HARNESS_FAILED separately, with evidence under C:\Users\User\Apps\rbl\.
  2. Latency numbers carry instrument, N, and spread; no single-run number.
  3. Rows restated; gaps named.
**Plans**: TBD

### Phase 12: Remaining rows (16 37 39 49 51 55)
**Goal**: Decide the workspace capsule, verification policy, multi-client consistency, security, product reality (goldens) and inheritance verification (planted regression goes red) rows.
**Depends on**: Phase 11
**Success Criteria** (what must be TRUE):
  1. Row 55 needs a planted regression that the inheritance check turns red, plus the clean control.
  2. Row 49 (security) is decided against named threats, not a general review; row 51 against each named golden.
  3. Every row restated; the final VERIFICATION lists each of the 20 rows with its final state and residual.
**Plans**: TBD
