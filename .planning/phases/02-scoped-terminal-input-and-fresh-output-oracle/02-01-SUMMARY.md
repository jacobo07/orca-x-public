---
phase: 02-scoped-terminal-input-and-fresh-output-oracle
plan: 01
status: complete
completed: 2026-10-26
key-files:
  created:
    - src/shared/terminal-fresh-output-oracle.ts
    - src/main/runtime/rpc/terminal-send-mobile-scope.test.ts
  modified:
    - src/shared/terminal-fresh-output-oracle.test.ts
---

# Plan 02-01 Summary

- Oracle `judgeFreshTerminalOutput`: FRESH only for an exact output line `MARKER NONCE` on the addressed
  handle; history is CONTAMINATED, a truncated read or a missing pre-send cursor is UNKNOWN, sent text
  that already contains the joined line is UNKNOWN. 7/7.
- Scope proof on the real `OrcaRuntimeService` behind the real `TERMINAL_METHODS` dispatcher, mobile
  send shape, fake shell that runs `echo`: addressed PTY FRESH with zero bytes on the active sibling;
  sibling ABSENT; foreign-runtime handle refused `terminal_handle_stale` with zero writes; stale
  generation refused with zero writes. 4/4.
- No product code changed: host, runtime and generation fencing already existed
  (`getLiveLeafForHandle`, `resolveLiveLeafForHandle`); this phase proves it on the mobile send path.

## Mutation drills (driver: job tmp mutate-p2.ps1, 2026-10-26 16:29-16:31)
| Mutant | Planted in | Result | Failing test |
|---|---|---|---|
| History guard removed | oracle | CAUGHT, restored | refuses history |
| M1 generation ignored | orca-runtime.ts (both generation compares) | PLANT_CONFIRMED, CAUGHT, RESTORE_VERIFIED | stale generation |
| M2 host ignored (unknown handle -> local terminal) | terminal.ts send | PLANT_CONFIRMED, CAUGHT, RESTORE_VERIFIED | different host |
| M3 newest terminal (redirect to latest output) | terminal.ts send | PLANT_CONFIRMED, CAUGHT, RESTORE_VERIFIED | all four |

## Gates
- vitest: 2 files, 11/11. oxlint: 0 findings. oxfmt: clean.
- tsc: NOT RUN (laptop RAM law; no full type-check here). Owed on GEX44 or the next heavy pass.

## Deviations
- Wire unchanged: host scope stays the per-host connection plus the runtime-local handle map (02-CONTEXT D-02).
