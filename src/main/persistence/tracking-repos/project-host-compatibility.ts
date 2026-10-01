import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { remapAgentProjectIds } from '../../../shared/agent-project-id-remap'
import {
  carryProjectStateThroughIdentityChange,
  localRepoIdSet
} from '../../../shared/project-identity-succession'
import { remapWorktreeMetaProjectIds } from '../../../shared/worktree-meta-project-id-remap'

/** State the compatibility merge reads and, for the optional dependents, remaps. */
export type ProjectHostSetupCompatibilityState = Pick<
  PersistedState,
  'projects' | 'projectHostSetups'
> &
  Partial<Pick<PersistedState, 'agents' | 'worktreeMeta'>>

function dependentProjectIds(state: ProjectHostSetupCompatibilityState): string {
  return JSON.stringify([
    (state.agents ?? []).map((agent) => agent.projectId),
    Object.entries(state.worktreeMeta ?? {}).map(([id, meta]) => [id, meta.projectId])
  ])
}

export function projectHostSetupCompatibilityStateEqual(
  state: ProjectHostSetupCompatibilityState,
  nextState: ProjectHostSetupCompatibilityState
): boolean {
  return (
    JSON.stringify(state.projects ?? []) === JSON.stringify(nextState.projects) &&
    JSON.stringify(state.projectHostSetups ?? []) === JSON.stringify(nextState.projectHostSetups) &&
    dependentProjectIds(state) === dependentProjectIds(nextState)
  )
}

export function isRepoBackedProjectHostSetup(
  setup: ProjectHostSetup,
  currentRepoIds: ReadonlySet<string>
): boolean {
  const repoId = typeof setup.repoId === 'string' ? setup.repoId : ''
  return repoId.length > 0 && (currentRepoIds.has(repoId) || setup.id === repoId)
}

function projectHostKey(setup: Pick<ProjectHostSetup, 'projectId' | 'hostId'>): string {
  return `${setup.projectId}\u0000${setup.hostId}`
}

export function mergeProjectHostSetupCompatibilityState(
  state: ProjectHostSetupCompatibilityState,
  repos: readonly Repo[]
): ProjectHostSetupCompatibilityState {
  const projection = projectHostSetupProjectionFromRepos(repos)
  const succession = carryProjectStateThroughIdentityChange(
    projection.projects,
    state.projects ?? [],
    localRepoIdSet(repos)
  )
  const currentRepoIds = new Set(repos.map((repo) => repo.id))
  const projectedProjectIds = new Set(projection.projects.map((project) => project.id))
  const projectedSetupIds = new Set(projection.setups.map((setup) => setup.id))
  const projectedHosts = new Set(projection.setups.map(projectHostKey))
  // Why: legacy/repo-backed setup rows reuse the repo id; keep only independent rows so repo deletion leaves no ghosts.
  const independentSetups = (state.projectHostSetups ?? [])
    .filter((setup) => {
      if (projectedSetupIds.has(setup.id)) {
        return false
      }
      return !isRepoBackedProjectHostSetup(setup, currentRepoIds)
    })
    // Why: follow the repo's project through a derived-id change so no ghost project row survives.
    .map((setup) => {
      const remappedProjectId = succession.remappedProjectIds.get(setup.projectId)
      return remappedProjectId ? { ...setup, projectId: remappedProjectId } : setup
    })
    // Why: a project resolves to one setup per host. Once a repo projection covers that
    // pair, a leftover placeholder is a ghost that shadows the ready row — it sorts first
    // and reads back as "not set up". Runs after the remap so renamed rows are caught too.
    .filter((setup) => !projectedHosts.has(projectHostKey(setup)))
  const independentProjectIds = new Set(independentSetups.map((setup) => setup.projectId))
  const independentProjects = (state.projects ?? [])
    .filter(
      (project) => independentProjectIds.has(project.id) && !projectedProjectIds.has(project.id)
    )
    .map((project) => ({
      ...project,
      sourceRepoIds: project.sourceRepoIds.filter((repoId) => currentRepoIds.has(repoId))
    }))
  const { remappedProjectIds } = succession
  return {
    projects: [...succession.projects, ...independentProjects],
    projectHostSetups: [...projection.setups, ...independentSetups],
    // Why: only the dependents the caller handed in are returned, so a load-path spread of this
    // result never overwrites a field with undefined.
    ...(state.agents ? { agents: remapAgentProjectIds(state.agents, remappedProjectIds) } : {}),
    ...(state.worktreeMeta
      ? { worktreeMeta: remapWorktreeMetaProjectIds(state.worktreeMeta, remappedProjectIds) }
      : {})
  }
}

export function makeProjectHostSetupId(
  projectId: string,
  hostId: ExecutionHostId,
  existingIds: ReadonlySet<string>,
  requestedId?: string
): string {
  const baseId = requestedId?.trim() || `${projectId}::${hostId}`
  if (!existingIds.has(baseId)) {
    return baseId
  }
  let suffix = 2
  let candidate = `${baseId}::${suffix}`
  while (existingIds.has(candidate)) {
    suffix++
    candidate = `${baseId}::${suffix}`
  }
  return candidate
}
