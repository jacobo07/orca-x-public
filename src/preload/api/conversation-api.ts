import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import type { ConversationSummary } from '../../shared/conversation-summary'
import type { ConversationTurnOutcome } from '../../shared/conversation-turn'
import type {
  ConversationForAgentResult,
  ConversationLoadResult,
  ConversationRecord
} from '../../shared/conversation-types'

export type ConversationTurnEventPayload = {
  conversationId: string
  event: AgentTurnEvent
}

/**
 * Orca conversations: durable, Orca-owned, and independent of any pane, PTY or provider thread.
 *
 * Deliberately narrow. There is no write-file, no ordering watermark and no compare-and-swap here —
 * main owns the durability, and a renderer able to send the fence's input could defeat the fence.
 *
 * `read` and `sendTurn` answer OUTCOMES rather than throwing: "this record is corrupt", "you are
 * not signed in" and "this record is not here" are different things to tell a user, and none of
 * them is an exception.
 *
 * There is deliberately no `cancel`. The provider exposes `turn/interrupt` and Orca has no call
 * site for it, so a Stop control would be a button that does nothing. The gap is named rather than
 * papered over.
 */
export type ConversationApi = {
  conversations: {
    list: () => Promise<ConversationSummary[]>
    create: (args: {
      title?: string | null
      projectId?: string | null
    }) => Promise<ConversationRecord>
    /** The agent path takes no project: the agent owns it. Refusals are outcomes, not throws. */
    createForAgent: (args: {
      agentId: string
      title?: string | null
    }) => Promise<ConversationForAgentResult>
    read: (args: { id: string }) => Promise<ConversationLoadResult>
    sendTurn: (args: {
      id: string
      text: string
      cwd: string
    }) => Promise<ConversationTurnOutcome>
    /** Live turn stream. Deltas arrive here and are never persisted; the durable record carries
     *  only settled messages. Returns an unsubscribe. */
    onTurnEvent: (callback: (payload: ConversationTurnEventPayload) => void) => () => void
  }
}
