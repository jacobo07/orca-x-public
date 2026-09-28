import { describe, expect, it } from 'vitest'

import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  type ConversationRecord
} from '../../shared/conversation-types'
import { applyAgentTurnEvent, interruptUnsettledTurns } from './conversation-turn-fold'

function blank(): ConversationRecord {
  return {
    schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
    id: 'conv_test',
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

function fold(events: AgentTurnEvent[], from = blank()): ConversationRecord {
  return events.reduce((record, event, index) => applyAgentTurnEvent(record, event, 100 + index), from)
}

const assistant = (itemId: string, text: string, turnId: string | null): AgentTurnEvent => ({
  kind: 'message-completed',
  turnId,
  itemId,
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})

describe('applyAgentTurnEvent', () => {
  it('records a turn and the message it produced', () => {
    const record = fold([
      { kind: 'turn-started', turnId: 'turn-1' },
      assistant('msg-1', 'hello', 'turn-1'),
      { kind: 'turn-completed', turnId: 'turn-1' }
    ])

    expect(record.turns).toEqual([
      { turnId: 'turn-1', seq: 1, state: 'completed', startedAt: 100, endedAt: 102 }
    ])
    expect(record.messages).toMatchObject([{ id: 'msg-1', seq: 2, role: 'assistant' }])
  })

  it('does not make a durable message out of every delta', () => {
    // Deltas are transport. Folding them would write the same sentence once per token.
    const record = fold([
      { kind: 'turn-started', turnId: 'turn-1' },
      { kind: 'assistant-delta', turnId: 'turn-1', itemId: 'msg-1', text: 'he' },
      { kind: 'assistant-delta', turnId: 'turn-1', itemId: 'msg-1', text: 'llo' }
    ])

    expect(record.messages).toEqual([])
  })

  it('replaces a repeated item instead of duplicating it', () => {
    // A resumed thread re-sending a completed item must not double it in the transcript.
    const record = fold([
      assistant('msg-1', 'first', 'turn-1'),
      assistant('msg-1', 'first, corrected', 'turn-1')
    ])

    expect(record.messages).toHaveLength(1)
    expect(record.messages[0]).toMatchObject({ seq: 1, blocks: [{ text: 'first, corrected' }] })
  })

  it('keeps the FIRST ending, so a late completion cannot erase an interruption', () => {
    const record = fold([
      { kind: 'turn-started', turnId: 'turn-1' },
      { kind: 'turn-ended', turnId: 'turn-1', state: 'interrupted', reason: 'provider died' },
      { kind: 'turn-completed', turnId: 'turn-1' }
    ])

    expect(record.turns[0]).toMatchObject({ state: 'interrupted' })
  })

  it('CONTROL: a completion still settles a turn that has not ended', () => {
    // Without this, "never change a turn once created" would pass the case above.
    const record = fold([
      { kind: 'turn-started', turnId: 'turn-1' },
      { kind: 'turn-completed', turnId: 'turn-1' }
    ])

    expect(record.turns[0]).toMatchObject({ state: 'completed' })
  })

  it('records a completion for a turn it never saw start, rather than dropping it', () => {
    const record = fold([{ kind: 'turn-completed', turnId: 'turn-late' }])

    expect(record.turns).toMatchObject([{ turnId: 'turn-late', state: 'completed' }])
  })

  it('refuses to persist hidden reasoning', () => {
    const record = fold([
      { kind: 'message-completed', turnId: 't', itemId: 'r1', role: 'reasoning', blocks: [{ type: 'text', text: 'private' }] }
    ])

    expect(record.messages).toEqual([])
  })

  it.each([
    { kind: 'provider-status', status: 'active', detail: 'waitingOnApproval' },
    { kind: 'approval-requested', approvalId: 'a1', method: 'm', summary: 's' },
    { kind: 'approval-resolved', approvalId: 'a1', approved: false, reason: 'no authority' },
    { kind: 'unmapped', method: 'hook/started' }
  ] as AgentTurnEvent[])('leaves the record untouched for $kind', (event) => {
    const before = blank()
    expect(applyAgentTurnEvent(before, event, 100)).toBe(before)
  })

  it('never reuses a seq across turns and messages', () => {
    const record = fold([
      { kind: 'turn-started', turnId: 'turn-1' },
      assistant('msg-1', 'a', 'turn-1'),
      { kind: 'turn-started', turnId: 'turn-2' },
      assistant('msg-2', 'b', 'turn-2')
    ])

    const seqs = [...record.turns.map((t) => t.seq), ...record.messages.map((m) => m.seq)]
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(record.nextSeq).toBe(5)
  })
})

describe('interruptUnsettledTurns', () => {
  it('marks a turn cut off by a dead provider, and says so honestly', () => {
    const record = interruptUnsettledTurns(
      fold([{ kind: 'turn-started', turnId: 'turn-1' }]),
      500
    )

    expect(record.turns[0]).toMatchObject({ state: 'interrupted', endedAt: 500 })
  })

  it('leaves a settled record alone', () => {
    const settled = fold([
      { kind: 'turn-started', turnId: 'turn-1' },
      { kind: 'turn-completed', turnId: 'turn-1' }
    ])

    expect(interruptUnsettledTurns(settled, 500)).toBe(settled)
  })
})
