import { BrowserWindow } from 'electron'
import { listWorkspaceWindows } from '../window/workspace-window-registry'

/**
 * "Sleep Everything and Exit": the window starts the park so it can say why Orca stayed open.
 * Refuses silently with no window, which is also what the coordinator would answer.
 */
export function requestParkFromMenu(): void {
  const focused = BrowserWindow.getFocusedWindow()
  const windows = listWorkspaceWindows()
    .map((record) => BrowserWindow.fromId(record.browserWindowId))
    .filter((window): window is BrowserWindow => Boolean(window && !window.isDestroyed()))
  const target = windows.find((window) => window === focused) ?? windows[0]
  target?.webContents.send('durableExit:parkFromMenu')
}
