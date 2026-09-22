// Where an agent's turn runs, decided by the agent's own project.
//
// An Agent declares a project (`agent-types.ts`). This is the one place that declaration becomes a
// working directory, and it is resolved at the authority boundary — in main, from the durable
// roster and the durable setups — never reconstructed from whatever the UI happened to be showing.
// A Project A agent must receive Project A's directory while the window is focused on Project B.
//
// WHY THIS FOLLOWS SUCCESSION INSTEAD OF PINNING, which is the opposite of the neighbouring rule in
// `automations/run-target-resolution.ts`:
//
//   An automation pins repoId/hostId/path captured at creation and REFUSES when they drift, because
//   a schedule that silently retargets is a schedule nobody authorized.
//
//   An agent is a long-lived actor whose project identity is MEANT to track promotion. Its
//   `projectId` is a derived replaceable key (`repo:` -> `git:` -> `github:`) that
//   `rebuildRepoBackedProjectState` rewrites on the agent record itself, so reading it through the
//   live roster per call — exactly as `agentFor` already does — is what keeps a pre-promotion id
//   from stranding an agent from its own project. Pinning here would strand it; following there
//   would retarget a schedule. Two different laws because they answer two different questions.
//
// Every refusal below is its own answer. They are not interchangeable: "you own no project",
// "your project is gone", "your project is still setting up" and "your project lives on a remote
// host" need four different sentences and have four different fixes. Collapsing them — or, worse,
// falling back to a directory nobody chose — is the defect this module exists to make unreachable.

import type { Agent } from '../../shared/agent-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { ProjectHostSetup, ProjectHostSetupState } from '../../shared/project-types'

export type AgentProjectLocation =
  /** The agent's project has a ready local setup. `path` is where its turn runs. */
  | { outcome: 'resolved'; projectId: string; path: string; displayName: string }
  /** `projectId: null` is a real choice a person made, not a missing value. Not a refusal. */
  | { outcome: 'no-project' }
  | { outcome: 'unresolved'; projectId: string }
  | { outcome: 'not-ready'; projectId: string; setupState: ProjectHostSetupState }
  | { outcome: 'remote-host'; projectId: string; hostId: ExecutionHostId }

/** Narrow by design, matching `ConversationAgentRoster`: this module may ASK for the setups and
 *  owns nothing. Read per call so a setup that became ready is visible without a restart. */
export type ProjectLocationReader = {
  readProjectHostSetups: () => readonly ProjectHostSetup[]
}

export function resolveAgentProjectLocation(
  agent: Pick<Agent, 'projectId'>,
  reader: ProjectLocationReader
): AgentProjectLocation {
  const projectId = agent.projectId
  if (projectId === null) {
    return { outcome: 'no-project' }
  }

  const candidates = reader.readProjectHostSetups().filter((setup) => setup.projectId === projectId)
  if (candidates.length === 0) {
    return { outcome: 'unresolved', projectId }
  }

  // Local only. A turn runs as a child of THIS process, so an ssh or runtime setup's path is a path
  // on a machine this process cannot reach — using it would root the provider at a local directory
  // that either does not exist or, far worse, happens to exist and is something else entirely.
  const local = candidates.filter((setup) => parseExecutionHostId(setup.hostId)?.kind === 'local')
  if (local.length === 0) {
    return { outcome: 'remote-host', projectId, hostId: candidates[0].hostId }
  }

  const ready = local.find((setup) => setup.setupState === 'ready')
  if (!ready) {
    return { outcome: 'not-ready', projectId, setupState: local[0].setupState }
  }

  return {
    outcome: 'resolved',
    projectId,
    path: ready.path,
    displayName: ready.displayName
  }
}
