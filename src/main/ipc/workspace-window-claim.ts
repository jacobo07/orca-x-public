import { BrowserWindow, ipcMain } from 'electron'
import type {
  WorkspaceWindowClaimRequest,
  WorkspaceWindowClaimResult
} from '../../shared/workspace-window-claim'
import {
  claimWorkspaceForWindow,
  getWorkspaceWindow,
  getWorkspaceWindowForRenderer,
  releaseWorkspaceForWindow
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
export function registerWorkspaceWindowClaimHandlers(): void {
  ipcMain.removeHandler('window:claimWorkspace')
  ipcMain.removeHandler('window:releaseWorkspace')

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
    return {
      outcome: result.outcome === 'already-owned-by-this-window' ? 'already-owned' : 'claimed'
    }
  })

  ipcMain.handle('window:releaseWorkspace', (event): void => {
    const requester = getWorkspaceWindowForRenderer(event.sender.id)
    if (requester) {
      releaseWorkspaceForWindow(requester.windowId)
    }
  })
}
