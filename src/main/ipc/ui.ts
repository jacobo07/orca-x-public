import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { Store } from '../persistence'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import { isFeatureInteractionId } from '../../shared/feature-interactions'
import {
  getPrimaryAppWindowRenderer,
  hasNoAppWindowRenderer,
  isAppWindowRenderer,
  registerAppWindowRenderer,
  unregisterAppWindowRenderer
} from './app-window-renderer-registry'

// A null id means no window was supplied, so there is nothing to admit. It no longer clears trust:
// with membership a window leaves through clearTrustedUIRendererWebContentsId, by its own id.
export function setTrustedUIRendererWebContentsId(webContentsId: number | null): void {
  if (webContentsId !== null) {
    registerAppWindowRenderer(webContentsId)
  }
}

export function clearTrustedUIRendererWebContentsId(webContentsId: number): void {
  unregisterAppWindowRenderer(webContentsId)
}

export function sendToTrustedUIRenderer(
  channel: string,
  payload: unknown,
  excludedWebContentsId?: number
): void {
  const renderer = getTrustedUIRendererWebContents(excludedWebContentsId)
  renderer?.send(channel, payload)
}

export function getTrustedUIRendererWebContents(
  excludedWebContentsId?: number
): WebContents | null {
  // Why: exact targeting avoids waking retained browser/utility windows that cannot consume app UI events.
  return getPrimaryAppWindowRenderer(excludedWebContentsId)
}

export function getTrustedUIRendererWindow(): BrowserWindow | null {
  const renderer = getTrustedUIRendererWebContents()
  return renderer ? BrowserWindow.fromWebContents(renderer) : null
}

export function registerUIHandlers(
  store: Store,
  options: { isDashboardPopoutRenderer?: (sender: WebContents) => boolean } = {}
): void {
  // Why: UI view-state is shared between the desktop renderer and mobile (ui.set
  // RPC). Broadcast every change so the desktop re-hydrates when mobile (or
  // another window) updates it — bi-directional sync, mirroring settings:changed.
  store.onUIChanged((ui) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('ui:stateChanged', ui)
      }
    }
  })

  ipcMain.handle('ui:get', () => {
    return store.getUI()
  })

  ipcMain.handle('ui:set', (_event, args: Partial<PersistedUIState>) => {
    store.updateUI(args)
  })

  ipcMain.handle('ui:recordFeatureInteraction', (_event, id: unknown) => {
    if (!isFeatureInteractionId(id)) {
      throw new Error('invalid_feature_interaction_id')
    }
    return store.recordFeatureInteraction(id)
  })

  ipcMain.removeAllListeners('ui:performNativePaste')
  ipcMain.on('ui:performNativePaste', (event, options?: { mode?: unknown }) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return
    }
    // Why: coordinated renderer paste falls back here only after no Orca owner
    // claims the app-menu action; paste back into the requesting window only.
    const webContents = BrowserWindow.fromWebContents(event.sender)?.webContents
    if (options?.mode === 'paste-and-match-style') {
      webContents?.pasteAndMatchStyle()
      return
    }
    webContents?.paste()
  })

  ipcMain.removeAllListeners('ui:performNativeSelectionAction')
  ipcMain.on('ui:performNativeSelectionAction', (event, action: unknown) => {
    if (
      !isTrustedUIRenderer(event.sender) &&
      options.isDashboardPopoutRenderer?.(event.sender) !== true
    ) {
      return
    }
    const target = BrowserWindow.fromWebContents(event.sender)?.webContents
    if (action === 'copy') {
      target?.copy()
    } else if (action === 'select-all') {
      target?.selectAll()
    }
  })
}

export function isTrustedUIRenderer(sender: WebContents): boolean {
  if (sender.isDestroyed() || sender.getType() !== 'window') {
    return false
  }
  if (!hasNoAppWindowRenderer()) {
    return isAppWindowRenderer(sender.id)
  }

  const senderUrl = sender.getURL()
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      return new URL(senderUrl).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    } catch {
      return false
    }
  }

  // Why: packaged fallback must be tied to the created main window id, not any
  // file:// document that can obtain this IPC channel.
  return false
}
