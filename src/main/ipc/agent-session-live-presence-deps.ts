import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { agentHookServer } from '../agent-hooks/server'
import type { LiveAgentSessionPresenceReaderDeps } from '../agent-hooks/live-agent-session-presence-reader'
import { indexPersistedPaneKeyPtyIds } from '../agent-hooks/restored-subagent-liveness-sweep'
import { getPtyIdForPaneKey } from './pty'

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
