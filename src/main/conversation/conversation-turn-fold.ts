// Folds normalized turn events into a conversation record.
//
// This is the join between W2's provider gateway and W1's durable owner, and it is deliberately
// PURE: it returns the next record and writes nothing. The gateway does not get a persistence
// authority of its own — there is one owner of a conversation's bytes, and it is ConversationStore.
//
// Deltas are not durable. A stream of tokens is transport; the message is what the provider says
// is complete. Folding each delta would write the same sentence a hundred times and make an
// interrupted turn indistinguishable from a finished one.

import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import {
  isDurableConversationRole,
  type ConversationMessage,
  type ConversationRecord,
  type ConversationTurn,
  type ConversationTurnState
} from '../../shared/conversation-types'

function settleTurn(
  record: ConversationRecord,
  turnId: string,
  state: Exclude<ConversationTurnState, 'pending' | 'working'>,
  at: number
): ConversationRecord {
  const existing = record.turns.find((turn) => turn.turnId === turnId)
  if (!existing) {
    // Joining a turn already in progress is ordinary — a resumed thread, a reconnect. Recording it
    // as already settled is more honest than dropping the only evidence the turn happened.
    const joined: ConversationTurn = {
      turnId,
      seq: record.nextSeq,
      state,
      startedAt: at,
      endedAt: at
    }
    return {
      ...record,
      turns: [...record.turns, joined],
      nextSeq: record.nextSeq + 1,
      updatedAt: at
    }
  }
  if (existing.endedAt !== null) {
    // Already settled. A repeated completion is a duplicate frame, not a second ending, and the
    // FIRST ending is the true one — a later `completed` must not overwrite an `interrupted`.
    return record
  }
  return {
    ...record,
    turns: record.turns.map((turn) =>
      turn.turnId === turnId ? { ...turn, state, endedAt: at } : turn
    ),
    updatedAt: at
  }
}

function upsertMessage(
  record: ConversationRecord,
  message: Omit<ConversationMessage, 'seq'>,
  at: number
): ConversationRecord {
  const index = record.messages.findIndex((existing) => existing.id === message.id)
  if (index !== -1) {
    // Same item id twice is a replacement, not a second message — a provider that re-sends a
    // completed item after a resume must not double it in the transcript.
    const kept = record.messages[index]
    const next = [...record.messages]
    next[index] = { ...message, seq: kept.seq }
    return { ...record, messages: next, updatedAt: at }
  }
  return {
    ...record,
    messages: [...record.messages, { ...message, seq: record.nextSeq }],
    nextSeq: record.nextSeq + 1,
    updatedAt: at
  }
}

/**
 * @param at the clock Orca observed the event at. Provider timestamps are not comparable across
 *   processes, so ordering is Orca-assigned (`seq`) and this only stamps `updatedAt`.
 */
export function applyAgentTurnEvent(
  record: ConversationRecord,
  event: AgentTurnEvent,
  at: number
): ConversationRecord {
  switch (event.kind) {
    case 'turn-started': {
      if (record.turns.some((turn) => turn.turnId === event.turnId)) {
        return record
      }
      const turn: ConversationTurn = {
        turnId: event.turnId,
        seq: record.nextSeq,
        state: 'working',
        startedAt: at,
        endedAt: null
      }
      return {
        ...record,
        turns: [...record.turns, turn],
        nextSeq: record.nextSeq + 1,
        updatedAt: at
      }
    }
    case 'message-completed': {
      if (!isDurableConversationRole(event.role)) {
        // Hidden reasoning is provider-internal. W1 refuses it at the store; refusing it here as
        // well means the refusal is not the last line of defence.
        return record
      }
      return upsertMessage(
        record,
        {
          id: event.itemId,
          role: event.role,
          blocks: event.blocks,
          timestamp: null,
          turnId: event.turnId
        },
        at
      )
    }
    case 'turn-completed':
      return settleTurn(record, event.turnId, 'completed', at)
    case 'turn-ended':
      return event.turnId === null
        ? record
        : settleTurn(record, event.turnId, event.state === 'failed' ? 'failed' : 'interrupted', at)
    case 'assistant-delta':
    case 'provider-status':
    case 'approval-requested':
    case 'approval-resolved':
    case 'unmapped':
      // Live-only. Deltas are transport, status and approvals are surfaced to the user as they
      // happen, and an unmapped frame has no product meaning by construction.
      return record
  }
}

/** Marks every turn still in flight as interrupted. Called when a provider dies or a session ends
 *  without a completion, so a record never loads looking finished when it was cut off. */
export function interruptUnsettledTurns(
  record: ConversationRecord,
  at: number,
  reason: 'interrupted' | 'failed' = 'interrupted'
): ConversationRecord {
  const unsettled = record.turns.filter((turn) => turn.endedAt === null)
  if (unsettled.length === 0) {
    return record
  }
  return {
    ...record,
    turns: record.turns.map((turn) =>
      turn.endedAt === null ? { ...turn, state: reason, endedAt: at } : turn
    ),
    updatedAt: at
  }
}
