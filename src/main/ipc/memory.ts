import { ipcMain } from 'electron'
import type { MemorySnapshot, ProcessPresenceProbe } from '../../shared/process-stats-types'
import type { Store } from '../persistence'
import { collectMemorySnapshot } from '../memory/collector'
import { probeProcessPresence } from '../memory/process-presence-probe'

export function registerMemoryHandlers(store: Store): void {
  ipcMain.handle('memory:getSnapshot', (): Promise<MemorySnapshot> => collectMemorySnapshot(store))
  ipcMain.handle(
    'memory:probeProcessPresence',
    (_event, pids: unknown): Promise<ProcessPresenceProbe> =>
      probeProcessPresence(
        Array.isArray(pids) ? pids.filter((pid): pid is number => Number.isInteger(pid)) : []
      )
  )
}
