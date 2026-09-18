import type {
  LiveAgentSessionPresenceRequest,
  LiveAgentSessionPresenceResponse
} from '../../shared/live-agent-session-presence-types'
import {
  readLiveAgentSessionPresence,
  type LiveAgentSessionPresenceReaderDeps,
  type LiveAgentSessionPresenceReading
} from '../agent-hooks/live-agent-session-presence-reader'

export const UNREADABLE_PRESENCE: LiveAgentSessionPresenceResponse = {
  kind: 'unknown',
  liveElsewhere: [],
  ownersRevision: '',
  unknownCount: 0,
  staleCount: 0
}

function ownersRevision(
  liveElsewhere: readonly string[],
  incarnationByPane: Record<string, string>
) {
  return [...liveElsewhere]
    .sort()
    .map((paneKey) => `${paneKey}@${incarnationByPane[paneKey] ?? ''}`)
    .join('|')
}

export function toPresenceResponse(
  presence: LiveAgentSessionPresenceReading
): LiveAgentSessionPresenceResponse {
  return {
    kind: presence.kind,
    liveElsewhere: presence.liveElsewhere,
    ownersRevision: ownersRevision(presence.liveElsewhere, presence.incarnationByPane),
    unknownCount: presence.unknown.length,
    staleCount: presence.stale.length
  }
}

/** Null when the read failed; the caller answers `unknown`. */
export async function readPresence(
  deps: LiveAgentSessionPresenceReaderDeps,
  request: LiveAgentSessionPresenceRequest
): Promise<LiveAgentSessionPresenceReading | null> {
  try {
    return await readLiveAgentSessionPresence(deps, {
      subject: {
        agent: request.agent,
        providerSession: request.providerSession,
        worktreeId: request.worktreeId
      },
      // Why: a pane that does not exist yet owns nothing, so no candidate may match it.
      requestingPaneKey: request.paneKey ?? ''
    })
  } catch (err) {
    console.warn('[agent-session] live presence read failed:', err)
    return null
  }
}

export function isClearPresence(kind: LiveAgentSessionPresenceResponse['kind']): boolean {
  return kind === 'no-live-owner' || kind === 'live-here'
}
