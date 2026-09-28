import type { SleepingAgentSessionRecord } from './agent-session-resume'
import type { DormantResumeContinuity, TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { readDormantResumeContinuity } from './dormant-resume-continuity'
import { parsePaneKey } from './stable-pane-id'

/**
 * A resumable agent whose tab is gone: no pane or layout to restore, so only an explicit Resume
 * brings it back, as a new tab. Kept visible rather than dropped with the tab.
 */
export type DeskOrphanSession = {
  paneKey: string
  agent: string
  capturedAt: number
  resume: DormantResumeContinuity
}

function recordTabId(paneKey: string, tabId: string | undefined): string | null {
  return tabId ?? parsePaneKey(paneKey)?.tabId ?? null
}

/** A record the desk can place. A malformed one is skipped, never allowed to sink its workspace. */
function placeableRecords(state: WorkspaceSessionState): SleepingAgentSessionRecord[] {
  return Object.values(state.sleepingAgentSessionsByPaneKey ?? {}).filter(
    (record) =>
      typeof record?.paneKey === 'string' &&
      typeof record.worktreeId === 'string' &&
      record.worktreeId.length > 0
  )
}

/** Sleeping records of this workspace whose tab no longer exists, oldest first. */
export function orphanSessionsOf(
  state: WorkspaceSessionState,
  key: string,
  tabs: readonly TerminalTab[]
): DeskOrphanSession[] {
  const tabIds = new Set(tabs.map((tab) => tab.id))
  return placeableRecords(state)
    .filter((record) => {
      const tabId = recordTabId(record.paneKey, record.tabId)
      return record.worktreeId === key && (tabId === null || !tabIds.has(tabId))
    })
    .sort((a, b) => a.capturedAt - b.capturedAt)
    .map((record) => ({
      paneKey: record.paneKey,
      agent: record.agent,
      capturedAt: record.capturedAt,
      // Why unconfirmed: a record is a handle, and nothing re-checked the conversation today.
      resume: readDormantResumeContinuity(undefined, true)
    }))
}

/** Workspaces with a saved tab or, failing that, a resumable agent record. */
export function workspaceKeysWithContent(state: WorkspaceSessionState): string[] {
  const keys = new Set(
    Object.entries(state.tabsByWorktree)
      .filter(([, tabs]) => tabs.length > 0)
      .map(([key]) => key)
  )
  for (const record of placeableRecords(state)) {
    keys.add(record.worktreeId)
  }
  return [...keys]
}
