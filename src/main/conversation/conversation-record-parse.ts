// Strict reader for a stored conversation. Refuses; never repairs.
//
// A salvaging reader is wrong here for a specific reason: the caller's next act is usually a
// read-modify-write, so a record "recovered" by defaulting its arrays to empty gets published
// back over the user's messages. A truncated file must therefore fail, loudly, and keep whatever
// is on disk exactly as it is so a later fix can still read it.

import { isAgentId } from '../../shared/agent-identity'
import { isConversationId } from '../../shared/conversation-identity'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  CONVERSATION_TURN_STATES,
  type ConversationId,
  type ConversationLoadResult,
  type ConversationRecord
} from '../../shared/conversation-types'
import { NATIVE_CHAT_ROLES } from '../../shared/native-chat-types'

function unreadable(reason: string): ConversationLoadResult {
  return { outcome: 'unreadable', reason }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function messagesValid(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false
  }
  return value.every(
    (message) =>
      isPlainObject(message) &&
      typeof message.id === 'string' &&
      isFiniteNumber(message.seq) &&
      typeof message.role === 'string' &&
      (NATIVE_CHAT_ROLES as readonly string[]).includes(message.role) &&
      Array.isArray(message.blocks) &&
      (message.timestamp === null || isFiniteNumber(message.timestamp)) &&
      (message.turnId === null || typeof message.turnId === 'string')
  )
}

function turnsValid(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false
  }
  return value.every(
    (turn) =>
      isPlainObject(turn) &&
      typeof turn.turnId === 'string' &&
      isFiniteNumber(turn.seq) &&
      typeof turn.state === 'string' &&
      (CONVERSATION_TURN_STATES as readonly string[]).includes(turn.state) &&
      isFiniteNumber(turn.startedAt) &&
      (turn.endedAt === null || isFiniteNumber(turn.endedAt))
  )
}

function provenanceValid(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false
  }
  return value.every(
    (entry) =>
      isPlainObject(entry) &&
      typeof entry.agent === 'string' &&
      (entry.providerSessionId === null || typeof entry.providerSessionId === 'string') &&
      (entry.transcriptPath === null || typeof entry.transcriptPath === 'string') &&
      isFiniteNumber(entry.observedAt) &&
      // Absent is local (older records); present must be a host id, never an empty stand-in.
      (entry.executionHostId === undefined ||
        (typeof entry.executionHostId === 'string' && entry.executionHostId.length > 0)) &&
      (entry.cwd === undefined || (typeof entry.cwd === 'string' && entry.cwd.length > 0))
  )
}

export function parseConversationRecord(
  raw: string,
  expectedId: ConversationId
): ConversationLoadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // The overwhelmingly likely cause is a torn tail. Either way it is not an empty conversation.
    return unreadable(`record is not valid JSON: ${(error as Error)?.message ?? 'parse failed'}`)
  }
  if (!isPlainObject(parsed)) {
    return unreadable('record is not an object')
  }

  const storedVersion = parsed.schemaVersion
  if (!isFiniteNumber(storedVersion)) {
    return unreadable('record has no usable schemaVersion')
  }
  // A newer build's record is refused rather than read with today's assumptions, and refused
  // distinctly so the caller can say "update Orca" instead of "your conversation is corrupt".
  if (storedVersion > CONVERSATION_RECORD_SCHEMA_VERSION) {
    return { outcome: 'schema-too-new', storedVersion }
  }
  if (storedVersion < CONVERSATION_RECORD_SCHEMA_VERSION) {
    return unreadable(`record predates the first schema version (${storedVersion})`)
  }

  if (!isConversationId(parsed.id)) {
    return unreadable('record carries no Orca conversation id')
  }
  // The filename is not evidence about the contents; a record that disagrees with the id it was
  // asked for has been moved, copied or truncated into place.
  if (parsed.id !== expectedId) {
    return unreadable(`record id ${parsed.id} does not match requested ${expectedId}`)
  }
  if (parsed.status !== 'active' && parsed.status !== 'archived') {
    return unreadable('record has no usable status')
  }
  if (!isFiniteNumber(parsed.createdAt) || !isFiniteNumber(parsed.updatedAt)) {
    return unreadable('record has no usable timestamps')
  }
  if (parsed.title !== null && typeof parsed.title !== 'string') {
    return unreadable('record has an unusable title')
  }
  if (parsed.projectId !== null && typeof parsed.projectId !== 'string') {
    return unreadable('record has an unusable project binding')
  }
  // Absent is the normal state — every conversation written before agents existed, and every
  // Brainstorming chat since. Only a present-but-unreadable binding is a refusal.
  if (parsed.agentId !== undefined && parsed.agentId !== null && !isAgentId(parsed.agentId)) {
    return unreadable('record has an unusable agent binding')
  }
  if (!isFiniteNumber(parsed.nextSeq)) {
    return unreadable('record has no usable ordering watermark')
  }
  if (!provenanceValid(parsed.provenance)) {
    return unreadable('record has unusable provider provenance')
  }
  if (!turnsValid(parsed.turns)) {
    return unreadable('record has unusable turns')
  }
  if (!messagesValid(parsed.messages)) {
    return unreadable('record has unusable messages')
  }

  return { outcome: 'loaded', record: parsed as unknown as ConversationRecord }
}
