import { ipcMain } from 'electron'
import {
  LIVE_AGENT_SESSION_PRESENCE_CHANNEL,
  parseLiveAgentSessionPresenceRequest,
  type LiveAgentSessionPresenceResponse
} from '../../shared/live-agent-session-presence-types'
import {
  readLiveAgentSessionPresence,
  type LiveAgentSessionPresenceReaderDeps
} from '../agent-hooks/live-agent-session-presence-reader'

const UNREADABLE_REQUEST: LiveAgentSessionPresenceResponse = {
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

/** Answers where a provider session is live. A malformed request or a failed read is
 *  `unknown`, never `no-live-owner`: absence of an answer is not absence of an owner. */
export async function handleLiveAgentSessionPresenceRequest(
  deps: LiveAgentSessionPresenceReaderDeps,
  value: unknown
): Promise<LiveAgentSessionPresenceResponse> {
  const request = parseLiveAgentSessionPresenceRequest(value)
  if (!request) {
    return UNREADABLE_REQUEST
  }
  try {
    const presence = await readLiveAgentSessionPresence(deps, {
      subject: {
        agent: request.agent,
        providerSession: request.providerSession,
        worktreeId: request.worktreeId
      },
      // Why: a pane that does not exist yet owns nothing, so no candidate may match it.
      requestingPaneKey: request.paneKey ?? ''
    })
    return {
      kind: presence.kind,
      liveElsewhere: presence.liveElsewhere,
      ownersRevision: ownersRevision(presence.liveElsewhere, presence.incarnationByPane),
      unknownCount: presence.unknown.length,
      staleCount: presence.stale.length
    }
  } catch (err) {
    console.warn('[agent-session] live presence read failed:', err)
    return UNREADABLE_REQUEST
  }
}

export function registerAgentSessionLivePresenceHandlers(
  resolveDeps: () => LiveAgentSessionPresenceReaderDeps
): void {
  // Why: no removeHandler first — a second registration must fail loudly, not steal the channel.
  ipcMain.handle(LIVE_AGENT_SESSION_PRESENCE_CHANNEL, (_event, value: unknown) =>
    handleLiveAgentSessionPresenceRequest(resolveDeps(), value)
  )
}
