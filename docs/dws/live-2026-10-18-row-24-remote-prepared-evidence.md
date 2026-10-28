# Row 24 — a project prepared only on GEX44 wins placement (live, 2026-10-18)

Plane: REAL-TWO-HOST. Laptop (Windows, e2e build, electron-headless) paired with a disposable
`orca serve` on GEX44 (`/tmp/orca-hwf-p22-20261018T025028Z`, loopback, behind an `ssh -L` carrier,
stopped by the driver); nothing written to `orca-dws-serve.service`.

Runner: `C:\Users\User\Apps\rbl\run-leg.ps1 -Row 24 -Tag r24r -Driver p24` (resource admission, then
`d4-p24.ps1`, then a log-only verdict with markers `HWF24_HYDRATED_PREFERRED` and
`HWF24_REMOTE_PREPARED_PREFERRED`). Evidence directory `C:\Users\User\Apps\rbl\d4-ev-r24r-20261018-045028`.

## Result: 1 passed (1.0 m)

| Leg                     | Observed                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free memory             | local 8.49 GB, GEX44 runtime 59.33 GB                                                                                                                                 |
| Control (no setup)      | placed on the GEX44 runtime, hydrated false                                                                                                                           |
| Laptop-prepared project | placed on local over the roomier GEX44 (the 10-17 leg, re-observed)                                                                                                   |
| Spread (row 34)         | independent a and b on different hosts (a local, b GEX44)                                                                                                             |
| GEX44-prepared project  | ready setups `["runtime:e28809f4…"]` only; in one call the unhydrated first job took GEX44, the hydrated second job also went to GEX44 at load 1 over the idle laptop |
| Teardown                | `SERVESTOP=0`, `TEARDOWN=0`, witness unchanged                                                                                                                        |

## Why the remote leg discriminates

`planMissionPlacement` places jobs by ascending task id and ranks hydrated first, then load, where
load is the number of unrelated jobs of the same call already on that host. With the first job on
GEX44, load alone sends the second to the laptop, as the a/b spread shows in the same run. Only
hydration keeps it on GEX44.

## Not covered (why row 24 stays PARTIAL)

- No freshness window: `updatedAt` of a setup is not read, so an old ready setup counts the same as
  a new one.
