// Which conversations a scoped conversations surface shows, and which one it opens first.
//
// One surface serves both Brainstorming and Direct Agent Chat; the scope is the only difference.
// An agent's chats appear under that agent and not under Brainstorming, so a Brainstorming list
// never presents an agent chat as a chat with no one.

import type { ConversationSummary } from '../../../../shared/conversation-summary'

export function conversationsInScope(
  summaries: readonly ConversationSummary[],
  agentId: string | null
): ConversationSummary[] {
  return summaries.filter((summary) => {
    if (summary.outcome !== 'ok') {
      // Unattributable: its agent cannot be read. Kept in Brainstorming so it never vanishes.
      return agentId === null
    }
    return summary.agentId === agentId
  })
}

/** The agent's most recent conversation, or null to start a draft. `summaries` arrive newest first
 *  (sortConversationSummaries), so the first match is the latest. */
export function latestConversationForAgent(
  summaries: readonly ConversationSummary[],
  agentId: string
): string | null {
  const match = summaries.find((summary) => summary.outcome === 'ok' && summary.agentId === agentId)
  return match ? match.id : null
}
