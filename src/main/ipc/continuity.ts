import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { DeskReadResult, PanePreviewResult } from '../../shared/desk-continuity-read-types'
import { readDesk } from '../continuity/desk-read'
import { renderPanePreview } from '../continuity/pane-preview'
import { HistoryReader } from '../daemon/history-reader'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { getHistoryDir } from '../daemon/daemon-init'
import { getLocalPtyProvider } from './pty'

export function registerContinuityHandlers(store: Store): void {
  ipcMain.removeHandler('continuity:readDesk')
  ipcMain.handle(
    'continuity:readDesk',
    (): Promise<DeskReadResult> =>
      readDesk({
        store,
        listLocalSessionIds: async () =>
          (await getLocalPtyProvider().listProcesses()).map((session) => session.id),
        now: Date.now
      })
  )

  const history = new HistoryReader(getHistoryDir())
  // Why one at a time: previews share the daemon's cold-restore replay lane with pane restores.
  let previewChain: Promise<unknown> = Promise.resolve()
  ipcMain.removeHandler('continuity:renderPanePreview')
  ipcMain.handle('continuity:renderPanePreview', (_event, request: unknown) => {
    const next: Promise<PanePreviewResult> = previewChain.then(() =>
      renderPanePreview(request, {
        getWorkspaceSession: (hostId) => store.getWorkspaceSession(hostId),
        readScrollbackRef: (ref) => store.readTerminalScrollbackSnapshot(ref),
        // Why ignoreCleanEnd: a parked session ended cleanly and its recorded screen is still the one to show.
        detectHistory: (sessionId) =>
          history.detectColdRestoreState(sessionId, { ignoreCleanEnd: true }),
        createEmulator: (size) => new HeadlessEmulator({ ...size, scrollback: 0 })
      })
    )
    previewChain = next.catch(() => undefined)
    return next
  })
}
