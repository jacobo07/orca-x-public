import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from './agent-session-resume'
import { parsePaneKey } from './stable-pane-id'

export const LIVE_AGENT_SESSION_PRESENCE_CHANNEL = 'agentSession:readLivePresence'
export const LIVE_SESSION_COLLISION_CHANNEL = 'agentSession:liveCollision'

export type LiveSessionCollisionNotice = {
  /** Pane that just started reporting a session already live elsewhere. */
  paneKey: string
  kind: 'live-elsewhere' | 'multiple-live-owners'
  liveElsewhere: string[]
}

export type LiveAgentSessionPresenceRequest = {
  /** Pane about to materialize the session. */
  paneKey: string
  worktreeId: string
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
}

export type LiveAgentSessionPresenceWireKind =
  | 'no-live-owner'
  | 'live-here'
  | 'live-elsewhere'
  | 'multiple-live-owners'
  | 'unknown'

/** Renderer-facing answer. Carries pane keys, never provider identifiers. */
export type LiveAgentSessionPresenceResponse = {
  kind: LiveAgentSessionPresenceWireKind
  liveElsewhere: string[]
  unknownCount: number
  staleCount: number
}

const MAX_WORKTREE_ID_LENGTH = 1024

function isStablePaneKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && parsePaneKey(value) !== null
}

/** Null when the request cannot name one exact provider session. */
export function parseLiveAgentSessionPresenceRequest(
  value: unknown
): LiveAgentSessionPresenceRequest | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Record<string, unknown>
  if (
    !isStablePaneKey(raw.paneKey) ||
    typeof raw.worktreeId !== 'string' ||
    raw.worktreeId.length === 0 ||
    raw.worktreeId.length > MAX_WORKTREE_ID_LENGTH ||
    !isResumableTuiAgent(raw.agent)
  ) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(raw.providerSession)
  if (!providerSession) {
    return null
  }
  return {
    paneKey: raw.paneKey,
    worktreeId: raw.worktreeId,
    agent: raw.agent,
    providerSession
  }
}
