---
phase: 20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4
plan: 05
subsystem: host-availability (institutional close)
status: complete
tags: [institutional-close, verification, handoff, knowledge-vault, ukdl-proposal, fresh-agent, M3-owner-bound, M4-hardware-bound]
requires: [20-01 relay proof and P20-L1/L2, 20-02 OOB probe and live leg, 20-03 wake-proxy composer and OOB contract, 20-04 G6 ratchet and ten mutants]
provides: [docs/reference/host-wake-broker.md, AGENTS.md Host Wake section, 20-UKDL-PROPOSAL.md, 20-oob-probe-evidence.json, 20-VERIFICATION.md (human_needed), STATE.md Owner summary and Agent resume block, 20-FRESH-AGENT-QUESTIONS.md, Knowledge Vault lesson host-wake-packet-sent-is-not-a-host-woken.md (outside the repo)]
affects: [orchestrator fresh-agent run appends to 20-VERIFICATION.md, /gsd-verify-work 20]
tech-stack:
  added: []
  patterns: [two-layer handoff (Owner summary + agent resume block), fresh-agent rubric with resolved file:line citations, UKDL change as a proposal file with collision check and before/after hash]
key-files:
  created:
    - docs/reference/host-wake-broker.md
    - .planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-UKDL-PROPOSAL.md
    - .planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-oob-probe-evidence.json
    - .planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-VERIFICATION.md
    - .planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-FRESH-AGENT-QUESTIONS.md
  modified:
    - AGENTS.md
    - .planning/STATE.md
    - .planning/ROADMAP.md
decisions:
  - "20-05: phase 20 VERIFICATION is human_needed; SC1 verdict OWNER_BOUND (transport independence UNIT in-process relay, live M3 not run), SC2 PASS with real OOB HARDWARE_BOUND, SC3 PASS with the fresh-agent row pending the orchestrator"
  - "20-05: UKDL entries are a proposal file only; the Power Pack UKDL was read only (sha256 unchanged)"
  - "20-05: one new Knowledge Vault lesson, local and uncommitted; no existing vault file edited"
  - "20-05: docs/reference/host-wake-broker.md force-added because .gitignore ignores docs/** (precedent: detach-stop-cancel-effects.md, terminal-preview-observers.md); .gitignore unchanged"
  - "20-05: milestone audit, complete and cleanup not run while phases 5, 7, 9, 17, 18, 19, 20 are human_needed"
metrics:
  duration: 14min
  completed: 2026-10-28
  tasks: 3
  files: 8
plan_head_before: 90b0c004413c0c4506651fa342cf576a2e5e85ce
actuals:
  tokens: 16779
  tasks: 3
  commits: 3
---

# Phase 20 Plan 05: Institutional close (reference note, vault lesson, UKDL proposal, verification, handoff) Summary

Phase 20's laws now live in four durable layers: a reference note linked from AGENTS.md, one Knowledge Vault lesson,
a UKDL proposal, and a phase verification that marks M3 OWNER_BOUND and M4 HARDWARE_BOUND. The OOB probe was
re-measured at the phase HEAD: not-supported / hardware_bound_amd_no_amt, AuthenticAMD, MEI 0. STATE.md carries an
Owner summary and an agent resume block. The fresh-agent question set and rubric are ready for the orchestrator.

## Tasks

| Task | Name | Commit | Files |
|---|---|---|---|
| 1 (tracer) | one law through every durable layer | ac107b5b9 | docs/reference/host-wake-broker.md, AGENTS.md, 20-UKDL-PROPOSAL.md (+ vault lesson outside the repo) |
| 2 | OOB re-measured at HEAD, final gates, 20-VERIFICATION.md | eca2617bb | 20-oob-probe-evidence.json, 20-VERIFICATION.md |
| 3 | two-layer handoff and fresh-agent questions | 23b5d7868 | .planning/STATE.md, 20-FRESH-AGENT-QUESTIONS.md |

### Task 1 (tracer)

