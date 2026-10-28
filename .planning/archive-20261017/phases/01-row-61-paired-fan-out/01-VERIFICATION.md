---
phase: 01-row-61-paired-fan-out
verified: 2026-10-17T19:20:00Z
status: passed
score: 4/4 must-haves verified
covered_files:
  - .planning/phases/01-row-61-paired-fan-out/01-01-PLAN.md
  - .planning/phases/01-row-61-paired-fan-out/01-01-SUMMARY.md
  - tests/e2e/hwf-two-host-fanout-environments.spec.ts
  - config/dws-completion-matrix.jsonc
  - docs/dws/live-2026-10-17-row-61-evidence.md
covered_digest: "v1:sha256:26b8ea0f99fa91052560f4344dab280ef5e03f2e45e5af665a7b6acd55d60ce6"
behavior_unverified: 0
---

# Phase 1: Row 61 paired fan-out Verification Report

**Phase Goal:** Measure the fan-out half of row 61 live: two saved paired environments, the reachable one answered with its replicas, host and role, the downed one unreachable, and the exit never claiming the downed host holds nothing.
**Verified:** 2026-10-17T19:20:00Z (by the arming session, from the run's own logs)
**Status:** passed

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Two saved environments in an isolated e2e userData, each paired to a real disposable-root `orca serve` on GEX44 over loopback + SSH tunnel; orca-dws-serve untouched | ✓ VERIFIED | `rbl\d4-ev-r61c-20261017-192312\driver.log`: ROOT_up/ROOT_down `/tmp/orca-hwf-p22-*`, SERVE_up=0 SERVE_down=0, ports 36469/42437 |
| 2 | `orca project setups --all-environments` shows one runtime answered with replicas and one unreachable, from the real CLI against the real app | ✓ VERIFIED | playwright.log `HWF61_AFTER`: p61-down `unreachable`, p61-up `answered` with setups; text `p61-down: unreachable (could not reach this Orca server); replicas unknown, not none.`; `HWF61_FANOUT up=answered down=unreachable`; 1 passed |
| 3 | Control: with both carriers up, both read answered | ✓ VERIFIED | playwright.log `HWF61_CONTROL`: both entries `answered` before the carrier kill |
| 4 | Matrix row 61 restated with evidence doc; teardown REMAINING=0, PROC_COUNT=0; witness unchanged | ✓ VERIFIED | a9ab568823 on origin orca-x/dws-rebaseline-live (matrix 28/76, row 61 PASS, docs/dws/live-2026-10-17-row-61-evidence.md); driver.log TEARDOWN_up/down=0, WITNESS_UNCHANGED_up/down=True |

**Score:** 4/4 truths verified

## Gaps

None for the phase goal. Not covered (recorded on the row): multi-replica runtimes; `unauthorized`, `unsupported-by-host`, `failed` outcomes are unit-only.
