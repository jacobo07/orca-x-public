// The result of asking a conversation for a turn. Plain JSON — this crosses IPC, and it lives in
// shared rather than in main because preload and the renderer both have to name it.
//
// Six outcomes and not a nullable success. Every one of these needs a different sentence in front
// of a user, and four of them are routinely collapsed into "something went wrong":
//
//   busy            -> you already have a turn running here
//   auth-required   -> sign the provider in. A 401 is NOT a conversation, and never an empty
//                      assistant message
//   not-durable     -> the provider answered and the answer did not reach disk. The one state that
//                      must never render as ordinary success
//   failed          -> the provider died, or ended without settling the turn
//   conversation-absent -> nothing to append to; nothing was spent
//   agent-unavailable -> this chat is with an agent that cannot be found (or checked). Nothing was
//                      committed; running it as Brainstorming would be the lie
//   completed       -> and the durable writes have LANDED, not merely been issued

export type ConversationTurnOutcome =
  | { outcome: 'completed'; turnId: string; providerSessionId: string | null }
  | { outcome: 'busy'; activeTurnId: string }
  | { outcome: 'conversation-absent' }
  | { outcome: 'agent-unavailable'; agentId: string; reason: 'missing' | 'unverifiable' }
  | { outcome: 'auth-required'; detail: string }
  | { outcome: 'not-durable'; reason: string }
  | { outcome: 'failed'; turnId: string; reason: string }

/** True when the user's message is in the record even though no answer is. The surface should keep
 *  showing what they typed and explain why it was not answered, rather than clearing the composer
 *  as though nothing happened. */
export function conversationTurnKeptUserMessage(outcome: ConversationTurnOutcome): boolean {
  return (
    outcome.outcome === 'auth-required' ||
    outcome.outcome === 'failed' ||
    outcome.outcome === 'not-durable'
  )
}
