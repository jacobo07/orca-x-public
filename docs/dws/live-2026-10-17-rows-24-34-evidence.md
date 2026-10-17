# Live two-host leg 2026-10-17: rows 24 and 34 (hydrated-node locality, automatic distribution)

## Plane

REAL-TWO-HOST. The Electron app built in the laptop worktree `orca-rb-live-wt` (branch `rb-live`), driven by
Playwright through `orcaPage`, with an isolated e2e userData holding one saved environment paired to a disposable
root `orca serve` on GEX44 (`/tmp/orca-hwf-p22-*`, loopback bind with pairing), reached through an `ssh -L`
same-number carrier started by the spec. The `orca-dws-serve` unit was not touched.

## Instrument

`orchestration.missionPlace` on the app's own handler, called through `RuntimeClient`; placements read back from the
`task_placements` table of the app's `orchestration.db`, not from the call's return value. Controls:

- The remote must be a measured, dispatchable member before planning (`fleet placement --capabilities
  orchestration.contract.v1,orchestration.federation.v1` lists it), asserted hard. Without the carrier the sample was
  `unreachable` and the host never became a member; that reading is why the carrier is in the spec.
- Free memory of the two hosts must differ, or hydration could not be told apart from a plain ranking.
- A control task of a project with no setup anywhere must go to the roomier host with `hydrated: false`.

## Run (evidence `C:\Users\User\Apps\rbl\d4-ev-r24h-20261017-213756`)

| Leg | Result |
|---|---|
| measured memory | local 10.6 GB, GEX44 runtime 59.3 GB (GEX44 roomier) |
| ready setups of the project | `["local"]` (read back with `projectHostSetup.list`) |
| control (no setup) | placed on the GEX44 runtime, `hydrated false` |
| hydrated task | placed on `local` despite less memory, `locality hydrated true` |
| spread a, b, c (c depends on a) | `hostCount 2`; a on `local`, b on the GEX44 runtime; 2 distinct addresses over the three |
| persisted read-back | the `task_placements` rows match the planner result for control, hydrated, a and b |

Spec: `tests/e2e/hwf-two-host-mission-locality.spec.ts` (1 passed, 39.7 s). Driver: `C:\Users\User\Apps\rbl\d4-p24.ps1`.
Earlier runs failed at harness stages (project identity refused on import; the remote read `unreachable` so it was
never a member) and are not evidence.

Teardown: `REMAINING=0`, `PROC_COUNT=0`, `WITNESS_UNCHANGED=True`.

## Not covered

- The hydrated setup is the laptop's own repo-backed setup. Importing a folder on the paired host
  (`setupExistingFolder` with the remote as host) is in the spec but only runs when the paired host is the
  lower-memory one; it did not run.
- Row 24 stays PARTIAL: `updatedAt` is not an input, so no freshness window is claimed.
- No job was started on either host; execution on two hosts is row 72 B (`hwf-two-host-mission-dispatch.spec.ts`).
