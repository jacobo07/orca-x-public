import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_RPC_ERROR_CODES } from './agent-session-host-authority'
import {
  agentSessionResumeRefusalErrorCode,
  parseAgentSessionResumeRefusalErrorCode
} from './agent-session-resume-refusal'
import type { LiveSessionResumeRefusal } from './live-agent-session-presence-types'

const REASONS: LiveSessionResumeRefusal[] = [
  'live-elsewhere',
  'multiple-live-owners',
  'materializing',
  'unknown'
]
// What a shipped client falls back to an unguarded launch on.
const LEGACY_FALLBACK_CODES = ['agent_session_legacy_required', 'method_not_found']

describe('agent session resume refusal codes', () => {
  it('keeps every reason distinct and reaches the client through the RPC allowlist', () => {
    const codes = REASONS.map(agentSessionResumeRefusalErrorCode)
    expect(new Set(codes).size).toBe(REASONS.length)
    for (const code of codes) {
      expect(AGENT_SESSION_RPC_ERROR_CODES as readonly string[]).toContain(code)
      expect(LEGACY_FALLBACK_CODES).not.toContain(code)
    }
  })

  it('round-trips, and reads nothing else as a refusal', () => {
    for (const reason of REASONS) {
      expect(
        parseAgentSessionResumeRefusalErrorCode(agentSessionResumeRefusalErrorCode(reason))
      ).toBe(reason)
    }
    expect(parseAgentSessionResumeRefusalErrorCode('agent_session_conflict')).toBeNull()
    expect(parseAgentSessionResumeRefusalErrorCode(undefined)).toBeNull()
  })
})
