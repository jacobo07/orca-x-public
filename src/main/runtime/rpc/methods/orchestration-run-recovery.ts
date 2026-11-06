import { z } from 'zod'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import {
  coordinatorOwnsRun,
  RUN_ABANDON_METHOD,
  RUN_RESET_COORDINATOR_METHOD,
  type CoordinatorRecoveryRequest
} from '../../orchestration/headless-coordinator'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const RunResetCoordinatorParams = z.object({
  run: requiredString('Missing --run'),
  headless: requiredString('Missing --headless')
})
const RunAbandonParams = z.object({ run: requiredString('Missing --run'), from: OptionalString })

const APPROVED_IN_DESKTOP = 'Approved by the Owner in the Orca desktop confirmation.'
const REQUESTED_BY_COORDINATOR = 'Requested by the coordinator of this Run.'

function requireHeadlessRun(db: OrchestrationDb, runId: string) {
  const run = db.getRun(runId)
  if (!run) {
    throw new OrchestrationError('run_not_found', `Run ${runId} was not found.`)
  }
  // Why: a terminal Run has a live owner with its own recovery; this path must not take it over.
  if (db.getCoordinatorTokenHash(runId) === null) {
    throw new OrchestrationError(
      'invalid_argument',
      `Run ${runId} has no headless coordinator. No effects were applied.`,
      { effectsApplied: false }
    )
  }
  return run
}

async function requireDesktopConfirmation(
  runtime: OrcaRuntimeService,
  request: CoordinatorRecoveryRequest,
  signal: AbortSignal | undefined
): Promise<void> {
  const confirm = runtime.getCoordinatorRecoveryConfirmer()
  if (!confirm) {
    throw new OrchestrationError(
      'confirmation_unavailable',
      'This needs the Owner to confirm in the Orca desktop app, and this host has none. No effects were applied.',
      { effectsApplied: false }
    )
  }
  const approved = await confirm(request, signal)
  // Why the signal too: a Yes that lands after the caller left has nobody to act for.
  if (!approved || signal?.aborted) {
    throw new OrchestrationError(
      'confirmation_declined',
      'The Owner did not confirm. No effects were applied.',
      { effectsApplied: false }
    )
  }
}

function abandonDispatch(runtime: OrcaRuntimeService, db: OrchestrationDb, dispatchId: string) {
  const abandoned = db.abandonWorkerDispatch(dispatchId)
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  if (abandoned.disposition === 'context_only') {
    return {
      dispatchId,
      state: abandoned.state,
      terminalHandle: db.getDispatchContextById(dispatchId)?.assignee_handle ?? null,
      residualResources: [] as unknown[]
    }
  }
  return {
    dispatchId,
    state: abandoned.worker.state,
    terminalHandle: abandoned.worker.agent_terminal_handle,
    residualResources: JSON.parse(abandoned.worker.residual_resources) as unknown[]
  }
}

export const ORCHESTRATION_RUN_RECOVERY_METHODS: RpcMethod[] = [
  defineMethod({
    name: RUN_RESET_COORDINATOR_METHOD,
    params: RunResetCoordinatorParams,
    handler: async (params, { runtime, headlessCoordinator, signal }) => {
      const db = runtime.getOrchestrationDb()
      const run = requireHeadlessRun(db, params.run)
      const replacementHash = headlessCoordinator?.newTokenHash
      if (!headlessCoordinator || !replacementHash) {
        throw new OrchestrationError(
          'coordinator_auth_failed',
          'A reset needs a replacement credential. No effects were applied.',
          { effectsApplied: false }
        )
      }
      const { handle } = headlessCoordinator
      db.assertCoordinatorNameAvailable(run.id, handle)
      await requireDesktopConfirmation(
        runtime,
        {
          action: 'reset-coordinator',
          runId: run.id,
          objective: run.objective,
          coordinatorHandle: run.coordinator_handle,
          newCoordinatorHandle: handle
        },
        signal
      )
      const reset = db.resetHeadlessCoordinator({
        runId: run.id,
        expectedGeneration: run.consumer_generation,
        handle,
        tokenHash: replacementHash,
        eventBody: `Coordinator set to ${handle}. ${APPROVED_IN_DESKTOP}`
      })
      // Why: a waiter still blocked on the old credential must not receive mail after the reset.
      runtime.cancelMessageWaiters(`run:${run.id}`)
      for (const waiting of new Set([run.coordinator_handle, handle])) {
        if (waiting) {
          runtime.cancelMessageWaiters(waiting)
        }
      }
      return { run: reset, binding: { consumerGeneration: reset.consumer_generation } }
    }
  }),
  defineMethod({
    name: RUN_ABANDON_METHOD,
    params: RunAbandonParams,
    handler: async (params, { runtime, headlessCoordinator, signal }) => {
      const db = runtime.getOrchestrationDb()
      const run = requireHeadlessRun(db, params.run)
      const byOwner = coordinatorOwnsRun(db, run.id, headlessCoordinator)
      if (!byOwner) {
        await requireDesktopConfirmation(
          runtime,
          {
            action: 'abandon-run',
            runId: run.id,
            objective: run.objective,
            coordinatorHandle: run.coordinator_handle
          },
          signal
        )
      }
      db.assertRunGeneration(run.id, run.consumer_generation)
      // Why first: a failure here leaves the coordinator bound, so the same call can be repeated.
      const dispatches = db
        .listAbandonableDispatchIds(run.id)
        .map((dispatchId) => abandonDispatch(runtime, db, dispatchId))
      db.unbindAbandonedRun({
        runId: run.id,
        eventBody: `Run abandoned with ${dispatches.length} live dispatch(es). ${
          byOwner ? REQUESTED_BY_COORDINATOR : APPROVED_IN_DESKTOP
        }`
      })
      runtime.cancelMessageWaiters(`run:${run.id}`)
      if (run.coordinator_handle) {
        runtime.cancelMessageWaiters(run.coordinator_handle)
      }
      return {
        runId: run.id,
        dispatches,
        processAction: 'none',
        warning:
          'Worker terminals were left running; nothing was stopped or deleted. Close them yourself.'
      }
    }
  })
]
