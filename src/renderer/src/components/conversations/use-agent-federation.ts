import { useCallback, useEffect, useState } from 'react'
import type { AgentFederationView, GateDecisionView } from '../../../../shared/agent-federation-view'

export type AgentFederationLookup =
  | { status: 'loading' }
  | { status: 'loaded'; view: AgentFederationView }
  | { status: 'failed'; reason: string }

/** Read when the agent changes and after each decision; no polling — a stale row is judged again
 *  by main on the next read, and approving always re-checks git in main before it is accepted. */
export function useAgentFederation(agentId: string | null): {
  lookup: AgentFederationLookup | null
  refresh: () => void
  decide: (input: { gateId: string; decision: 'approved' | 'rejected'; revision: string; patchHash: string }) => Promise<GateDecisionView>
  rebind: (gateId: string) => Promise<GateDecisionView>
} {
  const [lookup, setLookup] = useState<AgentFederationLookup | null>(null)
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => setGeneration((value) => value + 1), [])

  useEffect(() => {
    if (!agentId) {
      setLookup(null)
      return
    }
    let live = true
    setLookup({ status: 'loading' })
    window.api.agentFederation
      .view({ agentId })
      .then((view) => live && setLookup({ status: 'loaded', view }))
      .catch((error: unknown) => live && setLookup({ status: 'failed', reason: String(error) }))
    return () => {
      live = false
    }
  }, [agentId, generation])

  const decide = useCallback(
    async (input: { gateId: string; decision: 'approved' | 'rejected'; revision: string; patchHash: string }) => {
      const outcome = await window.api.agentFederation.decide(input)
      refresh()
      return outcome
    },
    [refresh]
  )
  const rebind = useCallback(
    async (gateId: string) => {
      const outcome = await window.api.agentFederation.rebind({ gateId })
      refresh()
      return outcome
    },
    [refresh]
  )
  return { lookup, refresh, decide, rebind }
}
