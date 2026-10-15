import type { ProjectHostSetup } from './project-types'

// Registry claim read at call time, not a probe of the host; updatedAt is not a measurement time and is deliberately not read.
export type ProjectSetupClaim = Pick<ProjectHostSetup, 'projectId' | 'hostId' | 'setupState'>

/** Host ids holding a ready setup of the project; any other state, or no setup, is not hydrated. */
export function hydratedAddressesForProject(
  projectId: string,
  setups: readonly ProjectSetupClaim[]
): ProjectSetupClaim['hostId'][] {
  const hosts = setups
    .filter((setup) => setup.projectId === projectId && setup.setupState === 'ready')
    .map((setup) => setup.hostId)
  return [...new Set(hosts)]
}

/** Task ids named by a task's deps text; unreadable text yields none, so the task counts as independent. */
export function taskDependencies(depsJson: string | null | undefined): string[] {
  if (!depsJson) {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(depsJson)
  } catch {
    return []
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === 'string')
  ) {
    return []
  }
  return [...parsed]
}
