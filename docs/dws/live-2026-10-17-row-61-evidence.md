# Live two-host leg 2026-10-17: row 61 (replica topology fan-out over paired environments)

## Plane

REAL-TWO-HOST. The Electron app built in the laptop worktree `orca-rb-live-wt` (branch `rb-live`), driven by
Playwright through `orcaPage`, with an isolated e2e userData holding two saved environments. Each is paired to
its own disposable root `orca serve` on GEX44 (`/tmp/orca-hwf-p22-*`, loopback bind with pairing), reached
through its own `ssh -L` same-number carrier. The `orca-dws-serve` unit was not touched.

## Instrument

The real built CLI (`out/cli/index.js project setups --all-environments`) run against the real app's userData,
read as JSON and as text. Control first: with both carriers up the same call must read both runtimes `answered`,
so `unreachable` afterwards is a reading and not an instrument that cannot see an answer.

## Run (evidence `C:\Users\User\Apps\rbl\d4-ev-r61c-20261017-192312`)

| Leg | Result |
|---|---|
| control, both carriers up | `p61-up` and `p61-down` both `answered`, each with one setup (`hostId local`, `setupState ready`, `replicaTopology` present) |
| carrier of `p61-down` killed | `p61-down` `unreachable`, no `setups` key; `p61-up` still `answered` with its setup; `queried` lists both |
| text exit | `p61-down: unreachable (could not reach this Orca server); replicas unknown, not none.`; no "No project host setups found" for it |

Spec: `tests/e2e/hwf-two-host-fanout-environments.spec.ts` (1 passed, 49.5 s). Driver: `C:\Users\User\Apps\rbl\d4-p61.ps1`.
Earlier attempts `r61` and `r61b` were HARNESS_FAILED at serve start (`SERVE=4`, spec NOT_RUN) and are not evidence.

Teardown on both roots: `REMAINING=0`, `PROC_COUNT=0`, `WITNESS_UNCHANGED=True`.

## Not covered

- Each runtime held one replica (`membership` sole or identity-pending, role `legacy`); a multi-replica fan-out is not live.
- `unauthorized`, `unsupported-by-host` and `failed` outcomes are unit-only (`project-setups-all-environments.test.ts`).
- The Settings UI half and same-runtime CLI half come from phase 16 (`docs/dws/phase-16-replica-topology-evidence.md`).