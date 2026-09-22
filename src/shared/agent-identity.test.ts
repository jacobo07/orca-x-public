import { describe, expect, it } from 'vitest'
import { isAgent, isAgentId, mintAgentId } from './agent-identity'
import { AGENT_ID_PREFIX } from './agent-types'

describe('agent identity', () => {
  // The contract worth pinning is the signature, not the string: a mint that accepted a project,
  // a name or a provider would let an agent's identity inherit that thing's lifetime.
  it('mints from nothing', () => {
    expect(mintAgentId.length).toBe(0)
    expect(mintAgentId()).not.toBe(mintAgentId())
  })

  it('recognises its own ids and rejects a bare prefix', () => {
    expect(isAgentId(mintAgentId())).toBe(true)
    expect(isAgentId(AGENT_ID_PREFIX)).toBe(false)
    expect(isAgentId('conv_abc')).toBe(false)
    expect(isAgentId(null)).toBe(false)
  })

  it('refuses a malformed agent rather than repairing it', () => {
    const valid = {
      id: mintAgentId(),
      name: 'Runtime Architect',
      role: 'reviews runtime decisions',
      projectId: null,
      createdAt: 1,
      updatedAt: 2
    }
    expect(isAgent(valid)).toBe(true)
    // A row whose ownership cannot be read is not a row owned by nothing.
    expect(isAgent({ ...valid, projectId: 42 })).toBe(false)
    expect(isAgent({ ...valid, id: 'not-an-agent-id' })).toBe(false)
    expect(isAgent({ ...valid, createdAt: Number.NaN })).toBe(false)
    expect(isAgent(null)).toBe(false)
    expect(isAgent([valid])).toBe(false)
  })
})
