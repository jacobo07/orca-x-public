# Row 24 — freshness window, live leg (2026-10-18)

Run `r24f`, evidence directory `C:\Users\User\Apps\rbl\d4-ev-r24f-20261018-175542`, launched with `run-leg.ps1 -Row 24 -Tag r24f -Specs tests/e2e/hwf-two-host-mission-locality.spec.ts -Driver p24`. Laptop free RAM was 7.52 GB (above the 6 GB admission floor); the paired host is the GEX44 private sshd root `/tmp/orca-hwf-p22-20261018T155542Z` (REAL-TWO-HOST).

## Verdict

`verdict.json`: PASS, "passed with every marker", playwright exit 0, 1 passed / 0 failed / 0 skipped, `teardown_clean: true`.

## What the freshness leg seeded and read back

Two ready local setups of different projects, both `setupState: ready`, only `updatedAt` differing (`HWF24_SEEDED_SETUPS`):

- `p24-stale::local`, `updatedAt` 1791647790896 (8 days before the run clock);
- `p24-fresh::local`, `updatedAt` 1792338990896 (inside the 7-day window).

Each task placed through the real `orchestration.missionPlace` handler, then read from the app's persisted `task_placements`:

```
HWF24_FRESHNESS_WINDOW stale(8d)->runtime:63bfded1-46ae-4195-b59c-5b751a10a595 fresh->local
```

`HWF24_STALE` locality: `hydrated:false`, placed on the GEX44 runtime. `HWF24_FRESH` locality: `hydrated:true`, placed on `Local Windows`. The stale setup stayed eligible (it was placed, not rejected: `rejected:[]`), it only lost its hydrated rank.

The same run re-passed the two earlier discriminating legs: `HWF24_HYDRATED_PREFERRED` (local setup preferred over the roomier runtime) and `HWF24_REMOTE_PREPARED_PREFERRED` (a setup imported on the paired runtime alone placed there at load 1 over the idle laptop).

## Restoration

`WITNESS_UNCHANGED=True` (known-hosts SHA, ORCA_X_HEAD and relay listing identical before and after), teardown `REMAINING=0`, `PROC_COUNT=0`.

## Not covered

The seeded setups are folder setups at `/tmp`; the window is exercised through the registry's `updatedAt`, not through a setup that went stale by real elapsed time.
