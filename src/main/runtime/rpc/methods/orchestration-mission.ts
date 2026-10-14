import { z } from 'zod'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { integrateMissionResults } from '../../../../shared/mission-job-placement'
import { readFleetObservation } from '../../../fleet/fleet-observation-slot'
import {
  dispatchRanOnPlacement,
  planDispatchableMission
} from '../../orchestration/mission-dispatch-placement'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, type RpcMethod } from '../core'
import { isLocalRpcCaller } from '../local-rpc-caller'
import { DEFAULT_FLEET_SAMPLE_MAX_AGE_MS } from './fleet'
import { requiredString } from '../schemas'

const MissionPlaceParams = z
  .object({
    run: z.string().min(1).optional(),
    from: requiredString('Missing --from'),
    tasks: z.array(z.string().min(1)).min(1).max(64)
  })
  .strict()

const MissionResultsParams = z.object({ run: requiredString('Missing --run') }).strict()

function boundRun(runtime: OrcaRuntimeService, db: OrchestrationDb, from: string, run?: string) {
  const pane = runtime.getTerminalPaneKey(from)
  const bound = pane ? db.getCurrentRunForPane(pane) : undefined
  if (!bound || (run && run !== bound.id)) {
    throw new OrchestrationError(
      'consumer_fenced',
      'mission-place requires the coordinator terminal currently bound to the Task Run.'
    )
  }
  return bound
}

export const ORCHESTRATION_MISSION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.missionPlace',
    params: MissionPlaceParams,
    handler: async (params, ctx) => {
      // Why: planning has this host observe its own paired runtimes; a peer must not drive that.
      if (!isLocalRpcCaller(ctx)) {
        throw new OrchestrationError('remote_caller_refused', 'mission-place is local-only.')
      }
      const { runtime } = ctx
      const db = runtime.getOrchestrationDb()
      const run = boundRun(runtime, db, params.from, params.run)
      const tasks = [...new Set(params.tasks)]
      for (const taskId of tasks) {
        const task = db.getTask(taskId)
        if (task?.run_id !== run.id) {
          throw new OrchestrationError(
            'task_not_found',
            `Task ${taskId} was not found in Run ${run.id}.`
          )
        }
        // Why: a task already started or finished elsewhere would be credited to a host that never ran it.
        if (!db.getTaskPlacement(taskId) && task.status !== 'pending' && task.status !== 'ready') {
          throw new OrchestrationError(
            'task_not_placeable',
            `Task ${taskId} is ${task.status}; only pending or ready tasks can be placed.`,
            { taskId, status: task.status }
          )
        }
      }
      const pending = readFleetObservation()
      if (!pending) {
        throw new OrchestrationError('fleet_unavailable', 'No fleet observer is installed.')
      }
      const observation = await pending
      const plan = planDispatchableMission(tasks, observation.members, {
        now: observation.completedAt,
        maxSampleAgeMs: DEFAULT_FLEET_SAMPLE_MAX_AGE_MS
      })
      const placements = db.placeMissionTasks(
        run.id,
        plan.placements.map((p) => ({
          taskId: p.jobId,
          hostKey: p.hostKey,
          fingerprint: p.fingerprint,
          address: p.address,
          label: p.label
        }))
      )
      return {
        runId: run.id,
        placements,
        unplaced: plan.unplaced,
        rejected: plan.rejected,
        notDispatchable: plan.notDispatchable,
        hostCount: plan.hostCount
      }
    }
  }),
  defineMethod({
    name: 'orchestration.missionResults',
    params: MissionResultsParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const placements = db.listRunTaskPlacements(params.run)
      const jobs = placements.map((p) => {
        const task = db.getTask(p.task_id)
        const dispatch = db.getDispatchContext(p.task_id)
        const federated = dispatch ? db.getFederatedDispatch(dispatch.id) : undefined
        return {
          jobId: p.task_id,
          address: p.address,
          status: task?.status ?? null,
          result: task?.result ?? null,
          ranOnPlacement: dispatchRanOnPlacement(p, dispatch, federated),
          startedAt: dispatch?.dispatched_at ?? dispatch?.created_at ?? null,
          completedAt: task?.completed_at ?? null
        }
      })
      // Why: an outcome counts only where its dispatch ran, so crossHost cannot be met by placement alone.
      const outcomes = jobs.flatMap((j) =>
        j.ranOnPlacement && (j.status === 'completed' || j.status === 'failed')
          ? [{ jobId: j.jobId, status: j.status, result: j.result ?? undefined }]
          : []
      )
      const integrated = integrateMissionResults(
        placements.map((p) => ({
          jobId: p.task_id,
          fingerprint: p.fingerprint,
          hostKey: p.host_key,
          address: p.address as ExecutionHostId,
          label: p.label
        })),
        outcomes
      )
      return { runId: params.run, jobs, ...integrated }
    }
  })
]
