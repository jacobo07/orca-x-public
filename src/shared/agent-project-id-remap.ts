import type { Agent } from './agent-types'

/**
 * Moves each agent with its project when a project id was replaced. Returns the same array
 * when nothing moved, so callers can compare by reference.
 *
 * Why one shared function: `remappedProjectIds` is computed on each read and then discarded, so
 * a durable dependent that misses that moment can never catch up. The live store sync, the load
 * path and the profile rebuild all hand the same map here.
 */
export function remapAgentProjectIds<T extends Pick<Agent, 'projectId'>>(
  agents: T[],
  remappedProjectIds: ReadonlyMap<string, string>
): T[] {
  if (remappedProjectIds.size === 0) {
    return agents
  }
  let changed = false
  const remapped = agents.map((agent) => {
    const projectId = agent.projectId ? remappedProjectIds.get(agent.projectId) : undefined
    if (!projectId) {
      return agent
    }
    changed = true
    return { ...agent, projectId }
  })
  return changed ? remapped : agents
}
