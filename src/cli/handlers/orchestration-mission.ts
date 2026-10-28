import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { formatRejectedHostLines, type RejectedHostReasons } from '../fleet-placement-format'
import { printResult } from '../format'
import { nodeRequirementFromFlags } from '../node-requirement-flags'
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
  // Why: absent from an older host; the text then stays exactly what it was.
  rejectedByJob?: { jobId: string; rejected: RejectedHostReasons[] }[]
  // Why: the host states hydration; the CLI marks it and never infers it.
  locality?: { taskId: string; hostKey: string; hydrated: boolean }[]
}

function unplacedLines(plan: MissionPlaceResult): string[] {
  const byJob = plan.rejectedByJob
  return plan.unplaced.flatMap((u) => {
    const line = `  ${u.jobId}: ${u.reason}`
    if (!byJob) {
      return [line]
    }
    const rejected = byJob.find((entry) => entry.jobId === u.jobId)?.rejected ?? []
    return [line, ...formatRejectedHostLines(rejected)]
  })
}

function notDispatchableLines(plan: MissionPlaceResult): string[] {
  // Why: only the detailed (new-host) output explains refusals, so an old host's text is unchanged.
  if (!plan.rejectedByJob || plan.unplaced.length === 0) {
    return []
  }
  return plan.notDispatchable.map((h) => `  not dispatchable: ${h.label} (${h.address})`)
}

function placementLines(plan: MissionPlaceResult): string[] {
  const hydrated = new Set(
    (plan.locality ?? []).filter((entry) => entry.hydrated === true).map((entry) => entry.taskId)
  )
  return plan.placements.map(
    (p) =>
      `  ${p.task_id} -> ${p.label} (${p.address})${hydrated.has(p.task_id) ? ' [project already there]' : ''}`
  )
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
      // Why: parse the need before resolving a terminal so a bad value reaches no RPC at all.
      const requirement = nodeRequirementFromFlags(flags, { includeMemory: true })
      const result = await deps.callMutation<MissionPlaceResult>(
        client,
        flags,
        'orchestration.missionPlace',
        {
          tasks: taskList(flags),
          run: getOptionalStringFlag(flags, 'run'),
          from: await deps.resolveCoordinatorTerminalHandle(flags, cwd, client),
          ...(requirement ? { requirement } : {})
        }
      )
      if (result.result.unplaced.length > 0) {
        process.exitCode = 1
      }
      printResult(result, json, (plan) =>
        [
          `Mission placed on ${plan.hostCount} host(s) in ${plan.runId}`,
          ...placementLines(plan),
          ...unplacedLines(plan),
          ...notDispatchableLines(plan)
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
