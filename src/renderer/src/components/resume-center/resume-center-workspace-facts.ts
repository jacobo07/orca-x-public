import { resolveWorktreeBranchLabel } from '@/lib/worktree-default-display-name'
import type { Worktree } from '../../../../shared/worktree/types'
import { worktreeIdOfKey, type DeskTab } from '../../../../shared/desk-continuity-projection'
import type { ResumeCenterModel, WorkspaceRowModel } from './resume-center-model'

/** Inline thumbnails per session row; the rest stay one click away in the expanded row. */
export const INLINE_PANE_THUMBS = 3

/** The branch the workspace's worktree records now; null for folders, unknown worktrees and detached heads. */
export function workspaceBranch(
  worktreesByRepo: Record<string, readonly Worktree[]>,
  key: string
): string | null {
  const id = worktreeIdOfKey(key)
  if (id === null) {
    return null
  }
  for (const worktrees of Object.values(worktreesByRepo)) {
    const match = worktrees.find((worktree) => worktree.id === id)
    if (match) {
      return resolveWorktreeBranchLabel(match).trim() || null
    }
  }
  return null
}

/** Tabs that recorded the agent they launched; a plain shell is not counted as one. */
export function workspaceAgentCount(row: Pick<WorkspaceRowModel, 'tabs'>): number {
  return row.tabs.filter((tab) => tab.agent !== null).length
}

export function tabMonogram(tab: Pick<DeskTab, 'title'>): string {
  const letter = [...tab.title.trim()][0]
  return letter ? letter.toLocaleUpperCase() : '?'
}

/** Windows are claimed only when the desk recorded them: unrecorded is not zero. */
export function greetingWindowCount(
  model: Pick<ResumeCenterModel, 'windowsRecorded' | 'windowCount'>
): number | null {
  return model.windowsRecorded ? model.windowCount : null
}
