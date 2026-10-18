---
phase: 12-remaining-rows
verified: 2026-10-18T23:30:00Z
status: passed
covered_files:
  - .planning/phases/12-remaining-rows/12-01-PLAN.md
  - .planning/phases/12-remaining-rows/12-01-SUMMARY.md
  - config/dws-completion-matrix.jsonc
covered_digest: "v1:sha256:015d58909a4a6fc5b0ca911966e1575e1138f2381630a5da4fce665ad32d578a"
---
# Phase 12 Verification

- Row 51: VERIFIED as measured, one of four goldens PASS; residual named.
- Rows 16 39: out of program. Row 49: large gap. Row 55: residual named.
- Checker exit 1 at 45/76, vitest 30/30.

## Not covered
The three failing goldens (cause unclassified), a planted-regression run, a threat model.
