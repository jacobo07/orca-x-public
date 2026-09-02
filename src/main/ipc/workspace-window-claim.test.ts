/**
 * Who may claim a workspace, ask what to show, or open a window — answered from the sender.
 *
 * Every one of these handlers decides something about a window, and none of them takes a window id
 * from the wire. That is the whole boundary: a renderer can only ever act as itself, so there is no
 * argument a compromised or confused renderer could pass to act as another window. The cases below
 * exist to keep it that way, because the natural "convenience" refactor — accepting a windowId
 * parameter so a caller can name its target — would dissolve it without failing anything else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>()

vi.mock('electron', () => ({
  BrowserWindow: { fromId: () => null },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    }
  }
}))

vi.mock('../window/focus-existing-window', () => ({ safelyRevealWindow: vi.fn() }))

import { registerWorkspaceWindowClaimHandlers } from './workspace-window-claim'
import {
  claimWorkspaceForWindow,
  getWorkspaceWindowForWorktree,
  registerWorkspaceWindow,
  resetWorkspaceWindowRegistryForTest
} from '../window/workspace-window-registry'

const REPO = 'repo-1'
const WORKTREE_A = 'repo-1::/repos/one/main'
const WORKTREE_B = 'repo-1::/repos/one/feature'
const KNOWN_RENDERER = 11
const STRANGER = 99

function invoke(channel: string, senderId: number, args?: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler registered for ${channel}`)
  }
  return handler({ sender: { id: senderId } }, args)
}

describe('workspace window claim handlers', () => {
  beforeEach(() => {
    handlers.clear()
    resetWorkspaceWindowRegistryForTest()
  })

  it('refuses a claim from a renderer that is not a workspace window', () => {
    registerWorkspaceWindowClaimHandlers()
    registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: KNOWN_RENDERER })

    const result = invoke('window:claimWorkspace', STRANGER, {
      repoId: REPO,
      worktreeId: WORKTREE_A
    })

    expect(result).toEqual({ outcome: 'unknown-window' })
    expect(getWorkspaceWindowForWorktree(WORKTREE_A)).toBeNull()
  })

  it('claims for the sending window, with no window id on the wire', () => {
    registerWorkspaceWindowClaimHandlers()
    const record = registerWorkspaceWindow({
      browserWindowId: 1,
      rendererWebContentsId: KNOWN_RENDERER
    })

    const result = invoke('window:claimWorkspace', KNOWN_RENDERER, {
      repoId: REPO,
      worktreeId: WORKTREE_A
    })

    expect(result).toEqual({ outcome: 'claimed' })
    expect(getWorkspaceWindowForWorktree(WORKTREE_A)?.windowId).toBe(record.windowId)
  })

  it('refuses a worktree another window holds instead of transferring it', () => {
    registerWorkspaceWindowClaimHandlers()
    const first = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: 11 })
    registerWorkspaceWindow({ browserWindowId: 2, rendererWebContentsId: 22 })
    claimWorkspaceForWindow(first.windowId, { repoId: REPO, worktreeId: WORKTREE_A })

    const result = invoke('window:claimWorkspace', 22, { repoId: REPO, worktreeId: WORKTREE_A })

    expect(result).toEqual({ outcome: 'owned-by-another-window' })
    // A transfer would leave the previous owner rendering a project it no longer speaks for.
    expect(getWorkspaceWindowForWorktree(WORKTREE_A)?.windowId).toBe(first.windowId)
  })

  it('will not open a window for a renderer that is not one', () => {
    const openNewWindow = vi.fn()
    registerWorkspaceWindowClaimHandlers({ openNewWindow })
    registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: KNOWN_RENDERER })

    expect(invoke('window:create', STRANGER)).toBe(false)
    expect(openNewWindow).not.toHaveBeenCalled()

    expect(invoke('window:create', KNOWN_RENDERER)).toBe(true)
    expect(openNewWindow).toHaveBeenCalledTimes(1)
  })

  it('answers the startup binding from the asking window, not the saved session', () => {
    registerWorkspaceWindowClaimHandlers()
    const first = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: 11 })
    registerWorkspaceWindow({ browserWindowId: 2, rendererWebContentsId: 22 })
    claimWorkspaceForWindow(first.windowId, { repoId: REPO, worktreeId: WORKTREE_B })

    expect(invoke('window:getStartupBinding', 11)).toEqual({
      worktreeId: WORKTREE_B,
      restoreSession: true
    })
    // The later, unbound window starts on the launcher rather than restoring the first one's project.
    expect(invoke('window:getStartupBinding', 22)).toEqual({
      worktreeId: null,
      restoreSession: false
    })
  })

  it('re-records the topology when a binding changes, but not when a claim is refused', () => {
    const onTopologyChanged = vi.fn()
    registerWorkspaceWindowClaimHandlers({ onTopologyChanged })
    const first = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: 11 })
    registerWorkspaceWindow({ browserWindowId: 2, rendererWebContentsId: 22 })

    invoke('window:claimWorkspace', 11, { repoId: REPO, worktreeId: WORKTREE_A })
    expect(onTopologyChanged).toHaveBeenCalledTimes(1)

    // A refusal changed nothing, so recording it would rewrite the file for no reason.
    invoke('window:claimWorkspace', 22, { repoId: REPO, worktreeId: WORKTREE_A })
    expect(onTopologyChanged).toHaveBeenCalledTimes(1)

    invoke('window:releaseWorkspace', 11)
    expect(onTopologyChanged).toHaveBeenCalledTimes(2)
    expect(getWorkspaceWindowForWorktree(WORKTREE_A)).toBeNull()
    expect(first.binding).toBeNull()
  })
})