- Automated verify: exit 0. The note cites 25 distinct repo paths, and every one exists. The AGENTS.md link is
  present, the vault lesson exists, and the proposal has 5 `### (HR|PR|T)-...-001` entries.
- Tracer gate: it is not `blocking-human`. The verify was re-run green, so expansion continued.
- AGENTS.md: `git diff --stat` = `1 file changed, 4 insertions(+)`. That is one `## Host Wake` section, with a
  heading, a blank line and one paragraph line placed after `## Detach, Stop, Cancel`. Nothing else changed.
- Vault lesson: `C:\Users\Jacobo\.claude\knowledge_vault\lessons\host-wake-packet-sent-is-not-a-host-woken.md`.
  - `Test-Path` returned False before the write, so it is a new file.
  - sha256 `8F7D1C59339F2C974F38FE694338C29A467ABFD3A7CD0D043F33DF57A7AC9851`.
  - Its format follows `mobile-chat-send-written-is-not-admitted.md`.
  - It is not committed, and no existing vault file was edited.
- UKDL `ukdl-universal.md` sha256:
  - before: `468CA6543674278D5E92922A133BAE1FCF189813C503BCB1E75CAEC7CF5C9D46`
  - after: `468CA6543674278D5E92922A133BAE1FCF189813C503BCB1E75CAEC7CF5C9D46` (equal; the file was only read)
- Collision check (`Select-String -SimpleMatch`). Each full id and its core slug got 0 hits:
  - T-WAKE-PACKET-SENT-IS-NOT-A-HOST-WOKEN-001 (0; `WAKE-PACKET` 0)
  - HR-UNREADABLE-REGISTRY-IS-UNKNOWN-NEVER-PRESENT-001 (0; `UNREADABLE-REGISTRY` 0)
  - T-LINT-STAGED-STALE-INDEX-001 (0; `LINT-STAGED` 0)
  - PR-RELAY-IS-PROVENANCE-NOT-IDENTITY-001 (0; `RELAY-IS-PROVENANCE` 0)
  - T-UPPERCASE-WIRE-REASON-PARSES-UNSPECIFIED-001 (0; `UPPERCASE-WIRE` 0)

### Task 2

- Live OOB leg at `ac107b5b9`, with `ORCA_LIVE_OOB_PROBE=1` and the evidence written to the phase file:
  - `Test Files  1 passed (1)`, `Tests  1 passed (1)`, exit 0. The leg passed; it was not skipped.
  - Verdict `{"value":"not-supported","reason":"hardware_bound_amd_no_amt","evidence":{"kind":"os-probe","observedAt":1793187695765}}`, vendor `AuthenticAMD`, meiCount `0`.
  - The 20-02 job-tmp run (`observedAt` 1793185595560, same values) is quoted verbatim in 20-VERIFICATION.md, because
    job tmp is not durable.
- Gates at `ac107b5b9`. All are pasted in 20-VERIFICATION.md:
  - vitest: 21/21, 71/71, 35 passed + 2 skipped (secure-file platform rows), 63/63 and 50/50.
  - typecheck:node, the tc.web tsc and typecheck:cli all exit 0.
  - check:host-card-claims prints the exact line ending `6 capability producers classified.`
  - check:recurring-work: total=236, debt=0.
  - check:durability-contracts: 22 contracts, no new ones.
  - oxlint on the ten phase 20 source modules: exit 0.
  - `git diff --quiet -- src config mobile` exit 0.
- Automated verify: exit 0, with 12 mutant rows and 14 decision rows.
- `M3.{0,40}PASS` matches one line: "Ordered Owner procedure (M3 is not PASS until every step is observed)". That line
  states M3 is not PASS.

### Task 3

- Automated verify: exit 0.
  - Each handoff heading occurs exactly once.
  - Deferred Verification row `| 20 |` is present.
  - There are 8 questions.
  - The citations cover 6 distinct files, and all exist. Every `file:line` citation was resolved and its line printed
    and checked against the fact.
