// What a conversation list row carries. Plain JSON — this crosses IPC.
//
// A summary is a THREE-outcome value on purpose. Listing conversations reads records that may be
// truncated, half-written or written by a newer Orca, and the tempting shape — a flat row type plus
// a silent `.filter(Boolean)` — makes a record the user can see on disk vanish from the product
// with no way to ask why. A row that says "this one could not be read" is recoverable; a row that
// was never emitted is indistinguishable from a conversation that never existed.

import type { ConversationId, ConversationTurnState } from './conversation-types'

export type ConversationSummary =
  | {
      outcome: 'ok'
      id: ConversationId
      title: string | null
      createdAt: number
      updatedAt: number
      projectId: string | null
      /** The agent this conversation is with, or null for Brainstorming. */
      agentId: string | null
      messageCount: number
      /** State of the most recent turn, or null when nothing has been asked yet. */
      lastTurnState: ConversationTurnState | null
    }
  | { outcome: 'unreadable'; id: ConversationId; reason: string }
  | { outcome: 'schema-too-new'; id: ConversationId; storedVersion: number }

export function isReadableConversationSummary(
  summary: ConversationSummary
): summary is Extract<ConversationSummary, { outcome: 'ok' }> {
  return summary.outcome === 'ok'
}

/** Newest activity first, and unreadable rows sort last rather than being dropped — they have no
 *  timestamp to sort by, and putting them at the top would make a corrupt record the first thing
 *  the user sees every time they open the surface. */
export function sortConversationSummaries(
  summaries: readonly ConversationSummary[]
): ConversationSummary[] {
  return [...summaries].sort((left, right) => {
    const leftAt = left.outcome === 'ok' ? left.updatedAt : -1
    const rightAt = right.outcome === 'ok' ? right.updatedAt : -1
    if (leftAt !== rightAt) {
      return rightAt - leftAt
    }
    return left.id.localeCompare(right.id)
  })
}
