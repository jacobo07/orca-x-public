---
phase: 01-row-59-model-turn-on-the-owning-host
verified: 2026-10-18T15:33:00Z
status: passed
score: 4/4 must-haves verified
covered_files:
  - .planning/phases/01-row-59-model-turn-on-the-owning-host/01-01-PLAN.md
  - .planning/phases/01-row-59-model-turn-on-the-owning-host/01-01-SUMMARY.md
  - .planning/phases/01-row-59-model-turn-on-the-owning-host/01-02-PLAN.md
  - .planning/phases/01-row-59-model-turn-on-the-owning-host/01-02-SUMMARY.md
  - .planning/phases/01-row-59-model-turn-on-the-owning-host/01-03-PLAN.md
  - .planning/phases/01-row-59-model-turn-on-the-owning-host/01-03-SUMMARY.md
  - config/dws-completion-matrix.jsonc
  - docs/dws/live-2026-10-18-row-59-model-turn-evidence.md
  - tests/e2e/helpers/hwf-two-host-claude-screen.ts
  - tests/e2e/helpers/hwf-two-host-claude-screen.unit.test.ts
  - tests/e2e/hwf-two-host-model-turn.spec.ts
covered_digest: "v1:sha256:d6421d567ce2a72400b49610cb57c32b5d7e761296d4b28452922e039cb57363"
behavior_unverified: 0
---

# Phase 1: Row 59 model turn on the owning host Verification Report

**Phase Goal:** The one gap of row 59 ("no model turn") is measured: on the owning host, a real Claude prompt issued from the app runs in the host repo and its answer reaches the client.
**Verified:** 2026-10-18T14:55:00Z (by the arming session, from the runs' own logs; the worker did the work but wrote no SUMMARY/VERIFICATION, which halted the mission no_progress)
**Status:** passed

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Built on the remote-first spec and the phase-70 orca-svc harness | VERIFIED | a98f54a5e3: `tests/e2e/hwf-two-host-model-turn.spec.ts`, `config/scripts/hwf-two-host-model-turn-driver.ps1`; root `/tmp/orca-hwf-p70-*` |
| 2 | Manual permissions; Bypass dialog never answered | VERIFIED | `rbl\d4-ev-r59m-20261018-150931\driver.log`: `HWF59M_MANUAL=claude-default-args-empty`, `HWF59M_ARGV_BYPASS_FLAG=absent` |
| 3 | Nonce prompt answered on the owning host; existing 6 legs pass | VERIFIED | r59m `HWF59M_OUTCOME=answered`, `HWF59M_TRANSCRIPT_MATCHES=1`, 1 passed; `rbl\d4-ev-r59rf3-20261018-155950\playwright.log` 6 passed |
| 4 | Home restored, teardown clean, row 59 restated | VERIFIED | r59m `SVC_HOME_RESTORED=True`, `HWF_CLAUDE_PROJECTS=0`, `REMAINING=0`, `PROC_COUNT=0`, `WITNESS_UNCHANGED=True`; matrix row 59 PASS at 36876b70e7 (ls-remote equal) |

## Not covered
A Codex model turn (one provider only).

## Re-verification 2026-10-18 (digest refresh)
Only drift since 14:55: config/dws-completion-matrix.jsonc hunks at rows 26-27 (fb16c4f39b, row 27); the row 59 entry and all spec/helper/doc files are byte-identical to 36876b70e7 (git diff empty). Helper unit test re-run: 9 passed. Digest re-stamped.
