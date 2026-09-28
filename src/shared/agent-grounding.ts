// What a surface may say about an agent before it speaks: where its next turn would run and what
// would run it. Answered by the SAME resolver and the SAME credential check the turn runner uses,
// so the header and context rail cannot drift from the execution path they describe.

import type { Agent } from './agent-types'
import type { ExecutionHostId } from './execution-host'
import type { ProjectHostSetupState } from './project-types'

/** Mirrors the turn runner's location answer. `resolved` is always this computer: the runner only
 *  accepts local setups, and a remote one is refused as `remote-host`. */
export type AgentGroundingLocation =
  | { outcome: 'resolved'; projectId: string; path: string; displayName: string }
  | { outcome: 'no-project' }
  | { outcome: 'unresolved'; projectId: string }
  | { outcome: 'not-ready'; projectId: string; setupState: ProjectHostSetupState }
  // Mirrors the two host outcomes AgentProjectLocation gained on the Workspace branch. The runner
  // executes a resolved-remote turn on that host, so it is a location, not the refusal below.
  | {
      outcome: 'resolved-remote'
      projectId: string
      hostId: `ssh:${string}`
      setupId: string
      path: string
      displayName: string
    }
  | { outcome: 'ambiguous-host'; projectId: string; hostIds: ExecutionHostId[] }
  | { outcome: 'remote-host'; projectId: string; hostId: ExecutionHostId }

/** The driver is named because it is the one conversations actually use today; there is no
 *  per-agent provider binding, and the model is chosen by the provider, never recorded by Orca. */
export type AgentGroundingProvider = {
  driver: 'codex-app-server'
  credential: { state: 'ready' } | { state: 'not-ready'; detail: string }
}

export type AgentGrounding =
  | {
      outcome: 'found'
      agent: Agent
      location: AgentGroundingLocation
      provider: AgentGroundingProvider
    }
  | { outcome: 'agent-missing'; agentId: string }
  | { outcome: 'roster-unreadable'; reason: string }
