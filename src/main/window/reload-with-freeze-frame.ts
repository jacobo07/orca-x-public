import { BrowserWindow, type WebContents } from 'electron'
import { captureReloadFreezeFrame, type ReloadFreezeFrameSource } from './reload-freeze-frame'

/**
 * The one boundary every deliberate window reload crosses.
 *
 * Why a single authority: the reload is reachable from the View menu, the force-reload accelerator
 * and the renderer's own `app:reload` request. A freeze frame captured beside one of them would
 * leave the other two flashing, and the third is in a file nobody editing the menu would open.
 *
 * Deliberately NOT used by the renderer-crash recovery reload: there is no live frame to capture
 * there, and a capture of a dead renderer would paint a blank rectangle over the recovery.
 */
export type ReloadRequest = {
  ignoreCache: boolean
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
}

function toFreezeFrameSource(webContents: WebContents): ReloadFreezeFrameSource {
  return {
    id: webContents.id,
    capturePage: () => webContents.capturePage(),
    getContentSize: () => {
      const [width, height] = BrowserWindow.fromWebContents(webContents)?.getContentSize() ?? []
      return typeof width === 'number' && typeof height === 'number' ? { width, height } : null
    }
  }
}

/**
 * Capture the current frame, then reload.
 *
 * The capture is awaited because a frame taken after `reload()` is a frame of the blank document it
 * produced — but it is bounded and fail-open inside `captureReloadFreezeFrame`, so a stalled or
 * broken capture costs the backdrop, never the reload.
 */
export async function reloadWithFreezeFrame(
  webContents: WebContents,
  request: ReloadRequest
): Promise<void> {
  if (webContents.isDestroyed()) {
    return
  }

  await captureReloadFreezeFrame(toFreezeFrameSource(webContents))

  // Re-checked after the await: the window can close while the capture is in flight, and reloading
  // destroyed webContents throws.
  if (webContents.isDestroyed()) {
    return
  }

  request.onBeforeReload?.({ ignoreCache: request.ignoreCache, webContentsId: webContents.id })

  if (request.ignoreCache) {
    webContents.reloadIgnoringCache()
    return
  }
  webContents.reload()
}
