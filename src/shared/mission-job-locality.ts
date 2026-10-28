import type { ProjectHostSetup } from './project-types'

// Registry claim read at call time, not a probe of the host; updatedAt is only a staleness bound, not a measurement time.
export type ProjectSetupClaim = Pick<
  ProjectHostSetup,
  'projectId' | 'hostId' | 'setupState' | 'updatedAt'
>

/** A ready setup older than this is unhydrated for placement; it stays eligible, it just ranks later. */
export const HYDRATED_SETUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Host ids holding a fresh ready setup of the project; any other state, a stale or unreadable
 * update time, or no setup, is not hydrated. A future update time (clock skew) counts as fresh.
 */
export function hydratedAddressesForProject(
  projectId: string,
  setups: readonly ProjectSetupClaim[],
  now: number
): ProjectSetupClaim['hostId'][] {
  const hosts = setups
    .filter(
      (setup) =>
        setup.projectId === projectId &&
        setup.setupState === 'ready' &&
        Number.isFinite(setup.updatedAt) &&
        now - setup.updatedAt <= HYDRATED_SETUP_MAX_AGE_MS
    )
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
