import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'
import type { RuntimeRpcSuccess } from '../../shared/runtime-rpc-envelope'

type Flags = Map<string, string | boolean>

export type MissionHandlerDeps = {
  callMutation: <T>(
    client: RuntimeClient,
    flags: Flags,
    method: string,
    params: unknown
  ) => Promise<RuntimeRpcSuccess<T>>
  resolveCoordinatorTerminalHandle: (
    flags: Flags,
    cwd: string,
    client: RuntimeClient
  ) => Promise<string>
}

type MissionPlaceResult = {
  runId: string
  hostCount: number
  placements: { task_id: string; address: string; label: string }[]
  unplaced: { jobId: string; reason: string }[]
  notDispatchable: { address: string; label: string }[]
}

type MissionResults = {
  runId: string
  crossHost: boolean
  completed: number
  failed: number
  pending: string[]
  jobs: { jobId: string; address: string; status: string | null }[]
}

function taskList(flags: Flags): string[] {
  const tasks = getRequiredStringFlag(flags, 'tasks')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  if (tasks.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing --tasks <task_id,task_id>.')
  }
  return tasks
}

export function missionHandlers(deps: MissionHandlerDeps): Record<string, CommandHandler> {
  return {
    'orchestration mission-place': async ({ flags, client, cwd, json }) => {
      const result = await deps.callMutation<MissionPlaceResult>(
        client,
        flags,
        'orchestration.missionPlace',
        {
          tasks: taskList(flags),
          run: getOptionalStringFlag(flags, 'run'),
          from: await deps.resolveCoordinatorTerminalHandle(flags, cwd, client)
        }
      )
      if (result.result.unplaced.length > 0) {
        process.exitCode = 1
      }
      printResult(result, json, (plan) =>
        [
          `Mission placed on ${plan.hostCount} host(s) in ${plan.runId}`,
          ...plan.placements.map((p) => `  ${p.task_id} -> ${p.label} (${p.address})`),
          ...plan.unplaced.map((u) => `  ${u.jobId}: ${u.reason}`)
        ].join('\n')
      )
    },
    'orchestration mission-results': async ({ flags, client, json }) => {
      const result = await client.call<MissionResults>('orchestration.missionResults', {
        run: getRequiredStringFlag(flags, 'run')
      })
      printResult(result, json, (r) =>
        [
          `${r.runId}: ${r.completed} completed, ${r.failed} failed, ${r.pending.length} pending; crossHost=${r.crossHost}`,
          ...r.jobs.map((j) => `  ${j.jobId} @ ${j.address}: ${j.status ?? 'unknown'}`)
        ].join('\n')
      )
    }
  }
}
