// Why a turn ran where it ran — or why it did not — as one record per turn. The chain a future
// engineer needs: agent, conversation, project, host, setup, directory, provider thread, the
// authority that executed it, and the outcome with its reason.
//
// Deliberately absent: the user's words, the provider's answer, environment and credentials. The
// trace answers WHERE and WHY, never WHAT was said, so it is safe to write to a log.

import type { ConversationTurnOutcome } from '../../shared/conversation-turn'

export type TurnAuthority = 'local' | 'ssh-relay'

/** Filled in by the runner as each link of the chain is decided. */
export type ConversationTurnTraceDraft = {
  conversationId: string
  agentId: string | null
  projectId: string | null
  hostId: string | null
  setupId: string | null
  path: string | null
  authority: TurnAuthority | null
  providerSessionId: string | null
}

export type ConversationTurnTrace = ConversationTurnTraceDraft & {
  provider: 'codex'
  outcome: ConversationTurnOutcome['outcome']
  reason: string | null
}

export function draftTurnTrace(conversationId: string): ConversationTurnTraceDraft {
  return {
    conversationId,
    agentId: null,
    projectId: null,
    hostId: null,
    setupId: null,
    path: null,
    authority: null,
    providerSessionId: null
  }
}

/** The outcome's own reason code or words; never message content. */
function reasonOf(outcome: ConversationTurnOutcome): string | null {
  switch (outcome.outcome) {
    case 'project-unavailable':
    case 'agent-unavailable':
    case 'provider-unavailable':
    case 'not-durable':
    case 'failed':
      return outcome.reason
    case 'auth-required':
      return 'auth-required'
    case 'busy':
    case 'conversation-absent':
    case 'completed':
      return null
  }
}

export function completeTurnTrace(
  draft: ConversationTurnTraceDraft,
  outcome: ConversationTurnOutcome
): ConversationTurnTrace {
  return {
    ...draft,
    provider: 'codex',
    outcome: outcome.outcome,
    reason: reasonOf(outcome),
    providerSessionId:
      outcome.outcome === 'completed' ? outcome.providerSessionId : draft.providerSessionId
  }
}
