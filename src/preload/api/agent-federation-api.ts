import type { AgentFederationView, GateDecisionView } from '../../shared/agent-federation-view'

/**
 * An agent's reviews and approvals. Deciding sends back the revision and patch hash the person was
 * shown, so the decision covers exactly what was on screen; main re-reads git before accepting it.
 */
export type AgentFederationApi = {
  agentFederation: {
    view: (args: { agentId: string }) => Promise<AgentFederationView>
    decide: (args: {
      gateId: string
      decision: 'approved' | 'rejected'
      revision: string
      patchHash: string
    }) => Promise<GateDecisionView>
    /** Point a pending approval at the commit the worktree holds now; authorizes nothing. */
    rebind: (args: { gateId: string }) => Promise<GateDecisionView>
  }
}
