import { useEffect, useState } from 'react'

import type { AgentGrounding } from '../../../../shared/agent-grounding'

export type AgentGroundingLookup =
  | { status: 'loading' }
  | { status: 'loaded'; grounding: AgentGrounding }
  | { status: 'failed'; reason: string }

/**
 * One read per agent and per `revision` — the page bumps it after each turn, so a setup that
 * became ready or a credential that expired shows up without a poll. A refresh for the SAME agent
 * keeps the last answer on screen; a different agent never inherits it.
 */
export function useAgentGrounding(
  agentId: string | null,
  revision: number
): AgentGroundingLookup | null {
  const [state, setState] = useState<{ agentId: string; lookup: AgentGroundingLookup } | null>(null)

  useEffect(() => {
    if (agentId === null) {
      setState(null)
      return
    }
    let current = true
    setState((previous) =>
      previous?.agentId === agentId && previous.lookup.status === 'loaded'
        ? previous
        : { agentId, lookup: { status: 'loading' } }
    )
    window.api.conversations
      .agentGrounding({ agentId })
      .then((grounding) => {
        if (current) {
          setState({ agentId, lookup: { status: 'loaded', grounding } })
        }
      })
      .catch((error: unknown) => {
        if (current) {
          const reason = error instanceof Error ? error.message : String(error)
          setState({ agentId, lookup: { status: 'failed', reason } })
        }
      })
    return () => {
      current = false
    }
  }, [agentId, revision])

  return state !== null && state.agentId === agentId
    ? state.lookup
    : agentId === null
      ? null
      : { status: 'loading' }
}
