import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { resolveSessionWriteScope } from './session-write-scope'

export function registerSessionHandlers(store: Store): void {
  // Why: hostId is an optional second arg so an older renderer that invokes
  // these channels without it keeps reading/writing the 'local' partition
  // exactly as before. Channel names stay stable.
  ipcMain.handle('session:get', (_event, hostId?: string | null) => {
    return store.getWorkspaceSession(hostId)
  })

  // Why the scope: the renderer publishes its whole store as one snapshot, so with two windows the
  // last writer wins and the second erases the first window's tabs. It is derived here from the
  // sending window's claim rather than sent over the wire — a renderer naming its own scope could
  // name someone else's worktrees, which is the erasure this prevents.
  ipcMain.handle('session:set', (event, args: WorkspaceSessionState, hostId?: string | null) => {
    store.setWorkspaceSession(args, hostId, resolveSessionWriteScope(event.sender.id))
  })

  ipcMain.handle('session:patch', (event, args: WorkspaceSessionPatch, hostId?: string | null) => {
    store.patchWorkspaceSession(args, hostId, resolveSessionWriteScope(event.sender.id))
  })

  ipcMain.handle('session:flush', () => {
    // Why: durable lifecycle RPCs must propagate disk failures instead of
    // returning success through Store.flush(), which intentionally only logs.
    store.flushOrThrow()
  })

  // Synchronous variant for the renderer's beforeunload handler.
  // sendSync blocks the renderer until this returns, guaranteeing the
  // data (including terminal scrollback buffers) is persisted to disk
  // before the window closes — regardless of before-quit ordering.
  ipcMain.on('session:set-sync', (event, args: WorkspaceSessionState, hostId?: string | null) => {
    // The shutdown checkpoint is the write most worth scoping: a closing window publishing an
    // unscoped snapshot is exactly how the survivor loses its projects.
    store.setWorkspaceSession(args, hostId, resolveSessionWriteScope(event.sender.id))
    store.flush()
    event.returnValue = true
  })

  ipcMain.on(
    'session:read-terminal-scrollback-sync',
    (event, args: { ref?: unknown } | undefined) => {
      event.returnValue =
        typeof args?.ref === 'string' ? store.readTerminalScrollbackSnapshot(args.ref) : null
    }
  )
}
