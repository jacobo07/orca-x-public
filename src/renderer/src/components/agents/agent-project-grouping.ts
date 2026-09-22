import type { Agent } from '../../../../shared/agent-types'
import type { Project } from '../../../../shared/project-types'

/**
 * Agents, grouped by the project that owns them — a DERIVED projection, never stored.
 *
 * Three groups exist and they are not the same thing:
 *
 *   `project`     the agent's projectId resolves to a project we can name.
 *   `none`        the agent chose no project. A real, legal record (`projectId: string | null`),
 *                 not a failure.
 *   `unresolved`  the agent names a project that does not resolve right now.
 *
 * That last one must never be folded into `none`, and must never be hidden. An agent whose owner
 * cannot be found still exists, still has its identity, and may simply be waiting for a repository
 * to be re-added — silently relabelling it "no project" would be this surface inventing an
 * ownership change the user did not make, and hiding it would be losing something that is still
 * there. It keeps its own heading and says so.
 *
 * Nothing here caches. `agents[].projectId` is rewritten by rebuildRepoBackedProjectState when a
 * Project id is promoted (repo: -> git: -> github:), so a Project->Agents map that survived a read
 * would keep pointing at the pre-promotion id and show a ghost under a project that no longer
 * exists under that name.
 */

export type AgentGroup =
  | { kind: 'project'; project: Project; agents: Agent[] }
  | { kind: 'none'; agents: Agent[] }
  | { kind: 'unresolved'; projectId: string; agents: Agent[] }

export function groupAgentsByProject(
  agents: readonly Agent[],
  projects: readonly Project[]
): AgentGroup[] {
  const byId = new Map(projects.map((project) => [project.id, project]))
  const resolved = new Map<string, Agent[]>()
  const unresolved = new Map<string, Agent[]>()
  const none: Agent[] = []

  for (const agent of agents) {
    if (agent.projectId === null) {
      none.push(agent)
      continue
    }
    const bucket = byId.has(agent.projectId) ? resolved : unresolved
    const existing = bucket.get(agent.projectId)
    if (existing) {
      existing.push(agent)
    } else {
      bucket.set(agent.projectId, [agent])
    }
  }

  const groups: AgentGroup[] = []
  // Named projects first, in the order the project list itself uses, so the headings read in the
  // same order as everywhere else in the product rather than in roster order.
  for (const project of projects) {
    const members = resolved.get(project.id)
    if (members) {
      groups.push({ kind: 'project', project, agents: members })
    }
  }
  if (none.length > 0) {
    groups.push({ kind: 'none', agents: none })
  }
  // Last, and present: an agent whose owner is missing is the one a person most needs to see.
  for (const [projectId, members] of unresolved) {
    groups.push({ kind: 'unresolved', projectId, agents: members })
  }
  return groups
}
