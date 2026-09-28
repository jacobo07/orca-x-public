import type { WorkspaceAgentRow } from '../../../../shared/cognitive-workspace-projection'
import type { AgentProjectChoice } from '../agents/agent-project-choices'

export type WorkspaceProjectGroup = { choice: AgentProjectChoice; agents: WorkspaceAgentRow[] }

/** Agents whose project is not a live canonical one; each kind keeps its own heading. */
export type WorkspaceOrphanGroup = {
  key: 'none' | 'unknown' | `unresolved:${string}`
  agents: WorkspaceAgentRow[]
}

/**
 * Every canonical project appears — with or without agents — because this tab shows the project
 * estate the Terminals view knows, not the subset that happens to have an agent. Grouping agents
 * only would report an empty estate whenever no agent exists yet.
 */
export function projectWorkspaceProjects(
  choices: readonly AgentProjectChoice[],
  agents: readonly WorkspaceAgentRow[]
): { projects: WorkspaceProjectGroup[]; orphans: WorkspaceOrphanGroup[] } {
  const byProject = new Map<string, WorkspaceAgentRow[]>()
  const orphans = new Map<WorkspaceOrphanGroup['key'], WorkspaceAgentRow[]>()
  const known = new Set(choices.map((choice) => choice.projectId))
  for (const row of agents) {
    const ref = row.project
    if (ref.kind === 'project' && known.has(ref.projectId)) {
      byProject.set(ref.projectId, [...(byProject.get(ref.projectId) ?? []), row])
      continue
    }
    // A project the agent names but the estate no longer holds is "unavailable", not "none".
    const key: WorkspaceOrphanGroup['key'] =
      ref.kind === 'project' || ref.kind === 'unresolved'
        ? `unresolved:${ref.projectId}`
        : ref.kind
    orphans.set(key, [...(orphans.get(key) ?? []), row])
  }
  return {
    projects: choices.map((choice) => ({ choice, agents: byProject.get(choice.projectId) ?? [] })),
    orphans: [...orphans.entries()].map(([key, rows]) => ({ key, agents: rows }))
  }
}
