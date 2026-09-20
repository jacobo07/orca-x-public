import { describe, expect, it } from 'vitest'

import {
  appendProviderProvenance,
  isConversationId,
  latestProviderProvenance,
  mintConversationId
} from './conversation-identity'
import { ConversationPresentationAttachments } from './conversation-presentation-attachment'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  CONVERSATION_TURN_STATES,
  isDurableConversationRole,
  isConversationTurnSettled,
  type ConversationRecord
} from './conversation-types'
import { NATIVE_CHAT_TURN_LIFECYCLE_STATES } from './native-chat-types'

function emptyRecord(): ConversationRecord {
  const id = mintConversationId()
  return {
    schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
    id,
    title: null,
    createdAt: 10,
    updatedAt: 10,
    status: 'active',
    projectId: null,
    provenance: [],
    turns: [],
    messages: [],
    nextSeq: 0
  }
}

describe('conversation identity is Orca-owned', () => {
  it('mints an id from nothing the surroundings supply', () => {
    // The signature is the assertion: there is no parameter a pane, PTY, provider session or host
    // could be passed through. A regression that added one would not compile against this call.
    const first = mintConversationId()
    const second = mintConversationId()

    expect(isConversationId(first)).toBe(true)
    expect(first).not.toBe(second)
  })

  it('rejects a provider session id as a conversation id', () => {
    expect(isConversationId('provider-session-alpha')).toBe(false)
    expect(isConversationId('tab-1:leaf-9')).toBe(false)
    expect(isConversationId('')).toBe(false)
    expect(isConversationId(undefined)).toBe(false)
  })
})

describe('a conversation outlives its presentation', () => {
  it('survives pane destruction and remains resolvable by id', () => {
    const record = emptyRecord()
    const attachments = new ConversationPresentationAttachments()
    attachments.attach(record.id, 'tab-1:leaf-a')
    expect(attachments.paneFor(record.id)).toBe('tab-1:leaf-a')

    attachments.detachPane('tab-1:leaf-a')

    // The pane is gone. The conversation is not: it has an id, and the record is untouched.
    expect(attachments.isAttached(record.id)).toBe(false)
    expect(attachments.paneFor(record.id)).toBeNull()
    expect(record.status).toBe('active')
    expect(isConversationId(record.id)).toBe(true)
  })

  it('reattaches to a new presentation under the same identity', () => {
    const record = emptyRecord()
    const attachments = new ConversationPresentationAttachments()

    attachments.attach(record.id, 'tab-1:leaf-a')
    attachments.detachPane('tab-1:leaf-a')
    attachments.attach(record.id, 'tab-9:leaf-z')

    expect(attachments.paneFor(record.id)).toBe('tab-9:leaf-z')
    expect(attachments.conversationFor('tab-9:leaf-z')).toBe(record.id)
    expect(attachments.conversationFor('tab-1:leaf-a')).toBeNull()
  })

  it('holds at most one attachment per conversation and per pane', () => {
    const first = emptyRecord()
    const second = emptyRecord()
    const attachments = new ConversationPresentationAttachments()

    attachments.attach(first.id, 'tab-1:leaf-a')
    attachments.attach(first.id, 'tab-2:leaf-b')
    expect(attachments.list()).toEqual([{ conversationId: first.id, paneKey: 'tab-2:leaf-b' }])

    // A second conversation taking the pane displaces the first's attachment, not the first.
    attachments.attach(second.id, 'tab-2:leaf-b')
    expect(attachments.paneFor(first.id)).toBeNull()
    expect(attachments.paneFor(second.id)).toBe('tab-2:leaf-b')
  })

  it('treats detaching an unattached conversation as a no-op', () => {
    const record = emptyRecord()
    const attachments = new ConversationPresentationAttachments()

    attachments.detachConversation(record.id)
    attachments.detachPane('tab-never:leaf-never')

    expect(attachments.list()).toEqual([])
  })
})

describe('provider continuation is provenance, never identity', () => {
  it('keeps one identity across a provider session rotation', () => {
    const record = emptyRecord()

    const afterFirst = appendProviderProvenance(record, {
      agent: 'claude',
      providerSessionId: 'provider-session-alpha',
      transcriptPath: '/transcripts/alpha.jsonl',
      observedAt: 20
    })
    const afterRotation = appendProviderProvenance(afterFirst, {
      agent: 'claude',
      providerSessionId: 'provider-session-beta',
      transcriptPath: '/transcripts/beta.jsonl',
      observedAt: 30
    })

    expect(afterRotation.id).toBe(record.id)
    expect(afterRotation.provenance).toHaveLength(2)
    expect(latestProviderProvenance(afterRotation)?.providerSessionId).toBe('provider-session-beta')
  })

  it('does not grow lineage when the same binding is re-observed', () => {
    const record = emptyRecord()
    const binding = {
      agent: 'codex' as const,
      providerSessionId: 'thread-1',
      transcriptPath: null,
      observedAt: 20
    }

    const once = appendProviderProvenance(record, binding)
    const twice = appendProviderProvenance(once, { ...binding, observedAt: 99 })

    expect(twice.provenance).toHaveLength(1)
    expect(twice).toBe(once)
  })

  it('reports no continuation evidence rather than inventing one', () => {
    const record = emptyRecord()
    const withUnreportedSession = appendProviderProvenance(record, {
      agent: 'claude',
      providerSessionId: null,
      transcriptPath: null,
      observedAt: 20
    })

    // A conversation the provider never named is not empty and not failed. It simply has nothing
    // to continue from, and the caller must be able to tell that apart from a missing record.
    expect(latestProviderProvenance(withUnreportedSession)).toBeNull()
    expect(withUnreportedSession.provenance).toHaveLength(1)
  })

  it('prefers the most recent binding that actually named a session', () => {
    const record = emptyRecord()
    const named = appendProviderProvenance(record, {
      agent: 'claude',
      providerSessionId: 'provider-session-alpha',
      transcriptPath: null,
      observedAt: 20
    })
    const thenUnnamed = appendProviderProvenance(named, {
      agent: 'claude',
      providerSessionId: null,
      transcriptPath: null,
      observedAt: 30
    })

    expect(latestProviderProvenance(thenUnnamed)?.providerSessionId).toBe('provider-session-alpha')
  })
})

describe('durable vocabulary is inherited, not duplicated', () => {
  it('admits every transcript lifecycle state as a conversation turn state', () => {
    for (const state of NATIVE_CHAT_TURN_LIFECYCLE_STATES) {
      expect(CONVERSATION_TURN_STATES).toContain(state)
    }
    expect(CONVERSATION_TURN_STATES).toContain('pending')
    expect(CONVERSATION_TURN_STATES).toContain('failed')
  })

  it('separates settled turns from turns that were cut short', () => {
    expect(isConversationTurnSettled('completed')).toBe(true)
    expect(isConversationTurnSettled('interrupted')).toBe(true)
    expect(isConversationTurnSettled('failed')).toBe(true)
    // A record reloaded in one of these was cut off mid-turn and must not read as complete.
    expect(isConversationTurnSettled('pending')).toBe(false)
    expect(isConversationTurnSettled('working')).toBe(false)
  })

  it('refuses hidden reasoning as durable state', () => {
    expect(isDurableConversationRole('reasoning')).toBe(false)
    expect(isDurableConversationRole('user')).toBe(true)
    expect(isDurableConversationRole('assistant')).toBe(true)
    expect(isDurableConversationRole('tool')).toBe(true)
  })
})
