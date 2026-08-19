import { describe, it, expect } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import type { SleepingAgentSessionRecord } from './agent-session-resume'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { mergeOwnerScopedSessionPatch, ownsOneOfWorktrees } from './workspace-session-owner-scope'

const sleepingAgent = (paneKey: string, worktreeId: string): SleepingAgentSessionRecord => ({
  paneKey,
  worktreeId,
  agent: 'claude',
  providerSession: { key: 'session_id', id: `session-${paneKey}` },
  prompt: '',
  state: 'working',
  capturedAt: 1,
  updatedAt: 1
})

const OWNED = 'repo-a::/a'
const OTHER = 'repo-b::/b'

const terminalTab = (worktreeId: string, id: string) => ({
  id,
  ptyId: `pty-${id}`,
  worktreeId,
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
})

const sessionWithBothProjects = (): WorkspaceSessionState => ({
  ...getDefaultWorkspaceSession(),
  tabsByWorktree: {
    [OWNED]: [terminalTab(OWNED, 'tab-owned')],
    [OTHER]: [terminalTab(OTHER, 'tab-other')]
  }
})

const mergeAsOwnerOfA = (
  current: WorkspaceSessionState,
  patch: Partial<WorkspaceSessionState>
): WorkspaceSessionState =>
  mergeOwnerScopedSessionPatch(current, patch, ownsOneOfWorktrees([OWNED]))

// The point of scoping by the shared field-ownership classification is that
// fields keyed by something other than a worktree id are scoped too. A merge
// that only understood worktree-keyed records would still erase these.
describe('mergeOwnerScopedSessionPatch', () => {
  it('retains a tab-keyed entry belonging to another worktree', () => {
    // Arrange
    const current: WorkspaceSessionState = {
      ...sessionWithBothProjects(),
      remoteSessionIdsByTabId: { 'tab-owned': 'remote-owned', 'tab-other': 'remote-other' }
    }

    // Act — the owner republishes only its own tab's mapping.
    const next = mergeAsOwnerOfA(current, {
      remoteSessionIdsByTabId: { 'tab-owned': 'remote-owned-2' }
    })

    // Assert
    expect(next.remoteSessionIdsByTabId).toEqual({
      'tab-owned': 'remote-owned-2',
      'tab-other': 'remote-other'
    })
  })

  it('retains a pane-keyed entry belonging to another worktree', () => {
    // Arrange
    const current: WorkspaceSessionState = {
      ...sessionWithBothProjects(),
      terminalPtyIncarnationsByPaneKey: {
        'tab-owned:leaf-1': 'inc-owned',
        'tab-other:leaf-1': 'inc-other'
      }
    }

    // Act
    const next = mergeAsOwnerOfA(current, {
      terminalPtyIncarnationsByPaneKey: { 'tab-owned:leaf-1': 'inc-owned-2' }
    })

    // Assert
    expect(next.terminalPtyIncarnationsByPaneKey).toEqual({
      'tab-owned:leaf-1': 'inc-owned-2',
      'tab-other:leaf-1': 'inc-other'
    })
  })

  it('retains a sleeping agent record belonging to another worktree', () => {
    // Arrange
    const current: WorkspaceSessionState = {
      ...sessionWithBothProjects(),
      sleepingAgentSessionsByPaneKey: {
        'pane-owned': sleepingAgent('pane-owned', OWNED),
        'pane-other': sleepingAgent('pane-other', OTHER)
      }
    }

    // Act
    const next = mergeAsOwnerOfA(current, { sleepingAgentSessionsByPaneKey: {} })

    // Assert — the owner dropped its own record; the other window keeps its resume evidence.
    expect(Object.keys(next.sleepingAgentSessionsByPaneKey ?? {})).toEqual(['pane-other'])
  })

  it('keeps an entry it cannot attribute to any worktree', () => {
    // Arrange — an orphan mapping with no owning tab in the session.
    const current: WorkspaceSessionState = {
      ...sessionWithBothProjects(),
      remoteSessionIdsByTabId: { 'tab-vanished': 'remote-orphan' }
    }

    // Act
    const next = mergeAsOwnerOfA(current, { remoteSessionIdsByTabId: {} })

    // Assert — deleting on someone else's behalf is worse than keeping an orphan.
    expect(next.remoteSessionIdsByTabId).toEqual({ 'tab-vanished': 'remote-orphan' })
  })

  it('unions a worktree array without dropping another owner entry', () => {
    // Arrange
    const current: WorkspaceSessionState = {
      ...sessionWithBothProjects(),
      activeWorktreeIdsOnShutdown: [OWNED, OTHER]
    }

    // Act — the owner shuts down with nothing active.
    const next = mergeAsOwnerOfA(current, { activeWorktreeIdsOnShutdown: [] })

    // Assert
    expect(next.activeWorktreeIdsOnShutdown).toEqual([OTHER])
  })

  it('leaves fields the patch does not mention untouched', () => {
    // Arrange
    const current = sessionWithBothProjects()

    // Act
    const next = mergeAsOwnerOfA(current, { activeTabId: 'tab-owned' })

    // Assert
    expect(next.tabsByWorktree).toEqual(current.tabsByWorktree)
    expect(next.activeTabId).toBe('tab-owned')
  })
})
