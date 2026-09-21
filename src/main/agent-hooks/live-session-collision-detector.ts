import {
  isResumableTuiAgent,
  type AgentProviderSessionMetadata
} from '../../shared/agent-session-resume'
import type { LiveAgentSessionPresence } from './live-agent-session-presence'
import type { LiveAgentSessionPresenceSubject } from './live-agent-session-presence-reader'

import type { LiveSessionCollisionNotice } from '../../shared/live-agent-session-presence-types'

export {
  LIVE_SESSION_COLLISION_CHANNEL,
  type LiveSessionCollisionNotice
} from '../../shared/live-agent-session-presence-types'

export type LiveSessionCollisionEvent = {
  paneKey: string
  worktreeId?: string
  agentType?: string
  providerSession?: AgentProviderSessionMetadata
  isReplay?: boolean
  restoredUnconfirmed?: true
}

const MAX_TRACKED_PANES = 1024

/** Detects a provider-selected resume after the fact: Orca learns the session from the
 *  provider's hook once the process has already loaded it, so this can only announce,
 *  never prevent. Uncertainty is not announced — the second process already exists. */
export function createLiveSessionCollisionDetector(deps: {
  readPresence: (args: {
    subject: LiveAgentSessionPresenceSubject
    requestingPaneKey: string
  }) => Promise<LiveAgentSessionPresence>
  notify: (notice: LiveSessionCollisionNotice) => void
}): {
  onEvent: (event: LiveSessionCollisionEvent) => Promise<void>
  forgetPane: (paneKey: string) => void
} {
  const sessionKeyByPane = new Map<string, string>()

  const onEvent = async (event: LiveSessionCollisionEvent): Promise<void> => {
    const { providerSession, worktreeId, agentType, paneKey } = event
    if (
      event.isReplay === true ||
      event.restoredUnconfirmed === true ||
      !providerSession ||
      !worktreeId ||
      !isResumableTuiAgent(agentType)
    ) {
      return
    }
    const sessionKey = `${agentType}\0${providerSession.key}\0${providerSession.id}`
    if (sessionKeyByPane.get(paneKey) === sessionKey) {
      return
    }
    sessionKeyByPane.delete(paneKey)
    if (sessionKeyByPane.size >= MAX_TRACKED_PANES) {
      const oldest = sessionKeyByPane.keys().next().value
      if (oldest !== undefined) {
        sessionKeyByPane.delete(oldest)
      }
    }
    sessionKeyByPane.set(paneKey, sessionKey)
    let presence: LiveAgentSessionPresence
    try {
      presence = await deps.readPresence({
        subject: { agent: agentType, providerSession, worktreeId },
        requestingPaneKey: paneKey
      })
    } catch (err) {
      console.warn('[agent-session] collision check failed:', err)
      if (sessionKeyByPane.get(paneKey) === sessionKey) {
        // Why: an unanswered check must not count as done, or the next event could never retry it.
        sessionKeyByPane.delete(paneKey)
      }
      return
    }
    if (sessionKeyByPane.get(paneKey) !== sessionKey) {
      return
    }
    if (presence.kind === 'live-elsewhere' || presence.kind === 'multiple-live-owners') {
      deps.notify({ paneKey, kind: presence.kind, liveElsewhere: presence.liveElsewhere })
    }
  }

  return {
    onEvent,
    forgetPane: (paneKey) => {
      sessionKeyByPane.delete(paneKey)
    }
  }
}
