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
  /**
   * The execution host the provider thread lives on. A thread's history exists only on its host,
   * so a turn resumes only a thread recorded for the host it runs on. Optional at schemaVersion 1
   * on purpose — a bump would make every existing record unreadable — and ABSENT MEANS LOCAL,
   * which is what every record written before remote turns existed actually was.
   */
  executionHostId?: string
  /** The directory the thread was bound to on that host. Absent (older records) is UNKNOWN, so the
   *  next resume asks the provider to confirm the location rather than assuming it did not move. */
  cwd?: string
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
  /** Project binding for a Brainstorming chat, or null. Always null on an agent-bound record: there
   *  the agent owns the project (see `agentId`). No production caller sets it today — the wire
   *  accepts it and nothing sends it. */
  projectId: string | null
  /**
   * The Agent this conversation is with, or absent/null for a Brainstorming chat that is with no
   * persistent actor. Optional at schemaVersion 1 ON PURPOSE: a bump would make
   * conversation-record-parse refuse every existing record as `unreadable`, i.e. tell every user
   * their history is corrupt. Old builds preserve it on a read-modify-write because the parser
   * passes unknown keys through and the store stringifies the object it was handed.
   *
   * Written only by `ConversationService.createForAgent`, which takes no project: the agent owns
   * that relation and only PersistedState participates in Project id succession, so the effective
   * project is read through the roster (`agentFor`) and the record holds no second value to disagree.
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

/** Creating a conversation with an agent can be refused, and the two refusals mean different
 *  things: the agent is gone (pick another) versus this side could not check (a defect, not theirs). */
export type ConversationForAgentResult =
  | { outcome: 'created'; record: ConversationRecord }
  | { outcome: 'agent-not-found'; agentId: AgentId }
  | { outcome: 'agent-unverifiable' }

export function isConversationTurnSettled(state: ConversationTurnState): boolean {
  return !CONVERSATION_UNSETTLED_TURN_STATES.includes(state)
}

export function isDurableConversationRole(role: NativeChatRole): boolean {
  return !CONVERSATION_NON_DURABLE_ROLES.includes(role)
}
