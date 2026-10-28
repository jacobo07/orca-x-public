---
covers:
  [
    cross-host-mission-dispatch,
    row-72,
    mission-placement-dispatch,
    task-placements,
    serve-p22,
    hf-jobs-placed-across-hosts
  ]
tier: T2
status: draft
---

# Cross-Host Mission Dispatch (row 72 B)

## Problem

Row 72's done-line is "two jobs of one mission run concurrently on two hosts with observable
placement and integrated results". Part A (d4/row-72, `0a89359680`) proved placement live: the
proposal holds GEX44 and Local Windows and `planMissionPlacement` puts one job on each. Nothing
runs, though. `planMissionPlacement` and `recordTaskPlacement` have no production callers, so a
plan is a printout and `integrateMissionResults` has no real outcomes to merge.

## What already exists (measured 2026-10-14, HEAD `57f5c9d2be`)

| Concern                              | Owner                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plan one mission over distinct hosts | `planMissionPlacement` (`src/shared/mission-job-placement.ts:35`). Deterministic, authorizes nothing.                                                                                                                                                                                                                    |
| Durable placement record             | `task_placements` (schema v34), `db.recordTaskPlacement` / `listRunTaskPlacements` (`src/main/runtime/orchestration/db.ts:4613`).                                                                                                                                                                                        |
| Fleet members + proposal             | `observeFleet` (`src/main/fleet/fleet-observation-service.ts`), `fleet.placementView` (local callers only).                                                                                                                                                                                                              |
| Start a job on THIS host             | `orchestration.workerStart` without `on` (`src/main/runtime/rpc/methods/orchestration-workers.ts:26`).                                                                                                                                                                                                                   |
| Start a job on a PAIRED runtime      | `orchestration.workerStart` with `on: <environment>` → `startFederatedWorker` (`orchestration-federated-worker-start.ts`): checks the server's `orchestration contract` + `federation` capabilities, records a local dispatch with `federation.peerFingerprint`, calls the remote `orchestration.federationAttachStart`. |
| Remote outcome back home             | `syncFederatedDispatch` (`federation-sync.ts:45`) imports `worker_done` into the local task (`status`, `result`). Local workers settle via `settleWorkerReport` (`db.ts:7551`).                                                                                                                                          |
| Merge outcomes                       | `integrateMissionResults` (`mission-job-placement.ts:86`).                                                                                                                                                                                                                                                               |

The remote-run effect therefore already exists, with its own authority (`workerStart`) and its own
capability negotiation. **This spec adds no new remote effect and no new wire method.** It connects
placement to the existing effect.

## Design

### D1. Placement is recorded by a planner, and the effect checks it

New local RPC `orchestration.missionPlace { run, tasks: string[], from, requirement?, taskRequirements? }` (coordinator-bound like
`workerStart`: `from` must be the terminal bound to the Run):

1. Observe the fleet once (the same observer `fleet.placementView` uses).
2. Keep only **dispatchable** members: `local`, and `runtime:<envId>` members whose `facts.capabilities`
   include both the orchestration-contract and federation capabilities. Everything else, `ssh:*`
   included, is reported in `rejected` with reason `not-dispatchable` and the address. A relay
   cannot run a worker. This also stops one machine being counted twice when it is reachable both
   as an SSH target and as a paired runtime (their identities are different keys today).
3. `planMissionPlacement(jobs = tasks, members = dispatchable, { now, maxSampleAgeMs })`.
4. For every placed job, `recordTaskPlacement` in one transaction. A task that already has a
   placement keeps it (idempotent retry). A different plan for an already-placed task is refused
   with `placement_conflict`, never overwritten.
5. Return the plan: placements, `unplaced`, `rejected`. Starts nothing.

The plan is advisory evidence. The effect authority stays `orchestration.workerStart`, which gains
one check before any effect, for a task that **has** a recorded placement:

- placement `local` and the request has no `on` → proceed as today.
- placement `runtime:<envId>` and the request's `on` resolves to that same `environmentId` →
  proceed to `startFederatedWorker`, which then also requires the resolved server's
  `peerFingerprint` to equal the placement's `fingerprint` (identity re-resolved at the effect, not
  trusted from the plan). Both sides are comparable: the member fingerprint
  (`fingerprintHostPublicKey`) and `peerFingerprint` (`fingerprintOrchestrationPeer`, `index.ts:2769`)
  are each `fingerprintHostKeyBytes` over the preferred pairing offer's key.
- anything else → refuse `placement_mismatch` before `createStartingWorkerDispatch`. Nothing is
  recorded and nothing is started.

A task without a placement behaves exactly as today, so every existing caller is unchanged.

### D2. Optional wire fields only

`missionPlace` runs on the coordinator's own runtime, and the `workerStart` check reads only local
state. The remote still receives the `federationAttachStart` it already accepts; a remote that lacks
the federation capability never becomes a dispatchable member, so it is rejected in the plan instead
of failing at start.

`orchestration.missionPlace` itself gained optional fields (per `docs/reference/remote-wire-compatibility.md`):

