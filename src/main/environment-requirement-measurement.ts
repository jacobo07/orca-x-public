import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { parseOrcaYamlRequirements } from '../shared/orca-yaml-requirements'
import { isENOENT } from './ipc/filesystem-path-containment'
import { getPreflightWslTarget } from './ipc/preflight-runtime-target'
import { getHookWslContext } from './hook-runtime-target'
import { joinWorktreeRelativePath } from './runtime/runtime-relative-paths'
import { getSshFilesystemProvider } from './providers/ssh-filesystem-dispatch'
import { measureRequirementsLocally } from './environment-requirement-local-probe'
import { measureRequirementsOverSsh } from './environment-requirement-ssh-measurement'
import type { IFilesystemProvider } from './providers/types'
import type { Repo } from '../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'
import type {
  EnvironmentRequirement,
  HostMeasurement,
  RequirementDiagnostic
} from '../shared/environment-requirement-types'

export type ContractSource = { hostKey: string; path: string; contentHash: string }
export type ContractReadState = 'parsed' | 'absent' | 'unreadable' | 'unparseable'

export type EnvironmentRequirementsMeasurement = {
  // Null when no bytes were read (the file is absent or could not be read).
  contractSource: ContractSource | null
  contract: ContractReadState
  requirements: EnvironmentRequirement[]
  diagnostics: RequirementDiagnostic[]
  measurement: HostMeasurement
}

export type EnvironmentMeasurementDeps = {
  hostname: string
  userDataPath: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  readLocalFile: (path: string) => Promise<Buffer>
  getSshFilesystemProvider: (
    connectionId: string
  ) => Pick<IFilesystemProvider, 'readFile'> | undefined
  measureLocally: typeof measureRequirementsLocally
  measureOverSsh: typeof measureRequirementsOverSsh
  now: () => number
}

type MeasurableRepo = Pick<Repo, 'path' | 'connectionId' | 'executionHostId'> & { kind?: string }

type ContractRead =
  | { state: 'read'; bytes: Buffer; text: string }
  | { state: 'absent' }
  | { state: 'unreadable' }

// Stable across restarts and distinct between machines: it only distinguishes installations, it is
// not a secret.
export function computeInstallationTag(hostname: string, userDataPath: string): string {
  return createHash('sha256').update(`${hostname}\u0000${userDataPath}`).digest('hex').slice(0, 16)
}

function decodeContract(bytes: Buffer): ContractRead {
  if (bytes.includes(0)) {
    return { state: 'unreadable' }
  }
  try {
    return { state: 'read', bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { state: 'unreadable' }
  }
}

// Why: only ENOENT means "the project declares nothing"; every other failure is "could not read",
// which must stay distinguishable so a damaged file never plans as zero requirements.
async function readContract(
  repo: MeasurableRepo,
  contractPath: string,
  deps: EnvironmentMeasurementDeps
): Promise<ContractRead> {
  try {
    if (repo.connectionId) {
      const provider = deps.getSshFilesystemProvider(repo.connectionId)
      if (!provider) {
        return { state: 'unreadable' }
      }
      const result = await provider.readFile(contractPath)
      return result.isBinary
        ? { state: 'unreadable' }
        : decodeContract(Buffer.from(result.content, 'utf8'))
    }
    return decodeContract(await deps.readLocalFile(contractPath))
  } catch (error) {
    return isENOENT(error) ? { state: 'absent' } : { state: 'unreadable' }
  }
}

async function measureHost(
  repo: MeasurableRepo,
  hostKey: string,
  requirements: EnvironmentRequirement[],
  deps: EnvironmentMeasurementDeps
): Promise<HostMeasurement> {
  if (repo.connectionId) {
    return deps.measureOverSsh({
      connectionId: repo.connectionId,
      hostKey,
      workspacePath: repo.path,
      requirements
    })
  }
  let wslTarget: ReturnType<typeof getPreflightWslTarget> = null
  if (deps.projectRuntime) {
    try {
      // Why: a project runtime that resolves to WSL only exists on a Windows host.
      wslTarget = getPreflightWslTarget({ projectRuntime: deps.projectRuntime }, 'win32')
    } catch {
      return {
        status: 'refused',
        at: deps.now(),
        hostKey,
        detail: 'project-runtime-repair-required'
      }
    }
  }
  const workspacePath = wslTarget
    ? (getHookWslContext(repo.path, { wslDistro: wslTarget.distro })?.linuxPath ?? repo.path)
    : repo.path
  return deps.measureLocally({ requirements, workspacePath, hostKey, wslTarget })
}

export async function measureEnvironmentRequirements(
  repo: MeasurableRepo,
  overrides: Partial<EnvironmentMeasurementDeps> & Pick<EnvironmentMeasurementDeps, 'userDataPath'>
): Promise<EnvironmentRequirementsMeasurement> {
  const deps: EnvironmentMeasurementDeps = {
    hostname: osHostname(),
    readLocalFile: (path) => readFile(path),
    getSshFilesystemProvider,
    measureLocally: measureRequirementsLocally,
    measureOverSsh: measureRequirementsOverSsh,
    now: Date.now,
    ...overrides
  }
  const hostKey = `${getRepoExecutionHostId(repo)}@${computeInstallationTag(deps.hostname, deps.userDataPath)}`
  // Folder workspaces are read like any other: a folder can carry an orca.yaml too.
  const contractPath = joinWorktreeRelativePath(repo.path, 'orca.yaml')
  const read = await readContract(repo, contractPath, deps)

  let contract: ContractReadState = read.state === 'read' ? 'absent' : read.state
  let requirements: EnvironmentRequirement[] = []
  let diagnostics: RequirementDiagnostic[] = []
  if (read.state === 'read') {
    const parsed = parseOrcaYamlRequirements(read.text)
    if (parsed.status === 'parsed') {
      contract = 'parsed'
      requirements = parsed.requirements
      diagnostics = parsed.diagnostics
    } else if (parsed.status === 'unparseable') {
      contract = 'unparseable'
    }
  }
  const contractSource: ContractSource | null =
    read.state === 'read'
      ? {
          hostKey,
          path: contractPath,
          contentHash: createHash('sha256').update(read.bytes).digest('hex')
        }
      : null
  // The host is measured even when there is nothing to probe, so reachability and platform still show.
  const measurement = await measureHost(repo, hostKey, requirements, deps)
  return { contractSource, contract, requirements, diagnostics, measurement }
}
