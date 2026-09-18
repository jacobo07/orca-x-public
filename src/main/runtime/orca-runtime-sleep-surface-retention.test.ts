import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'repo::/worktree'
const LIVE_REPO = {
  id: 'repo',
  path: '/worktree',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
} as const

function persistedSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: 'pty-1',
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf', leafId: 'leaf' },
        activeLeafId: 'leaf',
        expandedLeafId: null,
        ptyIdsByLeafId: { leaf: 'pty-1' }
      }
    }
  }
}

function makeRuntime() {
  let session = persistedSession()
  const setWorkspaceSession = vi.fn((next: WorkspaceSessionState) => {
    session = next
  })
  const runtime = new OrcaRuntimeService({
    getRepos: () => [LIVE_REPO],
    getWorkspaceSession: () => session,
    setWorkspaceSession,
    flushOrThrow: vi.fn()
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab',
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: 'leaf',
        layout: { type: 'leaf', leafId: 'leaf' }
      }
    ],
    leaves: [
      { tabId: 'tab', worktreeId: WORKTREE_ID, leafId: 'leaf', paneRuntimeId: 1, ptyId: 'pty-1' }
    ]
  })
  return {
    runtime,
    setWorkspaceSession,
    persistedTabIds: () => session.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id) ?? []
  }
}

// Why: Sleep kills a PTY and keeps its row. Treating that exit as a permanent one deleted the row
// from the host-authoritative session, so a slept workspace came back empty after a relaunch.
describe('OrcaRuntimeService surface retention through a sleep stop', () => {
  it('control: a plain exit retires the persisted surface', () => {
    const { runtime, persistedTabIds } = makeRuntime()

    runtime.onPtyExit('pty-1', 0)

    expect(persistedTabIds()).toEqual([])
  })

  it('keeps the persisted surface when the exit belongs to a stop that keeps history', () => {
    const { runtime, setWorkspaceSession, persistedTabIds } = makeRuntime()

    const release = runtime.retainSurfaceThroughPtyStop('pty-1')
    runtime.onPtyExit('pty-1', -1)
    release()

    expect(setWorkspaceSession).not.toHaveBeenCalled()
    expect(persistedTabIds()).toEqual(['tab'])
  })

  it('retires normally again once the stop has been released', () => {
    const { runtime, persistedTabIds } = makeRuntime()

    runtime.retainSurfaceThroughPtyStop('pty-1')()
    runtime.onPtyExit('pty-1', 0)

    expect(persistedTabIds()).toEqual([])
  })

  it('retains only the PTY that was stopped', () => {
    const { runtime, persistedTabIds } = makeRuntime()

    const release = runtime.retainSurfaceThroughPtyStop('pty-other')
    runtime.onPtyExit('pty-1', 0)
    release()

    expect(persistedTabIds()).toEqual([])
  })
})
