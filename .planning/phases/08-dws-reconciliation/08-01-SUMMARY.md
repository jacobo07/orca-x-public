---
phase: 08-dws-reconciliation
plan: 01
status: complete
completed: 2026-10-26
key-files:
  modified:
    - src/main/runtime/rpc/terminal-send-mobile-scope.test.ts
---

# Plan 08-01 Summary

## Stale writes and the controller (Orca half of rows 33/39)
Scope test now 6/6: a stale desktop write and a stale mobile write are both refused
`terminal_handle_stale` with zero bytes; with the phone subscribed and sending, its send is accepted and
FRESH and the driver is `mobile{phone-1}`; a desktop send to the same PTY returns accepted:false,
bytesWritten:0 and no bytes reach the PTY.

## Relay zero with a positive control (X18 / row 74)
relay-sent-method-tally + ssh-relay-capabilities: 13/13.

## X16 placement reaches dispatch
mission-dispatch-placement, mission-job-placement, missionPlace distribution and spread goldens: 69/69.

## Drills (job tmp mutate-p8*.ps1, 17:07-17:11)
| Mutant | Result | Failing assertion |
|---|---|---|
| P8-M1 input lock ignores the controller | CAUGHT, RESTORE_VERIFIED | desktop accepted while phone holds the floor |
| P8-M2 mobile send never takes the floor | CAUGHT, RESTORE_VERIFIED | driver stayed idle |
| P8-M3 generation ignored | CAUGHT, RESTORE_VERIFIED | stale mobile and stale desktop writes accepted |
| P8-M4 multiplexer stops tallying | CAUGHT, RESTORE_VERIFIED | tally undefined after writes |
| P8-M5 gate ignores the advertisement | CAUGHT, RESTORE_VERIFIED | old relay received the method |
| P8-M6 worker start ignores placement | CAUGHT, RESTORE_VERIFIED | placement_mismatch not thrown |

## Verdicts on the GEX44 DWS units (receipts read 2026-10-26)
| Unit | Row | Code on this branch | Verdict | What lifts it |
|---|---|---|---|---|
| X05 | 60 | yes (85868ddf4 ancestor of HEAD) | PARTIAL, keep | row 63 ancestry on transferred objects plus a real two-host run (Phase 9) |
| X06 | 63 | NO (e38da01d3, 709e55b89, 98ba3942b not in this repo) | PARTIAL, needs port | port exec/row-63 from the dws-exec tree, wire into the SSH provider, two-host run |
| X16 | 72 | yes (edff54cd4); dispatch wiring landed later (04-03..04-07) | PARTIAL, code done | run tests/e2e/hwf-two-host-mission-placement.spec.ts Windows<->GEX44 (Phase 9) |
| X18 | 74 | yes (d9f77845d); instrument + control proven here | PARTIAL, code done | run tests/e2e/hwf-two-host-mixed-relay.spec.ts with an old relay build (Phase 9; needs a second install, RAM) |
| X19 | 31 | NO (1a7e61bfe, 4ff0b2cb1 not in this repo; spec absent) | PARTIAL, needs port | port exec/row-31-t2, then run hwf-two-host-agent-identity.spec.ts |

None is relaunched: all five are blocked on a live two-host leg or a port, not on agent effort.
DWS matrix not edited (08-CONTEXT D-04).
