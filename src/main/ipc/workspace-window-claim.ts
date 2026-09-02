import { BrowserWindow, ipcMain } from 'electron'
import type {
  WorkspaceWindowClaimRequest,
  WorkspaceWindowClaimResult,
  WorkspaceWindowStartup
} from '../../shared/workspace-window-claim'
import {
  claimWorkspaceForWindow,
  getWorkspaceWindow,
  getWorkspaceWindowForRenderer,
  releaseWorkspaceForWindow,
  resolveWorkspaceWindowStartup
} from '../window/workspace-window-registry'
import { safelyRevealWindow } from '../window/focus-existing-window'

function isClaimRequest(value: unknown): value is WorkspaceWindowClaimRequest {
  const candidate = value as WorkspaceWindowClaimRequest | undefined
  return typeof candidate?.repoId === 'string' && typeof candidate?.worktreeId === 'string'
}

/**
 * Registered once for the process and routed by sender, so a window can only ever claim on its own
 * behalf — a renderer cannot name another window, and nothing here trusts a window id from the wire.
 */
export function registerWorkspaceWindowClaimHandlers(
  options: {
    openNewWindow?: () => void
    /** A binding change is a topology change: which project each window owns is most of what a relaunch restores. */
    onTopologyChanged?: () => void
  } = {}
): void {
  ipcMain.removeHandler('window:claimWorkspace')
  ipcMain.removeHandler('window:releaseWorkspace')
  ipcMain.removeHandler('window:getStartupBinding')
  ipcMain.removeHandler('window:create')

  ipcMain.handle('window:getStartupBinding', (event): WorkspaceWindowStartup => {
    return resolveWorkspaceWindowStartup(event.sender.id)
  })

  ipcMain.handle('window:create', (event): boolean => {
    // Why the sender must already be a window: opening a project window is a window's request, and
    // an unrecognised renderer asking for one has no context to open it from.
    if (!getWorkspaceWindowForRenderer(event.sender.id) || !options.openNewWindow) {
      return false
    }
    options.openNewWindow()
    return true
  })

  ipcMain.handle('window:claimWorkspace', (event, args: unknown): WorkspaceWindowClaimResult => {
    const requester = getWorkspaceWindowForRenderer(event.sender.id)
    if (!requester || !isClaimRequest(args)) {
      return { outcome: 'unknown-window' }
    }
    const result = claimWorkspaceForWindow(requester.windowId, {
      repoId: args.repoId,
      worktreeId: args.worktreeId
    })
    if (result.outcome === 'owned-by-another-window') {
      // Raise the owner here rather than leaving it to the caller: the requesting renderer cannot
      // focus a window it does not know about, and a refusal with nothing on screen reads as the
      // open having silently failed.
      const owner = getWorkspaceWindow(result.ownerWindowId)
      const ownerWindow = owner ? BrowserWindow.fromId(owner.browserWindowId) : null
      if (ownerWindow && !ownerWindow.isDestroyed()) {
        safelyRevealWindow(ownerWindow)
      }
      return { outcome: 'owned-by-another-window' }
    }
    if (result.outcome === 'claimed') {
      options.onTopologyChanged?.()
    }
    return {
      outcome: result.outcome === 'already-owned-by-this-window' ? 'already-owned' : 'claimed'
    }
  })

  ipcMain.handle('window:releaseWorkspace', (event): void => {
    const requester = getWorkspaceWindowForRenderer(event.sender.id)
    if (requester) {
      releaseWorkspaceForWindow(requester.windowId)
      options.onTopologyChanged?.()
    }
  })
}
