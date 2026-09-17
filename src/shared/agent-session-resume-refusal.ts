import type { LiveSessionResumeRefusal } from './live-agent-session-presence-types'

// Why: disjoint from agent_session_legacy_required / method_not_found, so a client that only
// falls back on those treats a refusal as a failure and never retries an unguarded launch.
const REFUSAL_ERROR_CODES: Record<LiveSessionResumeRefusal, string> = {
  'live-elsewhere': 'agent_session_live_elsewhere',
  'multiple-live-owners': 'agent_session_multiple_live_owners',
  materializing: 'agent_session_materializing',
  unknown: 'agent_session_presence_unknown'
}

export function agentSessionResumeRefusalErrorCode(reason: LiveSessionResumeRefusal): string {
  return REFUSAL_ERROR_CODES[reason]
}

/** The guard's reason when a host refused to resume a session; null for any other error. */
export function readAgentSessionResumeRefusal(error: unknown): LiveSessionResumeRefusal | null {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return parseAgentSessionResumeRefusalErrorCode(code)
}

export function parseAgentSessionResumeRefusalErrorCode(
  code: unknown
): LiveSessionResumeRefusal | null {
  for (const [reason, candidate] of Object.entries(REFUSAL_ERROR_CODES)) {
    if (candidate === code) {
      return reason as LiveSessionResumeRefusal
    }
  }
  return null
}
