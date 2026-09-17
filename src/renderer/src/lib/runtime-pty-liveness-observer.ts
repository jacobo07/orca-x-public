import type { AppState } from '@/store/types'
import {
  getRuntimeLivenessTargetWorktrees,
  type SampledRuntimePtyLiveness
} from './agent-hibernation-planner-snapshot'
import { sampleRuntimePtyLiveness } from './runtime-pty-liveness-sample'

/**
 * Display-time runtime liveness: one sample per request, delivered only while it
 * is the newest request and has not been cancelled. Evidence for what to show —
 * the sleep itself re-samples before it acts.
 */
export type RuntimePtyLivenessObserver = {
  /** Returns the request's cancel; a cancelled or superseded answer is dropped. */
  request: (state: AppState) => () => void
}

export function createRuntimePtyLivenessObserver(
  onSample: (sample: SampledRuntimePtyLiveness) => void,
  sample: (state: AppState) => Promise<SampledRuntimePtyLiveness> = sampleRuntimePtyLiveness
): RuntimePtyLivenessObserver {
  let generation = 0
  return {
    request(state) {
      const requested = ++generation
      let cancelled = false
      void sample(state).then((result) => {
        if (!cancelled && requested === generation) {
          onSample(result)
        }
      })
      return () => {
        cancelled = true
      }
    }
  }
}

/**
 * What a sample was taken for: each runtime worktree, its host, and the PTYs its
 * panes are bound to. A change means the held sample may not describe them, so
 * it is the only reason to ask again — never the clock or the memory poll.
 */
export function getRuntimeLivenessSampleKey(state: AppState): string {
  const parts: string[] = []
  for (const [worktreeId, environmentId] of getRuntimeLivenessTargetWorktrees(state)) {
    const ptyIds = new Set<string>()
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      for (const ptyId of state.ptyIdsByTabId[tab.id] ?? []) {
        ptyIds.add(ptyId)
      }
      for (const ptyId of Object.values(
        state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      )) {
        if (ptyId) {
          ptyIds.add(ptyId)
        }
      }
    }
    parts.push(`${worktreeId}@${environmentId}:${[...ptyIds].sort().join(',')}`)
  }
  return parts.sort().join('|')
}
