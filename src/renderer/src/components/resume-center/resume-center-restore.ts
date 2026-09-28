import { useAppStore } from '@/store'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import type { LayoutRestoreOutcome, LayoutRestoreRequest } from '@/lib/terminal-tab-layout-restore'
import type { DeskTab } from '../../../../shared/desk-continuity-projection'
import type { WorkspaceRowModel } from './resume-center-model'

export type LayoutRestoreResult = {
  activated: boolean
  outcomes: LayoutRestoreOutcome[]
}

/**
 * Rows this restore makes dormant: every row the host did not list as running. `unknown` is included
 * on purpose — a dormant row only waits for an explicit open, while a mounted one may spawn.
 */
export function layoutRestoreRequests(tabs: readonly DeskTab[]): LayoutRestoreRequest[] {
  return tabs
    .filter((tab) => tab.residency !== 'warm')
    .map((tab) => ({ tabId: tab.tabId, resumeContinuity: tab.resume }))
}

/**
 * The Resume Center's Open: bring the workspace and its rows back without starting anything. Rows
 * are made dormant BEFORE activation, because activation is what mounts them.
 */
export function restoreWorkspaceLayoutOnly(row: WorkspaceRowModel): LayoutRestoreResult {
  const outcomes = useAppStore
    .getState()
    .restoreTerminalTabsLayoutOnly(row.key, layoutRestoreRequests(row.tabs))
  const activated = row.key.startsWith('folder:')
    ? activateAndRevealFolderWorkspace(row.key.slice('folder:'.length), {
        executionHostId: row.hostId,
        wake: false
      })
    : activateAndRevealWorktree(
        row.key.startsWith('worktree:') ? row.key.slice('worktree:'.length) : row.key,
        { executionHostId: row.hostId, wake: false }
      )
  return { activated: activated !== false, outcomes }
}