- params: `requirement` (one strict resource need applied to every task) and `taskRequirements`
  (a per-task need, keyed by a task in `tasks`, replacing the global need family by family).
- result: `rejectedByJob` (for each task, which hosts were refused and why) and `locality` (entries
  with exactly `taskId`, `hostKey` and `hydrated`, stating whether the placed host already holds the
  project).

Params are strict. A newer client that sends `requirement` or `taskRequirements` to an older local
runtime therefore fails closed on the unknown field instead of placing work without the need. An
older host's result simply lacks the new result fields, and the CLI prints it as before. Nothing else
on the wire changed: no opcode, no published content, no new method.

### D3. CLI

`orca orchestration mission-place --tasks <a,b> [--run <id>] [--from <terminal>] [--json]`
maps to D1. Starting stays `orca orchestration worker-start --task <a> [--on <env>]`, so the
coordinator, or a test, starts each placed job with the address the plan returned.

A task's resource need is stated with
`orca orchestration mission-place --tasks <a,b> --min-available-mb <n> --min-vram-mb <n> --min-disk-mb <n>`.
Each flag is a whole number of megabytes, converted to bytes and sent as the strict `requirement`
object; a value that is not a positive integer, or that overflows in bytes, is refused before any
request. A task is placed only on a host whose measured figures meet the need: an unmeasured or
stale figure is never enough, and an unplaced task is printed with each host's reason. The same
flags (`--min-vram-mb`, `--min-disk-mb`, plus the older `--min-available-mb`) shape
`orca fleet placement`.

### D4. Results

An outcome is credited to a placement only when the task's dispatch ran there
(`dispatchRanOnPlacement`): a local placement needs a non-federated dispatch, and a runtime
placement needs a federated dispatch to that environment with the placed peer key. `missionPlace`
refuses (`task_not_placeable`) a task that is neither `pending` nor `ready` and has no placement yet.
Without both rules, a task finished elsewhere, or by a manual `task-update`, would make `crossHost`
true with no remote run (review finding, 2026-10-14).

There is no new store. `integrateMissionResults(listRunTaskPlacements(run) → placements,
taskList → {jobId, status, result})`. Exposed read-only as `orchestration.missionResults { run }`
so the e2e and the UI read the same merge.

## Harness: `serve-p22`

`hwf-two-host-disposable-root.sh serve-p22 <root> <worktree> <launch>`, modelled on `serve-p20`:
it uses a forced `HOME=$ROOT/home` and `ORCA_USER_DATA_PATH=$ROOT/serve-data`, so GEX44's real
agent homes are never instrumented. Unlike p20 it runs **with pairing** and prints the pairing
offer. It binds 127.0.0.1. The laptop reaches it through an `ssh -L` forward that the spec owns and
kills. The remote job's agent is a deterministic stub on the forced HOME's PATH that reports done
through the Orca CLI, so the outcome is a real `worker_done` crossing federation, not a fixture.
`teardown` already kills the root's processes. The witness before/after must be unchanged.

## Acceptance criteria

1. Hermetic: `missionPlace` keeps `local` + capable `runtime:` members, rejects `ssh:` and
   capability-less runtimes as `not-dispatchable`, records placements atomically, is idempotent on
   retry and refuses a conflicting re-plan.
2. Hermetic: `workerStart` refuses `placement_mismatch` (wrong host, `on` missing for a remote
   placement, `on` present for a local one, and a changed peer fingerprint) **before** any dispatch
   row exists. It is unchanged for a task with no placement. Each refusal asserts its reason code.
3. Mutants go red: drop the mismatch check; record without the transaction; let `ssh:` members
   through.
4. Live (new spec `tests/e2e/hwf-two-host-mission-dispatch.spec.ts`, phase 22, laptop → GEX44
   disposable root): pair with `serve-p22`, `mission-place` two tasks → one `local` and one
   `runtime:<gex44>`, start both, and both reach `completed` with their own result. Their run
   windows overlap (concurrency measured from `started_at`/`completed_at`, not assumed), and
   `missionResults.crossHost === true`. Teardown 0, witness unchanged.
5. Gates: vitest on the touched suites, `tsc` node, oxlint/oxfmt, max-lines ratchet, and
   `check:durability-contracts` (no new publisher expected: `task_placements` is the existing
   SQLite db).

Row 72 becomes PASS only on criterion 4.

## Out of scope

- Unifying one machine's SSH-key and runtime-key identities into one placement host.
- Automatic dispatch: the coordinator or test still calls `worker-start` per job.
- SSH-target execution (a relay never runs a worker).

## Rollback

Revert the commits. `missionPlace` is opt-in, and the `workerStart` check fires only for tasks
that carry a placement. Nothing in production writes placements before this lands, so existing
runs are unaffected.

## Open questions (decided by default unless the Owner says otherwise)

- The stub agent for the live leg is a stub rather than a real Claude/Codex turn. Default: stub,
  because the row measures dispatch, not agent quality and not spend.
- Should `mission-place` also start the jobs? Default: no. Planning and starting stay separate
  effects, matching "a plan authorizes nothing".
