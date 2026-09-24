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
//   project-unavailable -> the agent owns a project and we cannot put the provider in it. Nothing
//                      was committed. Running anyway would root the provider somewhere nobody
//                      chose, and an answer about the wrong directory is worse than no answer
//   completed       -> and the durable writes have LANDED, not merely been issued

export type ConversationTurnOutcome =
  | { outcome: 'completed'; turnId: string; providerSessionId: string | null }
  | { outcome: 'busy'; activeTurnId: string }
  | { outcome: 'conversation-absent' }
  | { outcome: 'agent-unavailable'; agentId: string; reason: 'missing' | 'unverifiable' }
  /** `reason` carries the resolver's own answers rather than one flattened failure: each needs its
   *  own sentence and has its own fix. `remote-execution-unavailable` is a project located on a
   *  remote host with no way to run there — refused, never run locally instead. */
  | {
      outcome: 'project-unavailable'
      projectId: string
      reason:
        | 'unresolved'
        | 'not-ready'
        | 'remote-host'
        | 'ambiguous-host'
        | 'remote-execution-unavailable'
        | 'remote-host-unreachable'
        | 'remote-relay-unsupported'
        | 'remote-project-missing'
        | 'location-changed'
      detail: string
    }
  | { outcome: 'auth-required'; detail: string }
  /** The provider cannot run on the host at all: install it, or update it. Not a failed turn. */
  | {
      outcome: 'provider-unavailable'
      reason: 'not-installed' | 'protocol-unsupported'
      detail: string
    }
  | { outcome: 'not-durable'; reason: string }
  /** `cause` names a turn cut off from outside the provider: its deadline, or its host going away. */
  | { outcome: 'failed'; turnId: string; reason: string; cause?: 'timed-out' | 'host-lost' }

/** True when the user's message is in the record even though no answer is. The surface should keep
 *  showing what they typed and explain why it was not answered, rather than clearing the composer
 *  as though nothing happened. */
export function conversationTurnKeptUserMessage(outcome: ConversationTurnOutcome): boolean {
  return (
    outcome.outcome === 'auth-required' ||
    outcome.outcome === 'provider-unavailable' ||
    outcome.outcome === 'failed' ||
    outcome.outcome === 'not-durable'
  )
}
