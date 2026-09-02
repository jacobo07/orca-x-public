import { webContents, type BrowserWindow, type WebContents } from 'electron'

/**
 * The renderers that are Orca application windows.
 *
 * Trust used to be three separate scalars — one for UI IPC, one for browser IPC, one for clipboard
 * IPC — each stamped with "the" main window's renderer id on every window construction. That is
 * last-writer-wins: opening a second window silently de-trusted the first, and because the
 * per-window cleanup is id-guarded, closing the second did not give the trust back. The first
 * window kept rendering while its clipboard, browser and UI channels quietly stopped answering.
 *
 * Membership is therefore a set. Registration order is kept because some main→renderer sends still
 * address a single app window (the dashboard pop-out publishes into one); those resolve to the most
 * recently registered renderer that is still alive, so the answer degrades to a live window instead
 * of to null. That single-target notion is a narrower question than trust and is expected to become
 * per-surface ownership once windows carry a project binding — it is deliberately not solved here.
 */
const rendererIdsInRegistrationOrder: number[] = []

export function registerAppWindowRenderer(webContentsId: number): void {
  unregisterAppWindowRenderer(webContentsId)
  rendererIdsInRegistrationOrder.push(webContentsId)
}

export function unregisterAppWindowRenderer(webContentsId: number): void {
  const index = rendererIdsInRegistrationOrder.indexOf(webContentsId)
  if (index !== -1) {
    rendererIdsInRegistrationOrder.splice(index, 1)
  }
}

export function isAppWindowRenderer(webContentsId: number): boolean {
  return rendererIdsInRegistrationOrder.includes(webContentsId)
}

/** True while no app window has registered, so callers can keep their pre-registration fallback. */
export function hasNoAppWindowRenderer(): boolean {
  return rendererIdsInRegistrationOrder.length === 0
}

/**
 * The app window a single-target send should address: the most recently registered one that is
 * still alive, skipping `excludedWebContentsId` so an origin window is not sent its own event.
 *
 * Returns the renderer rather than its id so resolving costs one lookup per candidate — exact
 * targeting exists to avoid waking the retained browser and utility windows, and looking the same
 * id up twice would spend part of what that saves.
 */
export function getPrimaryAppWindowRenderer(excludedWebContentsId?: number): WebContents | null {
  for (let index = rendererIdsInRegistrationOrder.length - 1; index >= 0; index -= 1) {
    const rendererId = rendererIdsInRegistrationOrder[index]
    if (rendererId === excludedWebContentsId) {
      continue
    }
    const renderer = webContents.fromId(rendererId)
    if (renderer && !renderer.isDestroyed()) {
      return renderer
    }
  }
  return null
}

/**
 * Send to every registered app window that is still alive.
 *
 * Global-registry events — the repo list, the worktree list — describe state that every window
 * renders, so addressing one window leaves the others showing something that is no longer true.
 * `excludeWebContentsId` skips a renderer the caller has already sent to directly.
 */
export function broadcastToAppWindowRenderers(
  channel: string,
  args: readonly unknown[] = [],
  excludeWebContentsId?: number
): void {
  // Why a copy: a send into a renderer that is tearing down can unregister it, and mutating the
  // list while iterating it would skip the window after the one that left.
  for (const rendererId of rendererIdsInRegistrationOrder.slice()) {
    if (rendererId === excludeWebContentsId) {
      continue
    }
    const renderer = webContents.fromId(rendererId)
    if (renderer && !renderer.isDestroyed()) {
      renderer.send(channel, ...args)
    }
  }
}

/**
 * Send to the window that caused the change, and to every other app window.
 *
 * State a window mutated is still global state: the window that acted needs the event, and so does
 * every window that did not. The origin is addressed directly rather than through the registry
 * because a window can act before it has registered — during construction, or in a test — and
 * relying on membership alone would silently drop its own event.
 */
export function sendToOriginAndAllAppWindowRenderers(
  origin: BrowserWindow | null,
  channel: string,
  args: readonly unknown[] = []
): void {
  const originIsAlive = origin !== null && !origin.isDestroyed()
  if (originIsAlive) {
    origin.webContents.send(channel, ...args)
  }
  broadcastToAppWindowRenderers(channel, args, originIsAlive ? origin.webContents.id : undefined)
}

export function resetAppWindowRendererRegistryForTest(): void {
  rendererIdsInRegistrationOrder.length = 0
}