- `git diff --stat -- .planning/STATE.md`: `43 insertions(+), 1 deletion(-)`.
  - The one deletion is the old phase 20 progress line. It was rewritten as "plan history (newest first)" with the
    stale "Next: 20-05." removed.
  - No section was removed.
- The fresh-agent run is the orchestrator's next step, and this executor did not dispatch an agent. No checkpoint
  halted this plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The reference note is gitignored**
- **Found during:** Task 1 commit. `git add` refused `docs/reference/host-wake-broker.md` because of the `.gitignore:92`
  rule `docs/**`, and the reference allow-list does not name it.
- **Fix:** I staged that one file with `git add -f`. The tracked notes `detach-stop-cancel-effects.md` and
  `terminal-preview-observers.md` are also absent from the allow-list, so they were added the same way.
  `.gitignore` is not in this plan's files and was not changed. The change is recorded in STATE Decisions.
- **Commit:** ac107b5b9

**2. [Rule 1 - Verify wording] Literal headings inside body text**
- **Issue:** the Task 3 verify counts headings with `-SimpleMatch`. The resume block's inline mentions of
  "`## Laws (binding)`" and "`## Deferred Verification`", and the orchestrator steps' "`## Questions`" and
  "`## Rubric`", counted as second occurrences.
- **Fix:** I reworded those mentions ("the Laws (binding) section"). Verify then passed, with each heading occurring
  once.

**3. [Process] Three git calls went through Bash, against STATE law "git through PowerShell"**
- `git add -f`, a `git diff --quiet` and an inline PowerShell call whose `$` variables Bash expanded (that one failed
  harmlessly). All later git calls ran through `.ps1` files in the job tmp directory. No state was affected.

**4. [Wording] M4 board source**
- The plan reads "board MS-7B89 ... from the evidence file". The live probe file records only the vendor and the MEI
  count. 20-VERIFICATION.md therefore cites the board (`B450M MORTAR MAX (MS-7B89)`) from the 20-RESEARCH
  Win32_BaseBoard read (2026-10-27), and cites the vendor and MEI count from `20-oob-probe-evidence.json`.

**5. [Process] GSD state tools after the SUMMARY**
- `state.advance-plan` returned `plan_position_unreadable`, and `state.update-progress` found no `Progress:` line.
  These are pre-existing STATE.md format limits: the frontmatter still reads `current_phase: 10`, as it did before
  this plan. `record-metric`, three `add-decision` calls, `record-session` and `roadmap.update-plan-progress 20`
  succeeded. 20-05 is ticked, and the ROADMAP reads `5/5 plans executed`.
- The tools inserted three blank lines into the new STATE sections, which moved the handoff lines by 1 to 3. Every
  STATE.md citation in the rubric was shifted and then re-resolved (all 14 resolve to the stated fact).
- The tool tagged the three new decisions `[Phase 10]`; they were corrected to `[Phase 20]`.

## Known Stubs

None. This plan wrote documentation and evidence only, and made no production code change.

## Threat Flags

None. The mitigations were applied:
- T-20-23: UKDL hash equal.
- T-20-24: Test-Path ran first, and the file is new.
- T-20-25: the labels section, the SC1 verdict OWNER_BOUND and the M3 wording check are in place.
- T-20-26: the only MAC written is the fictitious `02:00:5e:20:00:01`. No secrets and no device ids were written.
- T-20-27: only scoped Edits touched STATE.md and AGENTS.md.

## Not run

- No milestone audit, complete or cleanup.
- No push, no build, no GEX44 work and no Owner-PC effects.

## Self-Check: PASSED

- FOUND: docs/reference/host-wake-broker.md, 20-UKDL-PROPOSAL.md, 20-oob-probe-evidence.json, 20-VERIFICATION.md,
  20-FRESH-AGENT-QUESTIONS.md, the vault lesson (sha256 above).
- FOUND commits: ac107b5b9, eca2617bb, 23b5d7868 (`git rev-list --count 90b0c0044..HEAD` = 3 before this summary's
  commit).
