import { parseExecutionHostId } from '../../shared/execution-host'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { HostMemory } from '../../shared/process-stats-types'
import type { WakeAdmissionResult } from '../../shared/desk-continuity-read-types'
import {
  decideDispatchAdmission,
  type DispatchObservationResult
} from '../runtime/orchestration/dispatch-admission'
import { observeDispatchHostResources } from '../runtime/orchestration/dispatch-host-observation'
import type { WorkerTerminalHostScope } from '../runtime/orchestration/worker-terminal-process-liveness'

/**
 * PROVISIONAL (Owner, 2026-09-28): a host free-memory floor, not a per-session cost. No per-wake cost
 * had been measured when it was set; replace it with one once the wake memory curve exists.
 */
export const PROVISIONAL_WAKE_FLOOR_BYTES = 4 * 1000 ** 3

export type WakeAdmissionDeps = {
  /** Main's own path for a workspace key; the caller never supplies one. Null when unknown. */
  workspacePath: (key: string, hostId: string) => string | null
  collectHostMemory: () => Promise<HostMemory>
  now: () => Date
}

function parseRequest(value: unknown): { hostId: string; workspaceKey: string } | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { hostId, workspaceKey } = value as Record<string, unknown>
  if (typeof hostId !== 'string' || typeof workspaceKey !== 'string') {
    return null
  }
  if (workspaceKey.length === 0 || workspaceKey.length > 1024) {
    return null
  }
  return { hostId, workspaceKey }
}

function executorScope(
  hostId: string,
  path: string | null
): WorkerTerminalHostScope | 'not-local' | null {
  const host = parseExecutionHostId(hostId)
  if (!host) {
    return null
  }
  if (host.kind === 'ssh') {
    return { kind: 'ssh', targetId: host.targetId }
  }
  if (host.kind === 'runtime') {
    return 'not-local'
  }
  const wsl = path ? parseWslUncPath(path) : null
  return wsl
    ? { kind: 'wsl', hostId: 'local', distro: wsl.distro }
    : { kind: 'local', hostId: 'local' }
}

/**
 * May one more session wake on this workspace's host now? One reading per ask, judged against the
 * floor; nothing is reserved, so a resume-all asks again before every wake.
 */
export async function decideWakeAdmission(
  request: unknown,
  deps: WakeAdmissionDeps
): Promise<WakeAdmissionResult> {
  const parsed = parseRequest(request)
  if (!parsed) {
    return { verdict: 'refused', reason: 'invalid-request', detail: 'not a wake request' }
  }
  const scope = executorScope(parsed.hostId, deps.workspacePath(parsed.workspaceKey, parsed.hostId))
  if (scope === null) {
    return {
      verdict: 'refused',
      reason: 'invalid-request',
      detail: `unknown host ${parsed.hostId}`
    }
  }
  const label = `workspace ${parsed.workspaceKey}`
  const observation: DispatchObservationResult =
    scope === 'not-local'
      ? {
          kind: 'unobservable',
          cause: 'executor-not-local',
          detail: `${label} runs on ${parsed.hostId}; this process can only read its own host`
        }
      : await observeDispatchHostResources(scope, label, deps.collectHostMemory, deps.now)
  const admission = decideDispatchAdmission({
    parse: {
      kind: 'declared',
      requirement: { minAvailableMemoryBytes: PROVISIONAL_WAKE_FLOOR_BYTES },
      strippedSpec: ''
    },
    observation,
    now: deps.now()
  })
  if (admission.verdict === 'refused') {
    return { verdict: 'refused', reason: admission.reason, detail: admission.detail }
  }
  return {
    verdict: 'admitted',
    availableMemoryBytes: admission.envelope.observation?.availableMemoryBytes ?? null,
    floorBytes: PROVISIONAL_WAKE_FLOOR_BYTES
  }
}
