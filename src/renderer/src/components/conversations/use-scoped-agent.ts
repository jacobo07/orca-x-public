import { useEffect, useState } from 'react'

import type { Agent } from '../../../../shared/agent-types'

/** "Not found" and "could not read the roster" stay apart: the second is not evidence the agent is
 *  gone, and saying it is would send someone to recreate an agent that still exists. */
export type ScopedAgentLookup =
  | { status: 'loading' }
  | { status: 'found'; agent: Agent }
  | { status: 'missing'; agentId: string }
  | { status: 'failed'; reason: string }

/** Read through main's roster, once per scope — one-shot, no subscription, no poll. */
export function useScopedAgent(agentId: string | null): ScopedAgentLookup | null {
  const [lookup, setLookup] = useState<ScopedAgentLookup | null>(null)

  useEffect(() => {
    if (agentId === null) {
      setLookup(null)
      return
    }
    let current = true
    setLookup({ status: 'loading' })
    window.api.agents
      .list()
      .then((agents) => {
        if (!current) return
        const agent = agents.find((entry) => entry.id === agentId)
        setLookup(agent ? { status: 'found', agent } : { status: 'missing', agentId })
      })
      .catch((error: unknown) => {
        if (!current) return
        setLookup({ status: 'failed', reason: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      current = false
    }
  }, [agentId])

  return lookup
}
