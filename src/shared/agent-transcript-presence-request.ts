import type { ProviderType } from './native-chat-types'
import type { WorkingSetFactPresence } from './project-working-set-store-types'

/**
 * Asking the host whether an agent conversation is still findable on disk.
 *
 * The renderer names a session; main resolves the path and stats it. Nothing here is authority to
 * resume anything — it is one fact, and the transitions that ask it decide what it earns.
 */

export const AGENT_TRANSCRIPT_PRESENCE_CHANNEL = 'agentSession:probeTranscriptPresence'

/** Long enough for any real home-relative transcript path, short enough to refuse a payload. */
const MAX_FIELD_LENGTH = 4096

export type AgentTranscriptPresenceRequest = {
  agent: ProviderType
  sessionId: string
  /** The path the agent's own hook reported, when it reported one. */
  transcriptPath?: string
}

function readable(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH
}

/** Null for anything malformed. A caller that cannot be understood is told `unknown`, not `absent`. */
export function parseAgentTranscriptPresenceRequest(
  value: unknown
): AgentTranscriptPresenceRequest | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { agent, sessionId, transcriptPath } = value as Record<string, unknown>
  if (!readable(agent) || !readable(sessionId)) {
    return null
  }
  if (transcriptPath !== undefined && !readable(transcriptPath)) {
    return null
  }
  return {
    agent: agent as ProviderType,
    sessionId,
    ...(transcriptPath ? { transcriptPath } : {})
  }
}

/** What a client with no local filesystem to stat must answer. It is not a failure. */
export const TRANSCRIPT_PRESENCE_UNKNOWN: WorkingSetFactPresence = 'unknown'
