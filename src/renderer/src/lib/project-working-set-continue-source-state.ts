import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import type { GitStatusResult } from '../../../shared/git-status-types'

/**
 * Whether the workspace being continued has uncommitted work. Continue here restores tabs on another
 * host's checkout; uncommitted changes stay behind, so it is offered only on a proven-clean source.
 */
export type ContinueSourceState = 'clean' | 'uncommitted-changes' | 'unknown'

export function continueSourceStateFromStatus(status: GitStatusResult | null): ContinueSourceState {
  if (status === null) {
    return 'unknown'
  }
  // Why didHitLimit: a capped listing still proves changes exist, even if entries were cut.
  return status.entries.length > 0 || status.didHitLimit === true ? 'uncommitted-changes' : 'clean'
}

/** A fresh read at the moment of continuing; a cached panel status is not evidence of clean. */
export async function readContinueSourceState(
  sourceWorktreeId: string
): Promise<ContinueSourceState> {
  const state = useAppStore.getState()
  const worktree = Object.values(state.worktreesByRepo)
    .flat()
    .find((candidate) => candidate.id === sourceWorktreeId)
  if (!worktree) {
    return 'unknown'
  }
  try {
    const status = await getRuntimeGitStatus({
      settings: getSettingsForWorktreeRuntimeOwner(
        { repos: state.repos, settings: state.settings, worktreesByRepo: state.worktreesByRepo },
        worktree.id
      ),
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      connectionId: getConnectionId(worktree.id) ?? undefined
    })
    return continueSourceStateFromStatus(status as GitStatusResult)
  } catch (error) {
    // Fail closed: an unreadable status refuses the continue (the caller words it as unknown).
    console.warn('[continue-here] source status unreadable', error)
    return 'unknown'
  }
}
