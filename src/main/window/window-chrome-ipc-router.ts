import { ipcMain } from 'electron'
import type { MenuPopupRequest, MenuTopLevelItem } from '../../shared/app-menu-strip'

/**
 * Routes the window-chrome IPC channels to the window whose renderer sent them.
 *
 * These channels used to be registered inside createMainWindow, once per window, closing over that
 * window. That shape has three defects the moment a second window exists, and all three are silent
 * except the first:
 *
 * - `ipcMain.handle` throws on a channel that already has a handler, so constructing a second
 *   window aborted midway — after its BrowserWindow existed and after it had already taken the
 *   trusted-renderer id from the first.
 * - `ipcMain.on` does not replace, it appends. Both windows' listeners fired for every event, so
 *   minimize in one minimized both, and one renderer's close confirmation closed the other.
 * - Teardown removed the channels outright, so the first window to close unbound the survivor's
 *   title-bar controls.
 *
 * Registration happens once for the process and stays; a window binds and unbinds its own entry.
 * An event from a sender with no entry is a no-op rather than an error — a renderer can outlive its
 * unbind during teardown, and dropping a late minimize is cheaper than throwing into IPC.
 */
export type WindowChromeHandlers = {
  syncTrafficLights: (zoomFactor: number) => void
  minimize: () => void
  toggleMaximize: () => void
  requestClose: () => void
  popupMenu: (request?: MenuPopupRequest) => void
  menuTopLevelItems: () => MenuTopLevelItem[]
  isMaximized: () => boolean
  confirmClose: () => void
}

const handlersByWebContentsId = new Map<number, WindowChromeHandlers>()
let registered = false

function handlersFor(event: {
  sender?: { id?: number }
}): WindowChromeHandlers | undefined {
  // Why the optional reads: an IPC frame reaching main without an identifiable sender must be
  // dropped, not thrown from — an exception here escapes into Electron's event dispatch.
  const senderId = event?.sender?.id
  return typeof senderId === 'number' ? handlersByWebContentsId.get(senderId) : undefined
}

function registerOnce(): void {
  if (registered) {
    return
  }
  registered = true
  ipcMain.on('ui:sync-traffic-lights', (event, zoomFactor: number) => {
    handlersFor(event)?.syncTrafficLights(zoomFactor)
  })
  ipcMain.on('window:minimize', (event) => {
    handlersFor(event)?.minimize()
  })
  ipcMain.on('window:maximize', (event) => {
    handlersFor(event)?.toggleMaximize()
  })
  ipcMain.on('window:request-close', (event) => {
    handlersFor(event)?.requestClose()
  })
  ipcMain.on('menu:popup', (event, request?: MenuPopupRequest) => {
    handlersFor(event)?.popupMenu(request)
  })
  ipcMain.on('window:confirm-close', (event) => {
    handlersFor(event)?.confirmClose()
  })
  ipcMain.handle('menu:topLevelItems', (event) => handlersFor(event)?.menuTopLevelItems() ?? [])
  ipcMain.handle('window:isMaximized', (event) => handlersFor(event)?.isMaximized() ?? false)
}

/** Bind one window's chrome handlers to its renderer. Returns the unbind for its `closed` handler. */
export function bindWindowChromeIpc(
  rendererWebContentsId: number,
  handlers: WindowChromeHandlers
): () => void {
  registerOnce()
  handlersByWebContentsId.set(rendererWebContentsId, handlers)
  return () => {
    // Why the identity check: a recreated window can reuse a webContents id, and a stale unbind
    // must not remove the live window's entry.
    if (handlersByWebContentsId.get(rendererWebContentsId) === handlers) {
      handlersByWebContentsId.delete(rendererWebContentsId)
    }
  }
}

export function resetWindowChromeIpcRouterForTest(): void {
  handlersByWebContentsId.clear()
  registered = false
}
