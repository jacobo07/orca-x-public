import type { Sha256Hex } from '../../shared/environment-prepare-plan'
import type { RequirementState } from '../../shared/environment-requirement-state'
import type { EvaluatedRequirement } from '../../shared/environment-requirement-types'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import { parseOrcaYamlRequirements } from '../../shared/orca-yaml-requirements'
import {
  authorizePrepareStep,
  findDeclaredPrepare,
  type AuthorizePrepareInput,
  type AuthorizePrepareResult,
  type PersistedApprovalRead,
  type PrepareContract,
  type PrepareRefusalReason
} from '../environment-prepare-authority'

export type PrepareOrigin = 'desktop-ipc' | 'runtime-rpc'

// The request names a requirement and an approval hash. There is deliberately no field for command
// text: what runs is only ever what the host re-read from orca.yaml.
export type RunEnvironmentPrepareStepArgs = {
  repoSelector: string
  requirementId: string
  approvedContentHash: string
  approvedHostKey: string
  origin: PrepareOrigin
}

export type RunEnvironmentPrepareStepResult =
  | { status: 'started'; terminal: RuntimeTerminalCreate }
  | { status: 'refused'; reason: PrepareRefusalReason }

export type PrepareContractFile =
  | { state: 'read'; text: string; contentHash: string }
  | { state: 'absent' }
  | { state: 'unreadable' }

export type PrepareRunnerRepo = Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'> & {
  kind?: string
}

export type PrepareStepRunnerDeps<R extends PrepareRunnerRepo = PrepareRunnerRepo> = {
  resolveRepo: (selector: string) => Promise<R>
  hostKeyFor: (repo: R) => string
  readContract: (repo: R) => Promise<PrepareContractFile>
  measureRequirement: (repo: R, requirement: EvaluatedRequirement) => Promise<RequirementState>
  readHostIdentity: (repo: R) => Promise<string>
  readPersistedApproval: (repo: R, requirementId: string) => PersistedApprovalRead
  workspaceSelector: (repo: R) => string
  createTerminal: (
    selector: string,
    options: { command: string; title: string; activate: boolean }
  ) => Promise<RuntimeTerminalCreate>
  sha256Hex: Sha256Hex
  // Test seam; production uses the default, which is authorizePrepareStep itself.
  authorize?: (input: AuthorizePrepareInput) => Promise<AuthorizePrepareResult>
}

export function prepareContractFromFile(file: PrepareContractFile): PrepareContract {
  if (file.state !== 'read') {
    return { status: file.state }
  }
  const parsed = parseOrcaYamlRequirements(file.text)
  if (parsed.status === 'parsed') {
    return { status: 'parsed', requirements: parsed.requirements }
  }
  return parsed.status === 'absent' ? { status: 'absent' } : { status: 'unparseable' }
}

function fileStamp(file: PrepareContractFile): string {
  return file.state === 'read' ? file.contentHash : file.state
}

// The only path that spawns a prepare command. Order is part of the contract: read 1, re-measure,
// read 2 (immediately before authorization), identity and approval, authorize over the read-2
// bytes, then spawn exactly those bytes with nothing awaited in between.
export async function runEnvironmentPrepareStep<R extends PrepareRunnerRepo>(
  args: RunEnvironmentPrepareStepArgs,
  deps: PrepareStepRunnerDeps<R>
): Promise<RunEnvironmentPrepareStepResult> {
  const refuse = (reason: PrepareRefusalReason): RunEnvironmentPrepareStepResult => ({
    status: 'refused',
    reason
  })
  const repo = await deps.resolveRepo(args.repoSelector)
  const hostKey = deps.hostKeyFor(repo)

  const read1 = await deps.readContract(repo)
  const declared = findDeclaredPrepare(prepareContractFromFile(read1), args.requirementId)
  if (!declared.ok) {
    return refuse(declared.reason)
  }
  const remeasuredState = await deps.measureRequirement(repo, declared.requirement)

  const read2 = await deps.readContract(repo)
  if (fileStamp(read2) !== fileStamp(read1)) {
    return refuse('contract-changed')
  }
  const hostIdentity = await deps.readHostIdentity(repo)
  // Why: a runtime host records no grant of its own; the caller's presented hash is checked
  // against the bytes this host just re-read.
  const requirePersistedApproval = args.origin === 'desktop-ipc'
  const persistedApproval: PersistedApprovalRead = requirePersistedApproval
    ? deps.readPersistedApproval(repo, args.requirementId)
    : { status: 'absent' }

  const authorize =
    deps.authorize ??
    ((input: AuthorizePrepareInput) => authorizePrepareStep(input, { sha256Hex: deps.sha256Hex }))
  const decision = await authorize({
    requirementId: args.requirementId,
    contract: prepareContractFromFile(read2),
    hostKey,
    approvedContentHash: args.approvedContentHash,
    approvedHostKey: args.approvedHostKey,
    persistedApproval,
    requirePersistedApproval,
    hostIdentity,
    remeasuredState
  })
  if (!decision.authorized) {
    return refuse(decision.reason)
  }
  const terminal = await deps.createTerminal(deps.workspaceSelector(repo), {
    command: decision.bytes,
    title: `Prepare: ${args.requirementId}`,
    activate: true
  })
  return { status: 'started', terminal }
}
