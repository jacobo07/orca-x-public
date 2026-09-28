import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { DeskReadResult } from '../../shared/desk-continuity-read-types'
import { readDesk } from '../continuity/desk-read'
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
}
