# Phase 9 Context

## Criteria (ROADMAP)
1. Row 75 re-measured on Windows and GEX44 with a mobile controller, or PARTIAL with the named residual.
2. Continue here preserves logical project identity, dirty state and Workstream identity, or is not offered.

## Facts in hand
- Continue here (`continueWorkingSetFromProduct`) already resolves the target by project setup
  (`resolveContinueTarget`), so project identity is carried. It restores tabs on the other host's checkout;
  uncommitted files on the source never travel, and before this phase nothing checked for them.
- UWCP is ABSENT (AGENTS.md, Detach/Stop/Cancel): no Workstream object exists to carry. Row 33 needs UWCP.
- The laptop cannot build the app (RAM law), so the two-host leg of criterion 1 cannot run here.

## Decision
Make "not offered" concrete for dirty state: refuse at the effect on a dirty or unreadable source (fail
closed, `unknown` never reads as clean), worded neutrally (dirty) or as a problem (unknown). Workstream
identity: not carried and not claimed. Safe: reversible, internal, no wire change.
