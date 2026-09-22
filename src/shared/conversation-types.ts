// ─── Orca-owned conversation (cross-process, IPC-serializable) ───────────────
// A conversation is a logical Orca entity. Its identity is minted here and is deliberately
// derivable from nothing else: not a pane, leaf, tab, PTY, provider thread, provider session,
// process incarnation or host. Everything those supply is presentation or provenance, and both
// can disappear without the conversation changing.
//
// This is NOT a second message model. Roles and blocks are the existing shared native-chat
// product model so there is one content vocabulary and no translation layer between what is
// rendered and what is stored.
//
// Plain JSON only — these values cross IPC and are written to disk.

import type { ProviderType } from './agent-status-types'
import type { AgentId } from './agent-types'
import {
  NATIVE_CHAT_TURN_LIFECYCLE_STATES,
  type NativeChatBlock,
  type NativeChatRole
} from './native-chat-types'

/** Bump when a stored record's shape changes. A reader that meets a HIGHER version refuses the
 *  record rather than downgrading it — see ConversationLoadResult. */
export const CONVERSATION_RECORD_SCHEMA_VERSION = 1

export const CONVERSATION_ID_PREFIX = 'conv_'

/** Opaque Orca-minted id. Never parsed for meaning, never derived from a transient identifier. */
export type ConversationId = string

/** The durable turn vocabulary EXTENDS the transcript lifecycle rather than shadowing it, so the
 *  two cannot drift: every state the transcript decoder can report is a state a record can hold.
 *  `pending` and `failed` are the two a durable model needs and a live decoder does not — a user
 *  message can be committed before any turn starts, and a turn can end without a completion. */
export const CONVERSATION_TURN_STATES = [
  ...NATIVE_CHAT_TURN_LIFECYCLE_STATES,
  'pending',
  'failed'
] as const
export type ConversationTurnState = (typeof CONVERSATION_TURN_STATES)[number]

/** Turn states that may still change. A record loaded with one of these was interrupted by
 *  something — a crash, a killed provider, a lost final event — and must not read as complete. */
export const CONVERSATION_UNSETTLED_TURN_STATES: readonly ConversationTurnState[] = [
  'pending',
  'working'
]

/** Roles never written to disk. Hidden reasoning is provider-internal: it is not product-visible
 *  state, and persisting it would copy private model internals into a durable Orca artifact. */
export const CONVERSATION_NON_DURABLE_ROLES: readonly NativeChatRole[] = ['reasoning']

export type ConversationStatus = 'active' | 'archived'

/** Evidence that this conversation has been carried by a provider session — continuation material,
 *  never identity. Append-only: a rotation adds an entry, it does not replace the conversation. */
export type ConversationProviderProvenance = {
  agent: ProviderType
  /** The provider's own session/thread id, or null when it never reported one. */
  providerSessionId: string | null
  transcriptPath: string | null
  /** When Orca observed this binding, not when the provider created it. */
  observedAt: number
}

export type ConversationTurn = {
  turnId: string
  /** Orca-assigned ordering identity. Provider timestamps are unreliable across processes. */
  seq: number
  state: ConversationTurnState
  startedAt: number
  /** Null while unsettled. A settled turn always carries one. */
  endedAt: number | null
}

export type ConversationMessage = {
  id: string
  seq: number
  role: NativeChatRole
  blocks: NativeChatBlock[]
  /** Provider timestamp when it supplied one; null sorts before any timestamp. */
  timestamp: number | null
  /** The turn this message belongs to, or null for a message committed outside one. */
  turnId: string | null
}

export type ConversationRecord = {
  schemaVersion: number
  id: ConversationId
  title: string | null
  createdAt: number
  updatedAt: number
  status: ConversationStatus
  /** Project binding, or null for a conversation that belongs to no project. Uses the first-class
   *  Project id — this does not mint a chat-specific project concept. */
  projectId: string | null
  /**
   * The Agent this conversation is with, or absent/null for a Brainstorming chat that is with no
   * persistent actor. Optional at schemaVersion 1 ON PURPOSE: a bump would make
   * conversation-record-parse refuse every existing record as `unreadable`, i.e. tell every user
   * their history is corrupt. Old builds preserve it on a read-modify-write because the parser
   * passes unknown keys through and the store stringifies the object it was handed.
   *
   * A conversation deliberately does NOT carry its own project: the agent owns that relation, and
   * only PersistedState can participate in Project id succession. Deriving it keeps one owner and
   * makes an agent/conversation project mismatch unrepresentable rather than merely validated.
   */
  agentId?: AgentId | null
  provenance: ConversationProviderProvenance[]
  turns: ConversationTurn[]
  messages: ConversationMessage[]
  /** Next ordering value. Held on the record so ordering survives a restart; deriving it from
   *  max(seq) would reuse a number after a truncation dropped the tail. */
  nextSeq: number
}

/** Reading a conversation has four outcomes, and collapsing any two of them lies to the caller.
 *  In particular `unreadable` must never render as an empty conversation: that turns a transient
 *  read failure into apparent data loss, and a read-modify-write would then publish the emptiness. */
export type ConversationLoadResult =
  | { outcome: 'loaded'; record: ConversationRecord }
  | { outcome: 'absent' }
  | { outcome: 'unreadable'; reason: string }
  | { outcome: 'schema-too-new'; storedVersion: number }

export function isConversationTurnSettled(state: ConversationTurnState): boolean {
  return !CONVERSATION_UNSETTLED_TURN_STATES.includes(state)
}

export function isDurableConversationRole(role: NativeChatRole): boolean {
  return !CONVERSATION_NON_DURABLE_ROLES.includes(role)
}
