// Which pane is currently showing which conversation.
//
// Runtime-only by construction: this registry has no reader, writer or path into the durable
// store, so an attachment cannot become persisted state by accident. That is the design
// statement, not an omission — a pane key surviving a restart is exactly how presentation
// identity leaks back into logical identity.
//
// A conversation with no attachment is normal and complete. It is not closed, not lost, and not
// pending: nothing is currently showing it.

import type { ConversationId } from './conversation-types'

export type ConversationAttachment = {
  conversationId: ConversationId
  /** Composite `${tabId}:${leafId}` — the same pane key the native-chat resolver uses. */
  paneKey: string
}

export class ConversationPresentationAttachments {
  private readonly byConversation = new Map<ConversationId, string>()
  private readonly byPane = new Map<string, ConversationId>()

  /** Bind a conversation to a pane. A conversation holds at most one attachment and a pane shows
   *  at most one conversation, so this displaces both prior bindings rather than stacking. */
  attach(conversationId: ConversationId, paneKey: string): void {
    const previousPane = this.byConversation.get(conversationId)
    if (previousPane !== undefined && previousPane !== paneKey) {
      this.byPane.delete(previousPane)
    }
    const previousConversation = this.byPane.get(paneKey)
    if (previousConversation !== undefined && previousConversation !== conversationId) {
      this.byConversation.delete(previousConversation)
    }
    this.byConversation.set(conversationId, paneKey)
    this.byPane.set(paneKey, conversationId)
  }

  /** Release the conversation's presentation. The conversation is untouched — this object cannot
   *  reach the store, so "the pane went away" can never mean "the conversation went away". */
  detachConversation(conversationId: ConversationId): void {
    const paneKey = this.byConversation.get(conversationId)
    if (paneKey === undefined) {
      return
    }
    this.byConversation.delete(conversationId)
    this.byPane.delete(paneKey)
  }

  /** Pane teardown. Same guarantee in the other direction. */
  detachPane(paneKey: string): void {
    const conversationId = this.byPane.get(paneKey)
    if (conversationId === undefined) {
      return
    }
    this.byPane.delete(paneKey)
    this.byConversation.delete(conversationId)
  }

  paneFor(conversationId: ConversationId): string | null {
    return this.byConversation.get(conversationId) ?? null
  }

  conversationFor(paneKey: string): ConversationId | null {
    return this.byPane.get(paneKey) ?? null
  }

  isAttached(conversationId: ConversationId): boolean {
    return this.byConversation.has(conversationId)
  }

  list(): ConversationAttachment[] {
    return [...this.byConversation].map(([conversationId, paneKey]) => ({
      conversationId,
      paneKey
    }))
  }
}
