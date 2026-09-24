import { describe, expect, it } from 'vitest'

import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  type ConversationRecord
} from '../../../../shared/conversation-types'

import { EMPTY_CONVERSATION_LIVE_STATE } from './conversation-live-state'
import { conversationToNativeChatSession } from './conversation-native-chat-session'

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
    id: 'conv_1',
    title: 'a chat',
    createdAt: 1,
    updatedAt: 2,
    status: 'active',
    projectId: null,
    provenance: [],
    turns: [],
    messages: [],
    nextSeq: 0,
    ...overrides
  }
}

const userMessage = {
  id: 'm1',
  seq: 0,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'hello' }],
  timestamp: null,
  turnId: null
}

describe('conversation -> native chat session', () => {
  it('renders durable messages as transcript-sourced, which outranks a scrape or a hook', () => {
    const session = conversationToNativeChatSession({
      record: record({ messages: [userMessage] }),
      live: EMPTY_CONVERSATION_LIVE_STATE,
      loading: false,
      readError: null
    })

    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]).toMatchObject({
      id: 'm1',
      role: 'user',
      source: 'transcript'
    })
    expect(session.status).toBe('ready')
  })

  it('shows the sentence being typed, without it being in the record', () => {
    const session = conversationToNativeChatSession({
      record: record({ messages: [userMessage] }),
      live: {
        ...EMPTY_CONVERSATION_LIVE_STATE,
        turnState: 'working',
        streamingByItemId: { i9: 'thin' }
      },
      loading: false,
      readError: null
    })

    expect(session.messages.map((message) => message.id)).toEqual(['m1', 'i9'])
    expect(session.status).toBe('working')
  })

  it('never shows a message twice when a stream and its settled version overlap', () => {
    const settled = { ...userMessage, id: 'dup', role: 'assistant' as const }
    const session = conversationToNativeChatSession({
      record: record({ messages: [settled] }),
      live: { ...EMPTY_CONVERSATION_LIVE_STATE, streamingByItemId: { dup: 'hel' } },
      loading: false,
      readError: null
    })

    // The durable one wins; the half-written one is not shown beside it.
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].blocks).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('keeps loading apart from empty, so a read in flight is not "no messages"', () => {
    expect(
      conversationToNativeChatSession({
        record: null,
        live: EMPTY_CONVERSATION_LIVE_STATE,
        loading: true,
        readError: null
      }).status
    ).toBe('loading')

    expect(
      conversationToNativeChatSession({
        record: record(),
        live: EMPTY_CONVERSATION_LIVE_STATE,
        loading: false,
        readError: null
      }).status
    ).toBe('empty')
  })

  it('reports an unreadable record as an error, never as an empty conversation', () => {
    const session = conversationToNativeChatSession({
      record: null,
      live: EMPTY_CONVERSATION_LIVE_STATE,
      loading: false,
      readError: 'unexpected end of JSON input'
    })

    // Rendering this as empty would turn a transient read failure into apparent data loss.
    expect(session.status).toBe('error')
    expect(session.error).toBe('unexpected end of JSON input')
    expect(session.readPhase).toBe('error')
  })

  it('surfaces the provider thread as provenance and not as the conversation identity', () => {
    const session = conversationToNativeChatSession({
      record: record({
        provenance: [
          { agent: 'codex', providerSessionId: 'thread-a', transcriptPath: null, observedAt: 1 },
          { agent: 'codex', providerSessionId: 'thread-b', transcriptPath: null, observedAt: 2 }
        ]
      }),
      live: EMPTY_CONVERSATION_LIVE_STATE,
      loading: false,
      readError: null
    })

    // Newest binding, and it is NOT conv_1 — the conversation's own id never travels in this field.
    expect(session.sessionId).toBe('thread-b')
    expect(session.sessionId).not.toBe('conv_1')
  })

  it('does not pretend there is older history to page in', () => {
    const session = conversationToNativeChatSession({
      record: record({ messages: [userMessage] }),
      live: EMPTY_CONVERSATION_LIVE_STATE,
      loading: false,
      readError: null
    })

    // The record is read whole. A `hasMore` of true would put a spinner at the top of every
    // conversation waiting for a page that never arrives.
    expect(session.hasMore).toBe(false)
    expect(session.loadingEarlier).toBe(false)
  })
})
