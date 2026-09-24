// Conversation identity and its relationship to the things that are NOT its identity.
//
// The whole point of this module is what it does not accept: no mint function takes a pane key,
// leaf id, PTY id, provider session id or host. An id that could be derived from one of those
// would inherit that thing's lifetime, which is the defect the conversation primitive removes.

import {
  CONVERSATION_ID_PREFIX,
  type ConversationId,
  type ConversationProviderProvenance,
  type ConversationRecord
} from './conversation-types'

/** Mirrors the estate's cross-process id pattern: renderer and main both reach a crypto here, and
 *  the fallback keeps Node 18 SSH companions working. */
function randomIdSuffix(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (randomUUID) {
    return randomUUID.call(globalThis.crypto)
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Takes no arguments, on purpose. There is nothing about a conversation's surroundings that may
 *  contribute to its identity. */
export function mintConversationId(): ConversationId {
  return `${CONVERSATION_ID_PREFIX}${randomIdSuffix()}`
}

export function isConversationId(value: unknown): value is ConversationId {
  return (
    typeof value === 'string' &&
    value.startsWith(CONVERSATION_ID_PREFIX) &&
    value.length > CONVERSATION_ID_PREFIX.length
  )
}

/** Record a provider binding as lineage. Appends rather than replaces: a provider session rotating,
 *  dying or being replaced is a new piece of evidence about the same conversation, not a new
 *  conversation. Re-observing the binding already at the head is a no-op so idle re-reports do not
 *  grow the record without bound. */
export function appendProviderProvenance(
  record: ConversationRecord,
  provenance: ConversationProviderProvenance
): ConversationRecord {
  const head = record.provenance.at(-1)
  if (
    head &&
    head.agent === provenance.agent &&
    head.providerSessionId === provenance.providerSessionId &&
    head.transcriptPath === provenance.transcriptPath &&
    provenanceHostId(head) === provenanceHostId(provenance)
  ) {
    return record
  }
  return {
    ...record,
    provenance: [...record.provenance, provenance],
    updatedAt: provenance.observedAt
  }
}

/** Where a binding's provider thread lives. Absent is local: every record written before remote
 *  turns existed was a local one. */
export function provenanceHostId(
  entry: Pick<ConversationProviderProvenance, 'executionHostId'>
): string {
  return entry.executionHostId ?? 'local'
}

/** The provider binding to try first when continuing this conversation, or null when the
 *  conversation has never been carried by a provider session that reported one.
 *
 *  With `hostId`, only a binding on THAT host counts: a thread's history exists only where it ran,
 *  so resuming another host's thread fails and would abandon this host's still-valid one.
 *
 *  Null is "no continuation evidence", NOT "the conversation is empty" and NOT "it failed". */
export function latestProviderProvenance(
  record: ConversationRecord,
  hostId?: string
): ConversationProviderProvenance | null {
  for (let index = record.provenance.length - 1; index >= 0; index -= 1) {
    const entry = record.provenance[index]
    if (
      entry.providerSessionId !== null &&
      (hostId === undefined || provenanceHostId(entry) === hostId)
    ) {
      return entry
    }
  }
  return null
}
