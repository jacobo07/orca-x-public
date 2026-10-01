import { readFile } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { createHash } from 'node:crypto'
import { nodePrepareSha256Hex } from '../../shared/environment-prepare-node-hash'
import { classifyRequirement } from '../../shared/environment-requirement-state'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { WORKTREE_ID_SEPARATOR } from '../../shared/pty-session-id-format'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { Repo } from '../../shared/repo-types'
import { readPersistedPrepareApproval } from '../environment-prepare-authority'
import {
  computeInstallationTag,
  measureEnvironmentHost,
  readEnvironmentContract,
  type EnvironmentMeasurementDeps
} from '../environment-requirement-measurement'
import { measureRequirementsLocally } from '../environment-requirement-local-probe'
import { measureRequirementsOverSsh } from '../environment-requirement-ssh-measurement'
import { listSshHostIdentities } from '../ipc/ssh'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { joinWorktreeRelativePath } from './runtime-relative-paths'
import type { PrepareStepRunnerDeps } from './environment-prepare-step-runner'

export type EnvironmentPrepareRuntimeFacets = {
  resolveRepo: (selector: string) => Promise<Repo>
  getTrustedOrcaHooks: () => unknown
  createTerminal: PrepareStepRunnerDeps['createTerminal']
  userDataPath: string
  projectRuntimeFor: (repo: Repo) => ProjectExecutionRuntimeResolution | undefined
}

// Folder repos and git repos both address their root as `<repoId>::<path>`.
export function prepareWorkspaceSelector(repo: Pick<Repo, 'id' | 'path'>): string {
  return `id:${repo.id}${WORKTREE_ID_SEPARATOR}${repo.path}`
}

async function readSshHostIdentity(connectionId: string): Promise<string> {
  try {
    const status = listSshHostIdentities().find((entry) => entry.targetId === connectionId)?.status
    return status ?? 'unverifiable'
  } catch {
    return 'unverifiable'
  }
}

export function createEnvironmentPrepareDeps(
  facets: EnvironmentPrepareRuntimeFacets
): PrepareStepRunnerDeps<Repo> {
  const hostname = osHostname()
  const measurementDeps = (repo: Repo): EnvironmentMeasurementDeps => ({
    hostname,
    userDataPath: facets.userDataPath,
    projectRuntime: repo.connectionId ? undefined : facets.projectRuntimeFor(repo),
    readLocalFile: (path) => readFile(path),
    getSshFilesystemProvider,
    measureLocally: measureRequirementsLocally,
    measureOverSsh: measureRequirementsOverSsh,
    now: Date.now
  })
  const hostKeyFor = (repo: Repo): string =>
    `${getRepoExecutionHostId(repo)}@${computeInstallationTag(hostname, facets.userDataPath)}`
  return {
    resolveRepo: facets.resolveRepo,
    hostKeyFor,
    readContract: async (repo) => {
      const read = await readEnvironmentContract(
        repo,
        joinWorktreeRelativePath(repo.path, 'orca.yaml'),
        measurementDeps(repo)
      )
      return read.state === 'read'
        ? {
            state: 'read',
            text: read.text,
            contentHash: createHash('sha256').update(read.bytes).digest('hex')
          }
        : read
    },
    measureRequirement: async (repo, requirement) => {
      const measurement = await measureEnvironmentHost(
        repo,
        hostKeyFor(repo),
        [requirement],
        measurementDeps(repo)
      )
      return classifyRequirement(requirement, measurement, { prepareApproved: false }).state
    },
    readHostIdentity: async (repo) =>
      repo.connectionId ? readSshHostIdentity(repo.connectionId) : 'local',
    readPersistedApproval: (repo, requirementId) =>
      readPersistedPrepareApproval(facets.getTrustedOrcaHooks, repo.id, requirementId),
    workspaceSelector: prepareWorkspaceSelector,
    createTerminal: facets.createTerminal,
    sha256Hex: nodePrepareSha256Hex
  }
}
