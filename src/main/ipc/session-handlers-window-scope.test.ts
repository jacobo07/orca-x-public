// The link the scope had been missing: session:set/patch/set-sync never carried one, so the merge
// machinery in shared/workspace-session-owner-scope.ts was unreachable from the renderer and every
// publish kept whole-workspace authority.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, onMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: onMock }
}))

import { registerSessionHandlers } from './session'
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

type StoreDouble = {
  setWorkspaceSession: ReturnType<typeof vi.fn>
  patchWorkspaceSession: ReturnType<typeof vi.fn>
  getWorkspaceSession: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  flushOrThrow: ReturnType<typeof vi.fn>
  readTerminalScrollbackSnapshot: ReturnType<typeof vi.fn>
}

function makeStore(): StoreDouble {
  return {
    setWorkspaceSession: vi.fn(),
    patchWorkspaceSession: vi.fn(),
    getWorkspaceSession: vi.fn(() => ({})),
    flush: vi.fn(),
    flushOrThrow: vi.fn(),
    readTerminalScrollbackSnapshot: vi.fn()
  }
}

function invokeHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = handleMock.mock.calls.find(([name]) => name === channel)?.[1]
  if (!handler) {
    throw new Error(`no handler registered for ${channel}`)
  }
  return handler as (...args: unknown[]) => unknown
}

function sendHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = onMock.mock.calls.find(([name]) => name === channel)?.[1]
  if (!handler) {
    throw new Error(`no listener registered for ${channel}`)
  }
  return handler as (...args: unknown[]) => unknown
}

function senderEvent(webContentsId: number): unknown {
  return { sender: { id: webContentsId }, returnValue: undefined }
}

describe('session handlers derive their write scope from the sending window', () => {
  beforeEach(() => {
    handleMock.mockReset()
    onMock.mockReset()
    resetWorkspaceWindowRegistryForTest()
  })

  it('passes no scope while one window is open, keeping today’s behaviour exactly', () => {
    const store = makeStore()
    const only = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: RENDERER_A })
    claimWorkspaceForWindow(only.windowId, { repoId: REPO, worktreeId: WORKTREE_A })
    registerSessionHandlers(store as never)

    invokeHandler('session:set')(senderEvent(RENDERER_A), { tabsByWorktree: {} }, 'local')

    expect(store.setWorkspaceSession).toHaveBeenCalledWith({ tabsByWorktree: {} }, 'local', {})
  })

  it('scopes a set to the sending window’s workspace once a second window exists', () => {
    const store = makeStore()
    const first = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: RENDERER_A })
    const second = registerWorkspaceWindow({
      browserWindowId: 2,
      rendererWebContentsId: RENDERER_B
    })
    claimWorkspaceForWindow(first.windowId, { repoId: REPO, worktreeId: WORKTREE_A })
    claimWorkspaceForWindow(second.windowId, { repoId: REPO, worktreeId: WORKTREE_B })
    registerSessionHandlers(store as never)

    invokeHandler('session:set')(senderEvent(RENDERER_B), { tabsByWorktree: {} }, 'local')

    expect(store.setWorkspaceSession).toHaveBeenCalledWith({ tabsByWorktree: {} }, 'local', {
      ownedWorktreeIds: [WORKTREE_B]
    })
  })

  it('scopes a patch the same way', () => {
    const store = makeStore()
    const first = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: RENDERER_A })
    registerWorkspaceWindow({ browserWindowId: 2, rendererWebContentsId: RENDERER_B })
    claimWorkspaceForWindow(first.windowId, { repoId: REPO, worktreeId: WORKTREE_A })
    registerSessionHandlers(store as never)

    invokeHandler('session:patch')(senderEvent(RENDERER_A), { activeTabId: 'tab-1' }, 'local')

    expect(store.patchWorkspaceSession).toHaveBeenCalledWith({ activeTabId: 'tab-1' }, 'local', {
      ownedWorktreeIds: [WORKTREE_A]
    })
  })

  it('scopes the synchronous shutdown checkpoint, which is the write most worth scoping', () => {
    const store = makeStore()
    const first = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: RENDERER_A })
    registerWorkspaceWindow({ browserWindowId: 2, rendererWebContentsId: RENDERER_B })
    claimWorkspaceForWindow(first.windowId, { repoId: REPO, worktreeId: WORKTREE_A })
    registerSessionHandlers(store as never)

    const event = senderEvent(RENDERER_A) as { returnValue: unknown }
    sendHandler('session:set-sync')(event, { tabsByWorktree: {} }, 'local')

    // A closing window publishing an unscoped snapshot is exactly how the survivor loses its projects.
    expect(store.setWorkspaceSession).toHaveBeenCalledWith({ tabsByWorktree: {} }, 'local', {
      ownedWorktreeIds: [WORKTREE_A]
    })
    expect(store.flush).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toBe(true)
  })
})
