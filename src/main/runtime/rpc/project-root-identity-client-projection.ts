import {
  projectIdentityCollisionsFromEligibility,
  type ProjectIdentityCollision
} from '../../../shared/project-identity-collisions'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import {
  buildRootIdentityEligibility,
  ROOT_PROJECT_ID_PREFIX
} from '../../../shared/project-root-identity-key'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import { PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { Repo } from '../../../shared/repo-types'
import {
  deriveReplicaTopology,
  type ProjectHostSetupWithReplicaTopology
} from '../../../shared/replica-topology'
import type { ReplicaRelation } from '../../../shared/workspace-replica-state'
import type { TaskSourceContext, WorkspaceRunContext } from '../../../shared/task-source-context'
import type { RpcContext } from './core'

type ProjectionContext = Pick<RpcContext, 'clientCapabilities' | 'runtime'>

type LegacyIds = {
  projects: readonly Project[]
  setups: readonly ProjectHostSetup[]
  projectIdByRepoId: ReadonlyMap<string, string>
  projectById: ReadonlyMap<string, Project>
}

/** In-process and local-CLI callers declare nothing and are current (precedent: worktree visibility). */
export function supportsProjectRootIdentity(
  context: Pick<RpcContext, 'clientCapabilities'>
): boolean {
  return (
    context.clientCapabilities === undefined ||
    context.clientCapabilities.includes(PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY)
  )
}

function isRootProjectId(projectId: string): boolean {
  return projectId.startsWith(ROOT_PROJECT_ID_PREFIX)
}

function legacyIds(context: ProjectionContext): LegacyIds {
  // Why: an old client must see exactly what an old host would publish (wire doc Rule 3).
  const repos: Repo[] = context.runtime
    .listRepos()
    .map((repo) => ({ ...repo, gitRootIdentity: undefined, gitRootIdentityNoneReason: undefined }))
  const projection = projectHostSetupProjectionFromRepos(repos, undefined, { identityContext: [] })
  return {
    projects: projection.projects,
    setups: projection.setups,
    projectIdByRepoId: new Map(projection.setups.map((setup) => [setup.repoId, setup.projectId])),
    projectById: new Map(projection.projects.map((project) => [project.id, project]))
  }
}

function identityCollisionsFor(context: ProjectionContext): ProjectIdentityCollision[] {
  return projectIdentityCollisionsFromEligibility(
    buildRootIdentityEligibility(context.runtime.listRepos())
  )
}

/** Only a capable client gets it: an older one never saw the field and must not start to. */
function withReplicaTopology(
  setups: readonly ProjectHostSetup[],
  identityCollisions: readonly ProjectIdentityCollision[],
  context: ProjectionContext,
  relations: ReadonlyMap<string, ReplicaRelation> | undefined
): ProjectHostSetupWithReplicaTopology[] {
  const entries = deriveReplicaTopology({
    setups,
    repos: context.runtime.listRepos(),
    identityCollisions,
    ...(relations ? { relations } : {})
  })
  return setups.map((setup, index) => ({ ...setup, replicaTopology: entries[index] }))
}

export function projectRootIdentityForClient(
  kind: 'projects',
  stored: readonly Project[],
  context: ProjectionContext
): { projects: readonly Project[]; identityCollisions?: ProjectIdentityCollision[] }
export function projectRootIdentityForClient(
  kind: 'setups',
  stored: readonly ProjectHostSetup[],
  context: ProjectionContext,
  /** Already published through `publishedRelationsOf`; ignored for a client without root identity. */
  relations?: ReadonlyMap<string, ReplicaRelation>
): { setups: readonly ProjectHostSetup[]; identityCollisions?: ProjectIdentityCollision[] }
export function projectRootIdentityForClient(
  kind: 'projects' | 'setups',
  stored: readonly Project[] | readonly ProjectHostSetup[],
  context: ProjectionContext,
  relations?: ReadonlyMap<string, ReplicaRelation>
): object {
  if (supportsProjectRootIdentity(context)) {
    const identityCollisions = identityCollisionsFor(context)
    if (kind === 'setups') {
      return {
        setups: withReplicaTopology(
          stored as readonly ProjectHostSetup[],
          identityCollisions,
          context,
          relations
        ),
        identityCollisions
      }
    }
    return { projects: stored, identityCollisions }
  }
  const legacy = legacyIds(context)
  if (kind === 'projects') {
    const storedById = new Map(
      (stored as readonly Project[]).map((project) => [project.id, project])
    )
    const projects = legacy.projects.map((project) => storedById.get(project.id) ?? project)
    const known = new Set(projects.map((project) => project.id))
    const independent = (stored as readonly Project[]).filter(
      (project) => !isRootProjectId(project.id) && !known.has(project.id)
    )
    return { projects: [...projects, ...independent] }
  }
  const storedById = new Map(
    (stored as readonly ProjectHostSetup[]).map((setup) => [setup.id, setup])
  )
  const setups = legacy.setups.map((setup) => {
    const kept = storedById.get(setup.id)
    return kept ? { ...kept, projectId: setup.projectId } : setup
  })
  const known = new Set(setups.map((setup) => setup.id))
  const independent = (stored as readonly ProjectHostSetup[]).filter(
    (setup) => !isRootProjectId(setup.projectId) && !known.has(setup.id)
  )
  return { setups: [...setups, ...independent] }
}

/** The legacy id of the repo a project id was published for, or null when no repo maps it. */
export function projectIdForClient(
  projectId: string,
  repoId: string | null | undefined,
  context: ProjectionContext
): string | null {
  return projectIdResolverForClient(context)(projectId, repoId)
}

/** `projectIdForClient` for a list: the legacy projection is built once, and only when needed. */
export function projectIdResolverForClient(
  context: ProjectionContext
): (projectId: string, repoId: string | null | undefined) => string | null {
  if (supportsProjectRootIdentity(context)) {
    return (projectId) => projectId
  }
  let legacy: LegacyIds | undefined
  return (projectId, repoId) => {
    if (!isRootProjectId(projectId)) {
      return projectId
    }
    legacy ??= legacyIds(context)
    return (repoId ? legacy.projectIdByRepoId.get(repoId) : undefined) ?? null
  }
}

type ProjectResultShape = { project?: Project; setup?: ProjectHostSetup; repo?: Repo }

/** Single-result publishers: map the ids through the repo they name, drop what cannot be mapped. */
export function projectResultForClient<T extends object>(result: T, context: ProjectionContext): T {
  const shape = result as ProjectResultShape
  const rootSetup = shape.setup !== undefined && isRootProjectId(shape.setup.projectId)
  const rootProject = shape.project !== undefined && isRootProjectId(shape.project.id)
  if (supportsProjectRootIdentity(context) || (!rootSetup && !rootProject)) {
    return result
  }
  const legacy = legacyIds(context)
  const repoId =
    shape.setup?.repoId ??
    shape.repo?.id ??
    shape.project?.sourceRepoIds.find((id) => legacy.projectIdByRepoId.has(id))
  const legacyId = repoId ? legacy.projectIdByRepoId.get(repoId) : undefined
  const next: Record<string, unknown> = { ...(result as Record<string, unknown>) }
  if (rootSetup && shape.setup) {
    if (legacyId) {
      next.setup = { ...shape.setup, projectId: legacyId }
    } else {
      delete next.setup
    }
  }
  if (rootProject) {
    const project = legacyId ? legacy.projectById.get(legacyId) : undefined
    if (project) {
      next.project = project
    } else {
      delete next.project
    }
  }
  return next as T
}

type ContextCarrier = {
  runContext?: WorkspaceRunContext | null
  sourceContext?: TaskSourceContext | null
}

function carrierForClient<T extends ContextCarrier>(entity: T, context: ProjectionContext): T {
  const run = entity.runContext
  const source = entity.sourceContext
  const runIsRoot = run != null && isRootProjectId(run.projectId)
  const sourceIsRoot = source != null && isRootProjectId(source.projectId)
  if (!runIsRoot && !sourceIsRoot) {
    return entity
  }
  const next: T = { ...entity }
  if (run != null && runIsRoot) {
    const projectId = projectIdForClient(run.projectId, run.repoId, context)
    next.runContext = projectId ? { ...run, projectId } : null
  }
  if (source != null && sourceIsRoot) {
    const projectId = projectIdForClient(source.projectId, source.repoId, context)
    next.sourceContext = projectId ? { ...source, projectId } : null
  }
  return next
}

/** Automations and runs carry a run/source context whose project id is an Orca project id. */
export function automationResultForClient<T extends object>(
  result: T,
  context: ProjectionContext
): T {
  if (supportsProjectRootIdentity(context)) {
    return result
  }
  const shape = result as {
    automation?: ContextCarrier
    automations?: ContextCarrier[]
    run?: ContextCarrier
    runs?: ContextCarrier[]
  }
  const next: Record<string, unknown> = { ...(result as Record<string, unknown>) }
  if (shape.automation) {
    next.automation = carrierForClient(shape.automation, context)
  }
  if (shape.automations) {
    next.automations = shape.automations.map((entry) => carrierForClient(entry, context))
  }
  if (shape.run) {
    next.run = carrierForClient(shape.run, context)
  }
  if (shape.runs) {
    next.runs = shape.runs.map((entry) => carrierForClient(entry, context))
  }
  return next as T
}
