import { describe, expect, it } from 'vitest'

import {
  UNKNOWN_AGENT_CAPABILITIES,
  type AgentProviderCapabilities,
  type AgentTurnEvent
} from '../../shared/agent-turn-event'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  type ConversationRecord
} from '../../shared/conversation-types'
import { applyAgentTurnEvent, interruptUnsettledTurns } from './conversation-turn-fold'

// A contract test against a provider shaped NOTHING like Codex.
//
// Codex is a long-lived bidirectional peer with token-level deltas and a server-request channel.
// A Claude-style headless run is the opposite on every axis: one process per invocation, NDJSON on
// stdout, one terminal assistant event, no deltas, no channel to ask us anything. If the neutral
// vocabulary had quietly been built around Codex's properties, that shape could not be expressed
// through it — which is the accidental coupling this file exists to catch.
//
// This is not a Claude driver. It is a deliberately different fixture standing in for one, so the
// contract is driven by two shapes rather than by the one it was written against.

/** One process per invocation, one terminal message, nothing streamed. */
const COARSE_HEADLESS_NDJSON = [
  '{"type":"system","subtype":"init","session_id":"sess-abc"}',
  '{"type":"assistant","message":{"id":"m-1","content":[{"type":"text","text":"Done."}]}}',
  '{"type":"result","subtype":"success","session_id":"sess-abc"}'
]

const COARSE_CAPABILITIES: AgentProviderCapabilities = {
  ...UNKNOWN_AGENT_CAPABILITIES,
  'streaming-deltas': 'unsupported',
  'persistent-session': 'unsupported',
  'server-requests': 'unsupported',
  'tool-approvals': 'unsupported',
  'thread-resume': 'supported'
  // `cancellation` stays UNKNOWN: nobody has checked, and that is not the same as absent.
}

/** Maps the coarse transcript into the SAME neutral events the Codex driver emits. */
function mapCoarseLine(line: string, turnId: string): AgentTurnEvent {
  const parsed = JSON.parse(line) as Record<string, unknown>
  switch (parsed.type) {
    case 'system':
      return { kind: 'turn-started', turnId }
    case 'assistant': {
      const message = parsed.message as { id: string; content: { type: string; text: string }[] }
      return {
        kind: 'message-completed',
        turnId,
        itemId: message.id,
        role: 'assistant',
        blocks: message.content.map((entry) => ({ type: 'text', text: entry.text }))
      }
    }
    case 'result':
      return parsed.subtype === 'success'
        ? { kind: 'turn-completed', turnId }
        : { kind: 'turn-ended', turnId, state: 'failed', reason: String(parsed.subtype) }
    default:
      return { kind: 'unmapped', method: String(parsed.type) }
  }
}

function blank(): ConversationRecord {
  return {
    schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
    id: 'conv_coarse',
    title: null,
    createdAt: 0,
    updatedAt: 0,
    status: 'active',
    projectId: null,
    provenance: [],
    turns: [],
    messages: [],
    nextSeq: 1
  }
}

function foldTranscript(lines: string[]): ConversationRecord {
  return lines.reduce(
    (record, line, index) => applyAgentTurnEvent(record, mapCoarseLine(line, 'turn-coarse'), 100 + index),
    blank()
  )
}

describe('the neutral turn contract under a coarse headless provider', () => {
  it('produces a complete conversation with no deltas at all', () => {
    const record = foldTranscript(COARSE_HEADLESS_NDJSON)

    expect(record.turns).toMatchObject([{ turnId: 'turn-coarse', state: 'completed' }])
    expect(record.messages).toMatchObject([
      { id: 'm-1', role: 'assistant', blocks: [{ type: 'text', text: 'Done.' }] }
    ])
  })

  it('CONTROL: the same contract carries the streaming provider too', () => {
    // If this file only ever drove the coarse shape it would prove the vocabulary fits ONE
    // provider, which is the failure it exists to exclude — just a different one.
    const streamed: AgentTurnEvent[] = [
      { kind: 'turn-started', turnId: 'turn-stream' },
      { kind: 'assistant-delta', turnId: 'turn-stream', itemId: 'm-1', text: 'Do' },
      { kind: 'assistant-delta', turnId: 'turn-stream', itemId: 'm-1', text: 'ne.' },
      { kind: 'message-completed', turnId: 'turn-stream', itemId: 'm-1', role: 'assistant', blocks: [{ type: 'text', text: 'Done.' }] },
      { kind: 'turn-completed', turnId: 'turn-stream' }
    ]

    const record = streamed.reduce((acc, event, i) => applyAgentTurnEvent(acc, event, 100 + i), blank())

    expect(record.turns).toMatchObject([{ state: 'completed' }])
    expect(record.messages).toMatchObject([{ id: 'm-1', blocks: [{ type: 'text', text: 'Done.' }] }])
  })

  it('marks a headless run that died mid-turn as interrupted, not completed', () => {
    // Process-per-invocation providers end by exiting. An exit with no result line must not read
    // as a finished turn.
    const partial = foldTranscript(COARSE_HEADLESS_NDJSON.slice(0, 2))
    expect(partial.turns[0]).toMatchObject({ state: 'working', endedAt: null })

    const afterExit = interruptUnsettledTurns(partial, 900)
    expect(afterExit.turns[0]).toMatchObject({ state: 'interrupted', endedAt: 900 })
  })

  it('states unsupported and unknown as different things', () => {
    // UNSUPPORTED is a claim about the provider. UNKNOWN is the absence of one. A model that
    // collapsed them would let "nobody checked" render as "this provider cannot".
    expect(COARSE_CAPABILITIES['server-requests']).toBe('unsupported')
    expect(COARSE_CAPABILITIES.cancellation).toBe('unknown')
    expect(COARSE_CAPABILITIES['server-requests']).not.toBe(COARSE_CAPABILITIES.cancellation)
  })

  it('needs no approval path to be a complete provider', () => {
    // The whole approval apparatus is Codex-shaped. A provider with no channel to ask anything
    // must still produce a valid conversation, or the contract has Codex baked into it.
    const record = foldTranscript(COARSE_HEADLESS_NDJSON)
    expect(record.turns[0].state).toBe('completed')
    expect(COARSE_CAPABILITIES['tool-approvals']).toBe('unsupported')
  })
})
