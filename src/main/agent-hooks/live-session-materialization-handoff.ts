import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { LiveAgentSessionPresenceReaderDeps } from './live-agent-session-presence-reader'
import type { LiveSessionMaterializationReservations } from './live-session-materialization-reservation'

export type MaterializationHandoffEvent = AgentHookEventPayload & {
  restoredUnconfirmed?: true
  retainedForLiveness?: true
}

/**
 * Ends a reservation as soon as its session reports live in the tab it was reserved for.
 * Why eager: the lazy handoff runs only on a later reservation read, and a shell tab stays
 * bound after its agent exits, so the reservation would outlive the agent and refuse the
 * user's next resume of that same session until the bound ceiling.
 */
export async function handOffMaterializationOnLiveReport(
  deps: Pick<LiveAgentSessionPresenceReaderDeps, 'resolveIdentityKey'>,
  reservations: LiveSessionMaterializationReservations,
  event: MaterializationHandoffEvent
): Promise<boolean> {
  const tabId = parsePaneKey(event.paneKey)?.tabId
  const agent = event.payload.agentType
  if (
    !tabId ||
    event.isReplay ||
    event.restoredUnconfirmed ||
    event.retainedForLiveness ||
    !event.providerSession ||
    !event.worktreeId ||
    !isTuiAgent(agent) ||
    !reservations.hasEntryForTab(tabId)
  ) {
    return false
  }
  const key = await deps
    .resolveIdentityKey({
      worktreeId: event.worktreeId,
      agent,
      providerSession: event.providerSession
    })
    .catch(() => null)
  return key ? reservations.releaseKeyForTab(key, tabId) : false
}

export function installMaterializationHandoff(args: {
  subscribe: (listener: (event: MaterializationHandoffEvent) => void) => () => void
  resolveDeps: () => Pick<LiveAgentSessionPresenceReaderDeps, 'resolveIdentityKey'>
  resolveReservations: () => LiveSessionMaterializationReservations
}): () => void {
  return args.subscribe((event) => {
    try {
      void handOffMaterializationOnLiveReport(
        args.resolveDeps(),
        args.resolveReservations(),
        event
      ).catch(() => {})
    } catch {
      // Why: before the runtime exists no reservation can have been granted either.
    }
  })
}
