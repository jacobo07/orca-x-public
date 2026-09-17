import type { AppState } from '@/store/types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../shared/runtime-types'
import {
  getRuntimeLivenessTargetWorktrees,
  type SampledRuntimePtyLiveness
} from './agent-hibernation-planner-snapshot'

/**
 * The one reader of runtime PTY liveness for agent sleep: the displayed plan, the
 * automatic tick and the pre-shutdown re-check all sample through here.
 *
 * Read-only. Worktrees that could not be answered are simply absent, which the
 * planner reads as unknown — never as dead.
 */

export const RUNTIME_PTY_LIVENESS_BUDGET_MS = 10_000

const tailByEnvironmentId = new Map<string, Promise<void>>()

function settlesBefore(previous: Promise<void>, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()))
    void previous.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

// Why: each fresh listing supersedes the host's previous inventory refresh, so
// overlapping requests to one host fail all but the last. Serialize per host,
// but never wait past this sample's budget for a listing that has not returned.
function inEnvironmentQueue<T>(
  environmentId: string,
  deadline: number,
  run: () => Promise<T>
): Promise<T | null> {
  const previous = tailByEnvironmentId.get(environmentId) ?? Promise.resolve()
  const result = settlesBefore(previous, deadline).then((ready) => (ready ? run() : null))
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  tailByEnvironmentId.set(environmentId, tail)
  void tail.then(() => {
    if (tailByEnvironmentId.get(environmentId) === tail) {
      tailByEnvironmentId.delete(environmentId)
    }
  })
  return result
}

export function resetRuntimePtyLivenessQueueForTests(): void {
  tailByEnvironmentId.clear()
}

function getTypedRuntimePtyId(terminal: RuntimeTerminalSummary): string | null {
  if (terminal.ptyId) {
    return terminal.ptyId
  }
  if (terminal.tabId.startsWith('pty:') && terminal.tabId === terminal.leafId) {
    return terminal.tabId.slice('pty:'.length) || null
  }
  return null
}

type WorktreeLiveness = { ptyIds: string[]; hostPtyIdByRuntimeId: Record<string, string> }

async function listLivePtyIds(
  environmentId: string,
  worktreeId: string,
  deadline: number
): Promise<WorktreeLiveness | null> {
  const timeoutMs = deadline - Date.now()
  if (timeoutMs <= 0) {
    return null
  }
  try {
    const result = await callRuntimeRpc<RuntimeTerminalListResult>(
      { kind: 'environment', environmentId },
      'terminal.list',
      {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        limit: 10_000,
        requireFreshPtyLiveness: true,
        includeVisualLayouts: false
      },
      { timeoutMs }
    )
    if (result.truncated) {
      return null
    }
    const hostPtyIdByRuntimeId: Record<string, string> = {}
    for (const terminal of result.terminals) {
      if (!terminal.connected || terminal.worktreeId !== worktreeId) {
        continue
      }
      const ptyId = getTypedRuntimePtyId(terminal)
      if (!ptyId) {
        continue
      }
      hostPtyIdByRuntimeId[ptyId] = ptyId
      // Why: a paired client names its pane by terminal handle; exact stop needs the host PTY.
      if (terminal.handle) {
        hostPtyIdByRuntimeId[terminal.handle] = ptyId
      }
    }
    return { ptyIds: Object.keys(hostPtyIdByRuntimeId).sort(), hostPtyIdByRuntimeId }
  } catch {
    // Why: a failed listing proves nothing; omitting the worktree fails closed.
    return null
  }
}

export async function sampleRuntimePtyLiveness(
  state: AppState
): Promise<SampledRuntimePtyLiveness> {
  const worktreeIdsByEnvironmentId = new Map<string, string[]>()
  for (const [worktreeId, environmentId] of getRuntimeLivenessTargetWorktrees(state)) {
    const worktreeIds = worktreeIdsByEnvironmentId.get(environmentId) ?? []
    worktreeIds.push(worktreeId)
    worktreeIdsByEnvironmentId.set(environmentId, worktreeIds)
  }
  const sample: SampledRuntimePtyLiveness = {
    runtimeLivePtyIdsByWorktreeId: {},
    hostPtyIdByRuntimeIdByWorktreeId: {},
    environmentIdByWorktreeId: {}
  }
  // Why: one budget per host bounds a sample however many worktrees an unreachable host has.
  const deadline = Date.now() + RUNTIME_PTY_LIVENESS_BUDGET_MS
  await Promise.all(
    [...worktreeIdsByEnvironmentId].map(async ([environmentId, worktreeIds]) => {
      for (const worktreeId of worktreeIds) {
        const live = await inEnvironmentQueue(environmentId, deadline, () =>
          listLivePtyIds(environmentId, worktreeId, deadline)
        )
        if (live) {
          sample.runtimeLivePtyIdsByWorktreeId[worktreeId] = live.ptyIds
          sample.hostPtyIdByRuntimeIdByWorktreeId[worktreeId] = live.hostPtyIdByRuntimeId
          sample.environmentIdByWorktreeId[worktreeId] = environmentId
        }
      }
    })
  )
  return sample
}
