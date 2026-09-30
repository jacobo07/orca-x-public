import { BrowserWindow, dialog, ipcMain } from 'electron'

import type { BacklogChatGptImportAnswer } from '../../shared/backlog-harvest-report'
import type { BacklogHarvestRunner } from '../backlog/harvest/backlog-harvest-runner'
import { getBacklogHarvestRunner } from './backlog-host-wiring'

// Desktop only: headless serve never runs registerCoreHandlers, and there is no RPC twin (R-05).

const OPEN_OPTIONS: Electron.OpenDialogOptions = {
  properties: ['openFile'],
  filters: [{ name: 'ChatGPT export', extensions: ['json'] }]
}

/** The picked path lives only in this function's locals; the answer carries counts and codes. */
export async function handleBacklogChatGptImport(
  event: Electron.IpcMainInvokeEvent,
  runner: Pick<BacklogHarvestRunner, 'importChatGptExport'>
): Promise<BacklogChatGptImportAnswer> {
  const senderWindow =
    BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
  // Read off `dialog` at call time so the e2e seam's replacement takes effect.
  const result = senderWindow
    ? await dialog.showOpenDialog(senderWindow, OPEN_OPTIONS)
    : await dialog.showOpenDialog(OPEN_OPTIONS)
  const picked = result.canceled ? undefined : result.filePaths[0]
  if (picked === undefined) {
    return { outcome: 'cancelled' }
  }
  const report = await runner.importChatGptExport(picked)
  switch (report.outcome) {
    case 'completed':
      return { outcome: 'imported', report }
    case 'refused':
      return { outcome: 'refused', report }
    case 'failed':
      return { outcome: 'failed', report }
  }
}

export function registerBacklogChatGptImportHandler(): void {
  // No renderer argument is read: the renderer cannot name a file.
  ipcMain.handle('backlog:importChatGptExport', (event) =>
    handleBacklogChatGptImport(event, getBacklogHarvestRunner())
  )
}
