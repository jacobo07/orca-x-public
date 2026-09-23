import type { Agent } from '../../shared/agent-types'
import type { AgentGrounding, AgentGroundingProvider } from '../../shared/agent-grounding'

import type { AgentProjectLocation } from './agent-project-location'
import type { ConversationAgentRoster } from './conversation-service'

export type AgentGroundingDeps = {
  roster: ConversationAgentRoster
  /** The turn runner's own resolver — never a second derivation. */
  resolveProjectLocation: (agent: Agent) => AgentProjectLocation
  /** The turn runner's own credential check. */
  checkAuth: () => Promise<{ ready: true } | { ready: false; detail: string }>
}

export async function readAgentGrounding(
  deps: AgentGroundingDeps,
  agentId: string
): Promise<AgentGrounding> {
  let agents: readonly Agent[]
  try {
    agents = deps.roster.readAgents()
  } catch (error) {
    // Not "missing": an unreadable roster is no evidence the agent is gone.
    return {
      outcome: 'roster-unreadable',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  const agent = agents.find((entry) => entry.id === agentId)
  if (!agent) {
    return { outcome: 'agent-missing', agentId }
  }
  const auth = await deps.checkAuth()
  const provider: AgentGroundingProvider = {
    driver: 'codex-app-server',
    credential: auth.ready ? { state: 'ready' } : { state: 'not-ready', detail: auth.detail }
  }
  return { outcome: 'found', agent, location: deps.resolveProjectLocation(agent), provider }
}
