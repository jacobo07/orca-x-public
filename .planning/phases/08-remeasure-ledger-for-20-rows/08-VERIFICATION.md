---
phase: 08-remeasure-ledger-for-20-rows
verified: 2026-10-18T19:30:00Z
status: passed
covered_files:
  - .planning/phases/08-remeasure-ledger-for-20-rows/08-01-PLAN.md
  - .planning/phases/08-remeasure-ledger-for-20-rows/08-01-SUMMARY.md
  - config/dws-completion-matrix.jsonc
  - docs/dws/remeasure-2026-10-18-ledger.md
covered_digest: "v1:sha256:b892f5ca3b2720b38710d53e03559c3227852d74717d164ba026331209c113ff"
---
# Phase 8 Verification

- Criterion 1 (each row has done text, paths, tests run, one class): VERIFIED - ledger lists all 20 rows with a class; rows without a test run say so.
- Criterion 2 (nothing-found claims carry search and control): VERIFIED - rows 6 16 39 40 41 43 47 48 49 50 55 each record the pattern and a positive control.
- Criterion 3 (PASS only from a test that ran): VERIFIED - rows 30 and 32 only; routed-conversation-turn 10/10, routed-agent-provider-switch incl. its mutant; matrix checker exit 1, vitest 30/30.
- Criterion 4 (phases 9-12 use the ledger): the ledger classes are the plan input.

## Not covered
The codex quota write side (row 30), live legs for rows 26 47 51 75, and rows 6 16 37 39 which wait on UWCP.
