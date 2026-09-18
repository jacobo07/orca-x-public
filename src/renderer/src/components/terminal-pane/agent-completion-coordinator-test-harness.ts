import { afterEach, beforeEach, vi } from 'vitest'
import { resetAgentCompletionCoordinatorIdentitiesForTest } from './agent-completion-coordinator'
import { resetAgentProcessBackstopForTests } from './agent-process-backstop'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

export const HOOK_DONE_QUIET_MS = 1_500

export async function flushAsyncTicks(count = 4): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

export function processResult(
  foregroundProcess: string | null,
  hasChildProcesses = foregroundProcess !== null
): RuntimeTerminalProcessInspection {
  return { foregroundProcess, hasChildProcesses }
}

export function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve
  })
  return { promise, resolve: resolveDeferred }
}

// Fake timers + pinned jitter, plus the cross-coordinator identity/queue reset.
export function useAgentCompletionCoordinatorLifecycle(): void {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    resetAgentProcessBackstopForTests()
    resetAgentCompletionCoordinatorIdentitiesForTest()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
}
