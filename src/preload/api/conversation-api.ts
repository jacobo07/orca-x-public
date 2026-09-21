import type { ConversationSummary } from '../../shared/conversation-summary'
import type { ConversationLoadResult, ConversationRecord } from '../../shared/conversation-types'

/**
 * Orca conversations: durable, Orca-owned, and independent of any pane, PTY or provider thread.
 *
 * Deliberately narrow. There is no write-file, no ordering watermark and no compare-and-swap here —
 * main owns the durability, and a renderer able to send the fence's input could defeat the fence.
 *
 * `read` answers an outcome rather than throwing, because "this record is corrupt" and "this record
 * is not here" are different things to tell a user and neither is an exception.
 */
export type ConversationApi = {
  conversations: {
    list: () => Promise<ConversationSummary[]>
    create: (args: { title?: string | null; projectId?: string | null }) => Promise<ConversationRecord>
    read: (args: { id: string }) => Promise<ConversationLoadResult>
  }
}
