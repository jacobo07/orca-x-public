import { describe, expect, it } from 'vitest'
import {
  parseAgentStatusPayload,
  pickParsedAgentStatusPayload,
  type ParsedAgentStatusPayload
} from './agent-status-types'

// The `agentType` WIRE field is emitted by processes outside Orca (hook integrations, OSC 9999)
// and republished to paired clients, so its spelling is a compatibility contract — unlike the
// `AgentType` TYPE beside it, which is ours to rename. A case-insensitive edit hits both.

const WIRE_PAYLOAD = '{"state":"working","prompt":"Fix the flaky assertion","agentType":"codex"}'

describe('agent status wire field name', () => {
  it('accepts the lowercase agentType key an external producer sends', () => {
    const parsed = parseAgentStatusPayload(WIRE_PAYLOAD)

    expect(parsed).not.toBeNull()
    expect(parsed?.agentType).toBe('codex')
  })

  it('republishes the key spelled agentType', () => {
    const row = parseAgentStatusPayload(WIRE_PAYLOAD) as ParsedAgentStatusPayload

    // Why Object.keys: asserting `.agentType` alone still passes if the field were renamed and
    // the old name re-added as an alias. The published key set is what an old peer decodes.
    expect(Object.keys(pickParsedAgentStatusPayload(row))).toContain('agentType')
  })

  it('still parses a payload that carries no agentType', () => {
    // Control: without this, a parser that rejected everything would satisfy the cases above.
    const parsed = parseAgentStatusPayload('{"state":"done","prompt":"Ship it"}')

    expect(parsed).not.toBeNull()
    expect(parsed?.agentType).toBeUndefined()
  })
})
