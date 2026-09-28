// Presents a durable Orca conversation as the session NativeChat already knows how to render.
//
// This is the whole reason W3 does not need a second message renderer. NativeChat's DATA layer is
// pane- and PTY-coupled (pane resolution, leaf routing, a PTY send queue), but its PRESENTATION —
// markdown, tool cards, diffs, grouping, virtualization — asks only for a session shape. A durable
// record plus the live stream is exactly that shape, so the conversation surface reuses the proven
// renderer instead of growing a parallel one that will drift from it.

import type {
  NativeChatMessage,
  NativeChatSessionStatus
} from '../../../../shared/native-chat-types'
import type { ConversationRecord } from '../../../../shared/conversation-types'
import type { NativeChatLiveSession } from '../native-chat/use-native-chat-live-session'

import type { ConversationLiveState } from './conversation-live-state'

export type ConversationSessionInput = {
  record: ConversationRecord | null
  live: ConversationLiveState
  /** The initial read is still in flight. Distinct from an empty conversation: an empty list during
   *  a read would otherwise render as "no messages" for a conversation that has plenty. */
  loading: boolean
  /** The record could not be read. Never rendered as an empty conversation — that turns a transient
   *  failure into apparent data loss. */
  readError: string | null
}

function durableMessages(record: ConversationRecord): NativeChatMessage[] {
  return record.messages.map((message) => ({
    id: message.id,
    role: message.role,
    blocks: message.blocks,
    timestamp: message.timestamp,
    // The record IS the transcript here: Orca wrote it, and it outranks a scrape or a hook.
    source: 'transcript',
    ...(message.turnId !== null ? { turnId: message.turnId } : {})
  }))
}

/** The sentence currently being typed, as a message the renderer can show. It is not in the record
 *  and never will be — only the settled version is durable. */
function streamingMessages(
  live: ConversationLiveState,
  durableIds: ReadonlySet<string>
): NativeChatMessage[] {
  return Object.entries(live.streamingByItemId)
    // Defensive: the live state drops a stream when its message settles, so this should already be
    // empty. If both ever existed, the durable one wins and the half-written one is not shown
    // beside it.
    .filter(([itemId]) => !durableIds.has(itemId))
    .map(([itemId, text]) => ({
      id: itemId,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text }],
      timestamp: null,
      source: 'transcript' as const
    }))
}

function statusFor(input: ConversationSessionInput, messageCount: number): NativeChatSessionStatus {
  if (input.readError !== null) {
    return 'error'
  }
  if (input.loading) {
    return 'loading'
  }
  if (input.live.turnState === 'working') {
    return 'working'
  }
  return messageCount === 0 ? 'empty' : 'ready'
}

export function conversationToNativeChatSession(
  input: ConversationSessionInput
): NativeChatLiveSession {
  const durable = input.record ? durableMessages(input.record) : []
  const durableIds = new Set(durable.map((message) => message.id))
  const messages = [...durable, ...streamingMessages(input.live, durableIds)]

  const latestBinding = input.record?.provenance.filter(
    (entry) => entry.providerSessionId !== null
  )
  const sessionId = latestBinding?.at(-1)?.providerSessionId ?? null

  return {
    messages,
    status: statusFor(input, messages.length),
    // The PROVIDER's id, surfaced as provenance for display only. The conversation's own identity
    // is the record id and is deliberately not what this field carries.
    sessionId,
    agent: 'codex',
    ...(input.readError !== null ? { error: input.readError } : {}),
    // A conversation record is read whole: there is no older page to fetch, so paging is inert
    // rather than pretending there is more history behind a scroll.
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: () => {},
    readPhase: input.readError !== null ? 'error' : input.loading ? 'loading' : 'ready'
  }
}
