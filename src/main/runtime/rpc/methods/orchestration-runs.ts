import {
  COORDINATOR_AUTH_FAILED,
  isHeadlessHandle,
  resolveCallerPaneKey,
  type HeadlessCoordinatorAuthority
} from '../../orchestration/headless-coordinator'
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString, requiredString } from '../schemas'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../../shared/orchestration-run-pagination'
import type {
  OrcaRuntimeService,
  OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { assertCallerHandleMatchesEvidence } from './orchestration-run-scope'

const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  from: requiredString('Missing coordinator terminal')
})

const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal'),
  takeoverLegacy: OptionalBoolean
})

const RunCurrentParams = z.object({ from: requiredString('Missing coordinator terminal') })
const RunListParams = z.object({
  limit: z.number().int().min(1).max(ORCHESTRATION_RUN_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).optional()
})
const RunShowParams = z.object({ id: requiredString('Missing --id'), from: OptionalString })

// Why defensive: the dispatcher gate already refused an unverified headless caller; a handler
// reached some other way must not create or bind a headless Run without that proof.
function requireVerifiedHeadless(
  from: string,
  authority: HeadlessCoordinatorAuthority | undefined
): HeadlessCoordinatorAuthority | undefined {
  if (!isHeadlessHandle(from)) {
    return undefined
  }
  if (authority?.handle !== from) {
    throw new OrchestrationError(COORDINATOR_AUTH_FAILED, 'Headless coordinator not verified.', {
      effectsApplied: false
    })
  }
  return authority
}

function requireCallerPane(
  runtime: OrcaRuntimeService,
  handle: string,
  callerAuthority?: OrchestrationCompatibilityCallerAuthority
): string {
  const paneKey =
    callerAuthority?.terminalHandle === handle
      ? callerAuthority.paneKey
      : resolveCallerPaneKey(runtime, handle)
  if (!paneKey) {
    throw new OrchestrationError(
      'stable_pane_required',
      'The coordinator terminal has no stable pane identity. Run this command inside a live Orca terminal.'
    )
  }
  return paneKey
}

export const ORCHESTRATION_RUN_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.runCreate',
    params: RunCreateParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, headlessCoordinator }) => {
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence)
      const headless = requireVerifiedHeadless(params.from, headlessCoordinator)
      const paneKey = requireCallerPane(runtime, params.from)
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(paneKey)
      const run = db.createRun({
        objective: params.objective,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey,
        ...(headless ? { coordinatorTokenHash: headless.tokenHash } : {})
      })
      runtime.cancelMessageWaiters(params.from)
      if (priorRun) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run, binding: { consumerGeneration: run.consumer_generation } }
    }
  }),
  defineMethod({
    name: 'orchestration.runUse',
    params: RunUseParams,
    handler: (
      params,
      {
        runtime,
        legacyCoordinatorAuthority,
        orchestrationCompatibilityEvidence,
        orchestrationCompatibilityCallerAuthority: callerAuthority,
        headlessCoordinator
      }
    ) => {
      const headless = requireVerifiedHeadless(params.from, headlessCoordinator)
      const paneKey = requireCallerPane(runtime, params.from, callerAuthority)
      if (
        params.takeoverLegacy &&
        (callerAuthority?.terminalHandle !== params.from || callerAuthority.paneKey !== paneKey)
      ) {
        throw new OrchestrationError(
          'legacy_read_only',
          'Legacy takeover must be invoked by the live coordinator agent terminal it will bind. No effects were applied.',
          { effectsApplied: false }
        )
      }
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence)
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(paneKey)
      const run = db.bindRun({
        runId: params.id,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey,
        // Why: a headless binding carries its (possibly rotated) hash; a terminal binding voids it.
        coordinatorTokenHash: headless ? (headless.newTokenHash ?? headless.tokenHash) : null,
        takeoverLegacy: params.takeoverLegacy,
        legacyCoordinatorAuthority
      })
      if (!run) {
        throw new OrchestrationError(
          'run_not_found',
          `Run ${params.id} was not found or is inspect-only.`
        )
      }
      if (headless?.newTokenHash) {
        // Why: an unchanged binding skips bindRun's update, so rotation is applied on its own.
        db.rotateCoordinatorTokenHash(params.id, headless.newTokenHash)
      }
      runtime.cancelMessageWaiters(params.from)
      runtime.cancelMessageWaiters(`run:${params.id}`)
      if (priorRun && priorRun.id !== params.id) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run, binding: { consumerGeneration: run.consumer_generation } }
    }
  }),
  defineMethod({
    name: 'orchestration.runCurrent',
    params: RunCurrentParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence)
      const paneKey = requireCallerPane(runtime, params.from)
      return { run: runtime.getOrchestrationDb().getCurrentRunForPane(paneKey) ?? null }
    }
  }),
  defineMethod({
    name: 'orchestration.runList',
    params: RunListParams,
    handler: (params, { runtime }) => runtime.getOrchestrationDb().listRuns(params)
  }),
  defineMethod({
    name: 'orchestration.runShow',
    params: RunShowParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const run = db.getRun(params.id)
      if (!run) {
        throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
      }
      return { run, events: db.listRunEvents(params.id) }
    }
  })
]
