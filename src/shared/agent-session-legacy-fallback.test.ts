import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_RPC_ERROR_CODES } from './agent-session-host-authority'
import { isAgentSessionLegacyFallbackErrorCode } from './agent-session-legacy-fallback'
import { agentSessionResumeRefusalErrorCode } from './agent-session-resume-refusal'

describe('isAgentSessionLegacyFallbackErrorCode', () => {
  it('admits only the two replies that prove nothing started', () => {
    expect(isAgentSessionLegacyFallbackErrorCode('agent_session_legacy_required')).toBe(true)
    expect(isAgentSessionLegacyFallbackErrorCode('method_not_found')).toBe(true)
    const admitted = AGENT_SESSION_RPC_ERROR_CODES.filter(isAgentSessionLegacyFallbackErrorCode)
    expect(admitted).toEqual(['agent_session_legacy_required'])
  })

  it('never admits a collision refusal, an unknown reply or a transport failure', () => {
    for (const reason of [
      'live-elsewhere',
      'multiple-live-owners',
      'materializing',
      'unknown'
    ] as const) {
      expect(
        isAgentSessionLegacyFallbackErrorCode(agentSessionResumeRefusalErrorCode(reason))
      ).toBe(false)
    }
    for (const code of ['invalid_params', 'runtime_error', 'timeout', '', undefined, null, 42]) {
      expect(isAgentSessionLegacyFallbackErrorCode(code)).toBe(false)
    }
  })
})
