import { BrowserWindow } from 'electron'
import { reloadWithFreezeFrame } from '../window/reload-with-freeze-frame'
import { reloadWindowGracefully } from '../window/reload-window-gracefully'

export type MenuReloadHooks = {
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
  /** Reload left the window as it was: its renderer refused to prepare, or did not answer. */
  onReloadNotPerformed?: (args: { outcome: 'refused' | 'timeout'; webContentsId: number }) => void
}

/** View > Reload and Force Reload, for the window whose menu ran them. */
export function runMenuReload(
  ignoreCache: boolean,
  invokingWindow: Electron.BaseWindow | undefined,
  { onBeforeReload, onReloadNotPerformed }: MenuReloadHooks
): void {
  // Why the invoking window: with two windows open, focus can belong to the other one. Focus is
  // only the fallback for a click Electron did not attribute; a destroyed invoker reloads nothing.
  let webContents: Electron.WebContents | undefined
  if (invokingWindow && 'webContents' in invokingWindow) {
    if (invokingWindow.isDestroyed()) {
      return
    }
    webContents = (invokingWindow as BrowserWindow).webContents
  } else {
    webContents = BrowserWindow.getFocusedWindow()?.webContents
  }
  if (!webContents) {
    return
  }

  if (ignoreCache) {
    // Routed through the shared authority so the menu, the accelerator and the renderer's own
    // `app:reload` all capture the freeze frame; a menu-local reload would flash.
    void reloadWithFreezeFrame(webContents, { ignoreCache, onBeforeReload })
    return
  }
  // Why prepared: an unprepared reload is vetoed by any dirty editor and skips the durable
  // checkpoint. A window that refuses or does not answer is left untouched and the user is told.
  const webContentsId = webContents.id
  void reloadWindowGracefully(webContents, { onBeforeReload }).then((result) => {
    if (result === 'refused' || result === 'timeout') {
      onReloadNotPerformed?.({ outcome: result, webContentsId })
    }
  })
}
