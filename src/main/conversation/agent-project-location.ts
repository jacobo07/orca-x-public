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
  /** A ready setup on an ssh host. `path` is a path ON THAT HOST and must never reach a local spawn. */
  | {
      outcome: 'resolved-remote'
      projectId: string
      hostId: `ssh:${string}`
      setupId: string
      path: string
      displayName: string
    }
  /** `projectId: null` is a real choice a person made, not a missing value. Not a refusal. */
  | { outcome: 'no-project' }
  | { outcome: 'unresolved'; projectId: string }
  | {
      outcome: 'not-ready'
      projectId: string
      hostId: ExecutionHostId
      setupState: ProjectHostSetupState
    }
  /** More than one ready remote setup and no local one: choosing by array order would be a
   *  selection nobody decided on, so it is refused until a person (or a stated rule) chooses. */
  | { outcome: 'ambiguous-host'; projectId: string; hostIds: ExecutionHostId[] }
  /** Only host kinds this Orca cannot execute a turn on (runtime environments, today). */
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

  // The rule, in order — never array order: a ready local setup; else exactly one ready ssh setup;
  // else refuse. A remote path is a path on ANOTHER machine, so it is carried as a remote subject
  // and never becomes a local cwd; rooting a provider at a local directory of the same name would
  // answer about something else entirely.
  const kindOf = (setup: ProjectHostSetup) => parseExecutionHostId(setup.hostId)?.kind
  const local = candidates.filter((setup) => kindOf(setup) === 'local')
  const ssh = candidates.filter((setup) => kindOf(setup) === 'ssh')

  const readyLocal = local.find((setup) => setup.setupState === 'ready')
  if (readyLocal) {
    return {
      outcome: 'resolved',
      projectId,
      path: readyLocal.path,
      displayName: readyLocal.displayName
    }
  }

  const readySsh = ssh.filter((setup) => setup.setupState === 'ready')
  if (readySsh.length === 1) {
    const [chosen] = readySsh
    return {
      outcome: 'resolved-remote',
      projectId,
      hostId: chosen.hostId as `ssh:${string}`,
      setupId: chosen.id,
      path: chosen.path,
      displayName: chosen.displayName
    }
  }
  if (readySsh.length > 1) {
    return { outcome: 'ambiguous-host', projectId, hostIds: readySsh.map((setup) => setup.hostId) }
  }

  // Nothing is ready. A setup still on its way is reported before an unsupported host, and a local
  // one before a remote one, because that is the one a person can finish here.
  const pending = local[0] ?? ssh[0]
  if (pending) {
    return {
      outcome: 'not-ready',
      projectId,
      hostId: pending.hostId,
      setupState: pending.setupState
    }
  }
  return { outcome: 'remote-host', projectId, hostId: candidates[0].hostId }
}
