import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { agentHookServer } from '../agent-hooks/server'
import type { LiveAgentSessionPresenceReaderDeps } from '../agent-hooks/live-agent-session-presence-reader'
import { indexPersistedPaneKeyPtyIds } from '../agent-hooks/restored-subagent-liveness-sweep'
import { LiveSessionMaterializationReservations } from '../agent-hooks/live-session-materialization-reservation'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { getPtyIdForPaneKey, hasPtyForTabId, registerPaneKeyTeardownListener } from './pty'

/** Binds the presence reader to the canonical owners: the hook server (every window),
 *  the runtime's claim signer, the pane→PTY map and the routed liveness probe. */
export function createLiveAgentSessionPresenceDeps(
  store: Pick<Store, 'getWorkspaceSession'>,
  runtime: Pick<OrcaRuntimeService, 'resolveAgentSessionPresenceKey' | 'probePtyLiveness'>
): LiveAgentSessionPresenceReaderDeps {
  let persistedPtyIds: Map<string, string> | null = null
  return {
    listHookRows: () => agentHookServer.getStatusSnapshot(),
    isObservedInCurrentRuntime: (paneKey) =>
      agentHookServer.isPaneStatusObservedInCurrentRuntime(paneKey),
    resolveIdentityKey: (args) => runtime.resolveAgentSessionPresenceKey(args),
    getBoundPtyIdForPaneKey: getPtyIdForPaneKey,
    getPersistedPtyIdForPaneKey: (paneKey) => {
      // Why: one read per request; the persisted layout is only a fallback for unattached panes.
      persistedPtyIds ??= indexPersistedPaneKeyPtyIds(
        store.getWorkspaceSession().terminalLayoutsByTabId ?? {}
      )
      return persistedPtyIds.get(paneKey)
    },
    probePtyLiveness: (ptyId) => runtime.probePtyLiveness(ptyId)
  }
}

let reservations: LiveSessionMaterializationReservations | null = null

/** The one materialization authority for this process, shared by every window. */
export function getLiveSessionMaterializationReservations(): LiveSessionMaterializationReservations {
  if (!reservations) {
    const created = new LiveSessionMaterializationReservations({
      now: Date.now,
      hasBoundPty: hasPtyForTabId
    })
    // Why: a runtime that exits before reporting ends the attempt; the next one may start.
    registerPaneKeyTeardownListener((paneKey) => {
      const tabId = parsePaneKey(paneKey)?.tabId
      if (tabId) {
        created.releaseForTab(tabId)
      }
    })
    reservations = created
  }
  return reservations
}
