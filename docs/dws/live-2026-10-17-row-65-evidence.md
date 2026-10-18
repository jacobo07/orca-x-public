# Row 65 — one-way sync on a full disk and a lost connection (live, 2026-10-17)

Plane: REAL-SSH. Laptop (Windows, e2e build, electron-headless) to GEX44 through a provisioned
disposable root `/tmp/orca-hwf-p17-20261017T213131Z` and an `ssh -L` carrier; nothing written to
`orca-dws-serve.service`. The full-disk arm runs on a dedicated small local filesystem
(`ORCA_HWF_SMALL_FS_ROOT`, checked by `assertDedicatedTinyFilesystem`), never the system drive.

Runner: `C:\Users\User\Apps\rbl\run-leg.ps1 -Row 65 -Tag r65b -Specs tests/e2e/hwf-two-host-replica-pair.spec.ts`
with `-Grep disk-full-and-disconnect` (resource admission, then `d4-live.ps1`, then a log-only verdict).
Evidence directory `C:\Users\User\Apps\rbl\d4-ev-r65b-20261017-233131`.

## Result: 1 passed (1.1 m)

Every clone starts at the shared seed `e1c174e…` (asserted), behind the GEX44 p17 tip.

| Leg               | Observed                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal filesystem | `synced e1c174e..553346e; there was no uncommitted work to save`, exit 0, HEAD equals the remote tip (control)                                            |
| Full filesystem   | `HWF65_SMALL_FS_FREE_BYTES=0`, then `sync failed: the local disk is full; HEAD was not moved`, exit 1, HEAD unchanged                                     |
| Carrier killed    | SSH state `reconnecting`, then `sync failed: the connection to the host was lost or its relay is unavailable; HEAD was not moved`, exit 1, HEAD unchanged |
| Teardown          | `TEARDOWN_EXIT=0`, `REMAINING=0`, `PROC_COUNT=0`, witness unchanged                                                                                       |

## Red before green

Run r65a failed at the normal-filesystem control with "histories have diverged". `seed-local-p16` adds
a commit on the laptop that the remote does not have, so a plain clone of the local replica was not an
ancestor of p17. `cloneBehind` now resets each clone to the shared seed, and the spec asserts that.

## Not covered

- Stale-generation refusal and capsule-first ordering are covered only by hermetic tests
  (`src/main/replica-pair-service-sync.test.ts`, `src/main/replica-sync.test.ts`). This leg does not
  drive them.
