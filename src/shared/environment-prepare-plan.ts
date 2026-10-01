import { classifyContractRead, classifyRequirement } from './environment-requirement-state'
import type { RequirementVerdict } from './environment-requirement-state'
import type { ContractReadState, ContractSource } from './environment-requirements-measurement'
import type { EnvironmentRequirement, HostMeasurement } from './environment-requirement-types'
import { isEvaluatedRequirement } from './environment-requirement-types'

// Injected so main/CLI (node crypto) and the renderer (Web Crypto) can each supply one digest.
export type Sha256Hex = (bytes: Uint8Array) => Promise<string>

export type PrepareStepLabel = 'asks-for-elevation' | 'script-content-not-covered'

export type PrepareStep = {
  requirementId: string
  // The exact declared bytes: what an approval hashes and what would be run.
  bytes: string
  approvalHash: string
  labels: PrepareStepLabel[]
  runnable: boolean
}

export type PreparePlanRow = { id: string; kind: string; verdict: RequirementVerdict }

export type PreparePlan = {
  contractSource: ContractSource | null
  hostKey: string
  measuredAt: number
  contractVerdict: RequirementVerdict | null
  rows: PreparePlanRow[]
  steps: PrepareStep[]
}

export type PreparePlanInput = {
  contractSource: ContractSource | null
  hostKey: string
  requirements: EnvironmentRequirement[]
  measurement: HostMeasurement
  // requirement id -> the approval hash the person gave for it on this host.
  approvals: Record<string, string>
  contract?: ContractReadState
}

// Why: no trim and no newline normalization. Unlike hashOrcaHookScript, an approval names the
// exact bytes that will run, so a whitespace edit must void it.
export function prepareApprovalPreimage(
  requirementId: string,
  hostKey: string,
  bytes: string
): Uint8Array {
  return new TextEncoder().encode(`prepare:${requirementId}\n${hostKey}\n${bytes}`)
}

export async function prepareApprovalHash(
  requirementId: string,
  hostKey: string,
  bytes: string,
  sha256Hex: Sha256Hex
): Promise<string> {
  return sha256Hex(prepareApprovalPreimage(requirementId, hostKey, bytes))
}

const ELEVATION_TOKENS = new Set(['sudo', 'doas', 'pkexec', 'runas'])

function isElevation(token: string): boolean {
  const base = token
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '')
  return ELEVATION_TOKENS.has(base)
}

function isRelativeScriptPath(token: string): boolean {
  if (/^([A-Za-z]:[\\/]|\/|\\\\)/.test(token)) {
    return false
  }
  return /[\\/]/.test(token)
}

// Why: same token rule as firstRecipeCommandToken, kept local because that module imports node:fs
// and this one is bundled into the renderer.
function firstCommandToken(command: string): string | null {
  const trimmed = command.trim()
  const quoted = trimmed.match(/^"([^"]+)"/) ?? trimmed.match(/^'([^']+)'/)
  return quoted ? quoted[1] : trimmed.split(/\s+/)[0] || null
}

function labelsFor(bytes: string): PrepareStepLabel[] {
  const token = firstCommandToken(bytes)
  if (!token) {
    return []
  }
  const labels: PrepareStepLabel[] = []
  if (isElevation(token)) {
    labels.push('asks-for-elevation')
  }
  if (isRelativeScriptPath(token)) {
    labels.push('script-content-not-covered')
  }
  return labels
}

export async function buildPreparePlan(
  input: PreparePlanInput,
  deps: { sha256Hex: Sha256Hex }
): Promise<PreparePlan> {
  const rows: PreparePlanRow[] = []
  const steps: PrepareStep[] = []
  for (const requirement of input.requirements) {
    const declared = isEvaluatedRequirement(requirement) ? requirement.prepare : undefined
    let approvalHash = ''
    let approved = false
    if (declared !== undefined) {
      approvalHash = await prepareApprovalHash(
        requirement.id,
        input.hostKey,
        declared,
        deps.sha256Hex
      )
      approved = input.approvals[requirement.id] === approvalHash
    }
    const verdict = classifyRequirement(requirement, input.measurement, {
      prepareApproved: approved
    })
    rows.push({ id: requirement.id, kind: requirement.kind, verdict })
    if (declared !== undefined) {
      steps.push({
        requirementId: requirement.id,
        bytes: declared,
        approvalHash,
        labels: labelsFor(declared),
        runnable: approved && (verdict.state === 'missing' || verdict.state === 'incompatible')
      })
    }
  }
  return {
    contractSource: input.contractSource,
    hostKey: input.hostKey,
    measuredAt: input.measurement.at,
    contractVerdict: classifyContractRead(
      input.contract ?? 'parsed',
      input.hostKey,
      input.measurement.at
    ),
    rows,
    steps
  }
}
