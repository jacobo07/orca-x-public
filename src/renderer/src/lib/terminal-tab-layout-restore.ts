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
 * `marked` became dormant; `already-dormant` kept its own marker; `running` has a session the host
 * lists as live, so restoring it is a reattach; `not-found` is not a row of this workspace.
 */
export type LayoutRestoreOutcome = {
  tabId: string
  outcome: 'marked' | 'already-dormant' | 'running' | 'not-found'
}

/**
 * Layout-only restore: every requested row of the workspace is made dormant so activation mounts
 * nothing for it, and waking stays a separate, explicit open.
 *
 * "Running" is the host's answer, never the store's: hydration refills `ptyIdsByTabId` and
 * `tab.ptyId` from the saved session, so a remembered id looks exactly like a bound one. `null`
 * means the host could not be asked; the caller's own judgement then stands.
 */
export function applyLayoutRestore(
  tabsByWorktree: Record<string, TerminalTab[]>,
  ptyIdsByTabId: Record<string, string[]>,
  worktreeId: string,
  requests: readonly LayoutRestoreRequest[],
  liveSessionIds: ReadonlySet<string> | null
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
    const sessionIds = [tab.ptyId, ...(ptyIdsByTabId[tab.id] ?? [])]
    if (liveSessionIds && sessionIds.some((id) => id && liveSessionIds.has(id))) {
      return { tabId: tab.id, outcome: 'running' }
    }
    if (tab.dormancy) {
      return { tabId: tab.id, outcome: 'already-dormant' }
    }
    nextTabs ??= [...tabs]
    nextTabs[index] = {
      ...tab,
      dormancy: terminalTabDormancy('layout-restore', request.resumeContinuity)
    }
    return { tabId: tab.id, outcome: 'marked' }
  })
  return {
    tabsByWorktree: nextTabs ? { ...tabsByWorktree, [worktreeId]: nextTabs } : tabsByWorktree,
    outcomes
  }
}
