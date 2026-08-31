import {
  hasNoAppWindowRenderer,
  isAppWindowRenderer,
  registerAppWindowRenderer
} from './app-window-renderer-registry'

export function setTrustedBrowserRendererWebContentsId(webContentsId: number | null): void {
  // Why membership rather than a scalar: this was last-writer-wins, so a second app window
  // de-trusted the first one's browser IPC for the rest of its life. A null id supplies no window.
  if (webContentsId !== null) {
    registerAppWindowRenderer(webContentsId)
  }
}

export function isTrustedBrowserRenderer(sender: Electron.WebContents): boolean {
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

  return senderUrl.startsWith('file://')
}
