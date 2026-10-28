import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import {
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from '../../../shared/project-host-setup-projection'
import type { AppState } from './types'
import { normalizeHydratedProjectHostSetupProjection } from './project-host-setup-selector-normalization'

const projectHostSetupProjectionCache = new WeakMap<AppState['repos'], ProjectHostSetupProjection>()
const providedProjectHostSetupProjectionCache = new WeakMap<
  AppState['repos'],
  WeakMap<Project[], WeakMap<ProjectHostSetup[], ProjectHostSetupProjection>>
>()
const mergedProjectHostSetupProjectionCache = new WeakMap<
  AppState['repos'],
  WeakMap<Project[], WeakMap<ProjectHostSetup[], ProjectHostSetupProjection>>
>()
const normalizedProjectHostSetupProjectionCache = new WeakMap<
  AppState['repos'],
  WeakMap<Project[], WeakMap<ProjectHostSetup[], ProjectHostSetupProjection>>
>()

function getCachedProjectHostSetupProjection(repos: AppState['repos']): ProjectHostSetupProjection {
  const cachedProjection = projectHostSetupProjectionCache.get(repos)
  if (cachedProjection) {
    return cachedProjection
  }

  const projection = projectHostSetupProjectionFromRepos(repos)
  projectHostSetupProjectionCache.set(repos, projection)
  return projection
}

function getCachedProvidedProjectHostSetupProjection(
  repos: AppState['repos'],
  projects: Project[],
  setups: ProjectHostSetup[]
): ProjectHostSetupProjection {
  const cachedByProjects = providedProjectHostSetupProjectionCache.get(repos)
  const cachedBySetups = cachedByProjects?.get(projects)
  const cachedProjection = cachedBySetups?.get(setups)
  if (cachedProjection) {
    return cachedProjection
  }

  // Why: a collision is a fact about the repo set, so it rides every branch, not only the derived one.
  const projection = {
    projects,
    setups,
    identityCollisions: getCachedProjectHostSetupProjection(repos).identityCollisions
  }
  const nextCachedByProjects =
    cachedByProjects ??
    new WeakMap<Project[], WeakMap<ProjectHostSetup[], ProjectHostSetupProjection>>()
  const nextCachedBySetups =
    cachedBySetups ?? new WeakMap<ProjectHostSetup[], ProjectHostSetupProjection>()
  nextCachedBySetups.set(setups, projection)
  if (!cachedBySetups) {
    nextCachedByProjects.set(projects, nextCachedBySetups)
  }
  if (!cachedByProjects) {
    providedProjectHostSetupProjectionCache.set(repos, nextCachedByProjects)
  }
  return projection
}

function mergeById<T extends { id: string }>(base: readonly T[], overlay: readonly T[]): T[] {
  const merged = [...base]
  const indexById = new Map(merged.map((entry, index) => [entry.id, index]))
  for (const entry of overlay) {
    const index = indexById.get(entry.id)
    if (index === undefined) {
      indexById.set(entry.id, merged.length)
      merged.push(entry)
    } else {
      merged[index] = entry
    }
  }
  return merged
}

function mergeProjectHostSetupProjection(
  repos: AppState['repos'],
  projects: Project[],
  setups: ProjectHostSetup[]
): ProjectHostSetupProjection {
  const cachedByProjects = mergedProjectHostSetupProjectionCache.get(repos)
  const cachedBySetups = cachedByProjects?.get(projects)
  const cachedProjection = cachedBySetups?.get(setups)
  if (cachedProjection) {
    return cachedProjection
  }
  const derived = getCachedProjectHostSetupProjection(repos)
  const normalized = normalizeHydratedProjectHostSetupProjection(repos, projects, setups, derived)
  // Why: older runtimes/profiles may hydrate empty or partial project/setup arrays
  // beside legacy repos. Keep repo-backed compatibility rows visible in that case.
  const projection = {
    projects: mergeById(derived.projects, normalized.projects),
    setups: mergeById(derived.setups, normalized.setups),
    identityCollisions: derived.identityCollisions
  }
  const nextCachedByProjects =
    cachedByProjects ??
    new WeakMap<Project[], WeakMap<ProjectHostSetup[], ProjectHostSetupProjection>>()
  const nextCachedBySetups =
    cachedBySetups ?? new WeakMap<ProjectHostSetup[], ProjectHostSetupProjection>()
  nextCachedBySetups.set(setups, projection)
  if (!cachedBySetups) {
    nextCachedByProjects.set(projects, nextCachedBySetups)
  }
  if (!cachedByProjects) {
    mergedProjectHostSetupProjectionCache.set(repos, nextCachedByProjects)
  }
  return projection
}

function getCachedNormalizedProjectHostSetupProjection(
  repos: AppState['repos'],
  projects: Project[],
  setups: ProjectHostSetup[],
  derived: ProjectHostSetupProjection,
  normalized: ProjectHostSetupProjection
): ProjectHostSetupProjection {
  const cachedByProjects = normalizedProjectHostSetupProjectionCache.get(repos)
  const cachedBySetups = cachedByProjects?.get(projects)
  const cachedProjection = cachedBySetups?.get(setups)
  if (cachedProjection) {
    return cachedProjection
  }
  const projection = {
    projects: mergeById(derived.projects, normalized.projects),
    setups: mergeById(derived.setups, normalized.setups),
    identityCollisions: derived.identityCollisions
  }
  const nextCachedByProjects =
    cachedByProjects ??
    new WeakMap<Project[], WeakMap<ProjectHostSetup[], ProjectHostSetupProjection>>()
  const nextCachedBySetups =
    cachedBySetups ?? new WeakMap<ProjectHostSetup[], ProjectHostSetupProjection>()
  nextCachedBySetups.set(setups, projection)
  if (!cachedBySetups) {
    nextCachedByProjects.set(projects, nextCachedBySetups)
  }
  if (!cachedByProjects) {
    normalizedProjectHostSetupProjectionCache.set(repos, nextCachedByProjects)
  }
  return projection
}

export function getProjectHostSetupProjectionFromState(
  state: Pick<AppState, 'repos'> & Partial<Pick<AppState, 'projects' | 'projectHostSetups'>>
): ProjectHostSetupProjection {
  if (state.projects && state.projectHostSetups) {
    const repoIds = new Set(state.repos.map((repo) => repo.id))
    const coveredRepoIds = new Set<string>()
    for (const setup of state.projectHostSetups) {
      const repoId = typeof setup.repoId === 'string' ? setup.repoId : ''
      if (repoIds.has(repoId)) {
        coveredRepoIds.add(repoId)
      }
      if (repoIds.has(setup.id)) {
        coveredRepoIds.add(setup.id)
      }
    }
    if (state.repos.length > 0 && coveredRepoIds.size < repoIds.size) {
      return mergeProjectHostSetupProjection(
        state.repos,
        state.projects as Project[],
        state.projectHostSetups as ProjectHostSetup[]
      )
    }
    const derived = getCachedProjectHostSetupProjection(state.repos)
    const normalized = normalizeHydratedProjectHostSetupProjection(
      state.repos,
      state.projects as Project[],
      state.projectHostSetups as ProjectHostSetup[],
      derived
    )
    if (normalized.changed) {
      // Why: this is a zustand selector compared with Object.is, so the merged
      // result must be reference-stable per (repos, projects, setups) input or
      // every render returns a fresh object and triggers a re-render storm.
      return getCachedNormalizedProjectHostSetupProjection(
        state.repos,
        state.projects as Project[],
        state.projectHostSetups as ProjectHostSetup[],
        derived,
        normalized
      )
    }
    return getCachedProvidedProjectHostSetupProjection(
      state.repos,
      state.projects as Project[],
      state.projectHostSetups as ProjectHostSetup[]
    )
  }
  return getCachedProjectHostSetupProjection(state.repos)
}
