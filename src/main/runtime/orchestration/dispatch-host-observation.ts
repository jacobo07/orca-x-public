/** Turns the executor identity the dispatch path already resolves into a resource reading, or a refusal. */
import type { HostMemory } from '../../../shared/process-stats-types'
import type { DispatchObservationResult } from './dispatch-admission'
import type { WorkerTerminalHostScope } from './worker-terminal-process-liveness'

export async function observeDispatchHostResources(
  hostScope: WorkerTerminalHostScope | null | undefined,
  terminalHandle: string,
  collectHostMemory: () => Promise<HostMemory>,
  now: () => Date = () => new Date()
): Promise<DispatchObservationResult> {
  if (!hostScope) {
    return {
      kind: 'unobservable',
      cause: 'executor-unknown',
      detail: `no dispatch authority resolves which host runs ${terminalHandle}`
    }
  }

  if (hostScope.kind === 'ssh') {
    return {
      kind: 'unobservable',
      cause: 'executor-not-local',
      detail: `${terminalHandle} runs over ssh on ${hostScope.targetId}; this process can only read its own host`
    }
  }

  if (hostScope.kind === 'wsl') {
    // hostId is 'local' and the memory is not: a WSL2 distro runs in a VM with its own budget, so
    // the Windows reading OVERSTATES what the worker can have -- the fail-open direction.
    return {
      kind: 'unobservable',
      cause: 'executor-not-local',
      detail: `${terminalHandle} runs in WSL distro ${hostScope.distro}, whose memory budget is not this host's reading`
    }
  }

  let memory: HostMemory
  try {
    memory = await collectHostMemory()
  } catch (err) {
    return {
      kind: 'unavailable',
      detail: `reading host memory for ${terminalHandle} failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  return {
    kind: 'observed',
    observation: {
      availableMemoryBytes: memory.availableMemory,
      source: memory.availableMemorySource,
      observedAt: now().toISOString()
    }
  }
}
