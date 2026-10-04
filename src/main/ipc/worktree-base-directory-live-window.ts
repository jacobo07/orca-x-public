import type { BrowserWindow } from 'electron'
import { survivingAppWindow } from '../window/surviving-app-window'

/**
 * The window this watch should answer to, re-pointed at a survivor when its own has gone.
 *
 * One watcher serves every window — they are keyed by path, not by window — so the window a watch
 * captured was only ever "who to answer to". Closing it left a survivor holding a live watcher
 * whose every event was dropped on the way out.
 */
export function liveWindowForWatch(watch: { mainWindow: BrowserWindow }): BrowserWindow | null {
  if (!watch.mainWindow.isDestroyed()) {
    return watch.mainWindow
  }
  const survivor = survivingAppWindow()
  if (survivor) {
    // Adopt it, so the visibility poller and later events follow the same window this one does.
    watch.mainWindow = survivor
  }
  return survivor
}
