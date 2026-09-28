import {
  terminalTabDormancy,
  type DormantResumeContinuity,
  type TerminalTab
} from '../../../shared/terminal-tab-types'

/** One row the caller judged not running on its host, with the continuity verdict it was shown. */
export type LayoutRestoreRequest = {
  tabId: string
  resumeContinuity: DormantResumeContinuity
}

/**
 * `marked` became dormant; `already-dormant` kept its own marker; `bound` holds a PTY in this window,
 * so it is running here and restoring it is a reattach; `not-found` is not a row of this workspace.
 */
export type LayoutRestoreOutcome = {
  tabId: string
  outcome: 'marked' | 'already-dormant' | 'bound' | 'not-found'
}

/**
 * Layout-only restore: every requested row of the workspace is made dormant so activation mounts
 * nothing for it, and waking stays a separate, explicit open. Judged against the state it is applied
 * to, so a row that bound a PTY after the caller looked is left running rather than marked.
 */
export function applyLayoutRestore(
  tabsByWorktree: Record<string, TerminalTab[]>,
  ptyIdsByTabId: Record<string, string[]>,
  worktreeId: string,
  requests: readonly LayoutRestoreRequest[]
): { tabsByWorktree: Record<string, TerminalTab[]>; outcomes: LayoutRestoreOutcome[] } {
  const tabs = tabsByWorktree[worktreeId] ?? []
  const indexById = new Map(tabs.map((tab, index) => [tab.id, index] as const))
  let nextTabs: TerminalTab[] | null = null
  const outcomes = requests.map((request): LayoutRestoreOutcome => {
    const index = indexById.get(request.tabId)
    if (index === undefined) {
      return { tabId: request.tabId, outcome: 'not-found' }
    }
    const tab = tabs[index]!
    if ((ptyIdsByTabId[tab.id] ?? []).length > 0) {
      return { tabId: tab.id, outcome: 'bound' }
    }
    if (tab.dormancy) {
      return { tabId: tab.id, outcome: 'already-dormant' }
    }
    nextTabs ??= [...tabs]
    // Why drop the open request: a stale request on a newly dormant row would mount it at once.
    const { dormantOpenRequested: _requested, ...rest } = tab
    void _requested
    nextTabs[index] = {
      ...rest,
      dormancy: terminalTabDormancy('layout-restore', request.resumeContinuity)
    }
    return { tabId: tab.id, outcome: 'marked' }
  })
  return {
    tabsByWorktree: nextTabs ? { ...tabsByWorktree, [worktreeId]: nextTabs } : tabsByWorktree,
    outcomes
  }
}
