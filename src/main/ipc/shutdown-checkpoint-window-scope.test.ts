// The scope guard sits on session:set/patch/set-sync, and the write a closing window actually makes
// is none of them: beforeunload goes through app:stage-before-unload-sync, which reaches
// stageWorkspaceSessionBeforeUnload with no scope at all. session-handlers-window-scope.test.ts has
// a case named for "the synchronous shutdown checkpoint" that drives session:set-sync — the right
// property asserted against the wrong channel, which is why this stayed green while a closing window
// published every worktree it held, including the ones another window owns.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, onMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: onMock }
}))

import { registerRendererShutdownCheckpointHandler } from './renderer-shutdown-checkpoint'
import {
  claimWorkspaceForWindow,
  registerWorkspaceWindow,
  resetWorkspaceWindowRegistryForTest
} from '../window/workspace-window-registry'

const REPO = 'repo-1'
const WORKTREE_A = 'repo-1::/repos/one/main'
const WORKTREE_B = 'repo-1::/repos/one/feature'
const RENDERER_A = 11
const RENDERER_B = 22

function makeStore() {
  return {
    stageWorkspaceSessionBeforeUnload: vi.fn(),
    updateUI: vi.fn(),
    flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
  }
}

function sendHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = onMock.mock.calls.find(([name]) => name === channel)?.[1]
  if (!handler) {
    throw new Error(`no listener registered for ${channel}`)
  }
  return handler as (...args: unknown[]) => unknown
}

function senderEvent(webContentsId: number): { sender: { id: number }; returnValue: unknown } {
  return { sender: { id: webContentsId }, returnValue: undefined }
}

/** A snapshot naming both windows' worktrees — what a renderer that has visited both actually holds. */
function sessionNamingBothWorktrees() {
  return {
    tabsByWorktree: {
      [WORKTREE_A]: [{ id: 'tab-a' }],
      [WORKTREE_B]: [{ id: 'tab-b-stale' }]
    }
  }
}

describe('the shutdown checkpoint speaks only for the closing window’s own workspace', () => {
  beforeEach(() => {
    handleMock.mockReset()
    onMock.mockReset()
    resetWorkspaceWindowRegistryForTest()
  })

  it('scopes the staged session to the sending window once a second window exists', () => {
    const store = makeStore()
    const first = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: RENDERER_A })
    const second = registerWorkspaceWindow({
      browserWindowId: 2,
      rendererWebContentsId: RENDERER_B
    })
    claimWorkspaceForWindow(first.windowId, { repoId: REPO, worktreeId: WORKTREE_A })
    claimWorkspaceForWindow(second.windowId, { repoId: REPO, worktreeId: WORKTREE_B })
    registerRendererShutdownCheckpointHandler(store as never)

    sendHandler('app:stage-before-unload-sync')(senderEvent(RENDERER_A), {
      sessions: [{ state: sessionNamingBothWorktrees(), hostId: 'local' }],
      ui: {}
    })

    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledWith(
      sessionNamingBothWorktrees(),
      'local',
      { ownedWorktreeIds: [WORKTREE_A] }
    )
  })

  // The control: one window legitimately holds every project it has visited, so scoping its
  // shutdown write to the one project it currently shows would stop the rest from being written.
  it('passes no scope while one window is open, keeping today’s behaviour exactly', () => {
    const store = makeStore()
    const only = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: RENDERER_A })
    claimWorkspaceForWindow(only.windowId, { repoId: REPO, worktreeId: WORKTREE_A })
    registerRendererShutdownCheckpointHandler(store as never)

    sendHandler('app:stage-before-unload-sync')(senderEvent(RENDERER_A), {
      sessions: [{ state: sessionNamingBothWorktrees(), hostId: 'local' }],
      ui: {}
    })

    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledWith(
      sessionNamingBothWorktrees(),
      'local',
      {}
    )
  })

  // An unrecognised sender owns the empty set, so its write becomes a no-op rather than an erasure.
  it('lets an unrecognised sender speak for nothing while other windows exist', () => {
    const store = makeStore()
    const first = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: RENDERER_A })
    registerWorkspaceWindow({ browserWindowId: 2, rendererWebContentsId: RENDERER_B })
    claimWorkspaceForWindow(first.windowId, { repoId: REPO, worktreeId: WORKTREE_A })
    registerRendererShutdownCheckpointHandler(store as never)

    sendHandler('app:stage-before-unload-sync')(senderEvent(999), {
      sessions: [{ state: sessionNamingBothWorktrees(), hostId: 'local' }],
      ui: {}
    })

    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledWith(
      sessionNamingBothWorktrees(),
      'local',
      { ownedWorktreeIds: [] }
    )
  })
})
