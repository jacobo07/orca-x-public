---
phase: 04-host-and-runtime-selector-truth
status: passed
verified: 2026-10-26
score: 2/2
---

# Phase 4 Verification

| # | Success criterion | Evidence | Result |
|---|---|---|---|
| 1 | Switching host A to B shows none of A's rows and mutates nothing on A | host-switch-row-isolation (GEX44 34/34 run); P4-M2 CAUGHT; A's traffic = one `worktree.ps` read before the switch | PASS |
| 2 | Never-connected renders as unknown, not offline | host-options "reads a host with no client as not connected, not as a failure" and picker state rows; P4-M3 CAUGHT | PASS |

Also from the phase goal: no background streams for unselected hosts — the picker is observe-only
(`autoConnectHostIds: []`); P4-M1 CAUGHT.

Plane: unit tests on GEX44 (Linux, node 24) in a disposable root. Not device. Runtime-row producer
(`buildMobileSessionRuntimeActions`) was covered by slice-3 tests and not re-drilled here.
