import { escapeHiddenCharacters } from '../shared/environment-prepare-plan'
import type { PreparePlan, PrepareStepLabel } from '../shared/environment-prepare-plan'
import type { EnvironmentRequirementsMeasurement } from '../shared/environment-requirements-measurement'
import type {
  EnvironmentRequirement,
  RequirementProbeResult
} from '../shared/environment-requirement-types'

const CONTRACT_LABEL: Record<EnvironmentRequirementsMeasurement['contract'], string> = {
  parsed: 'parsed',
  absent: 'none declared',
  unreadable: 'UNREADABLE (not the same as none declared)',
  unparseable: 'UNPARSEABLE (not the same as none declared)'
}

function describeRequirement(requirement: EnvironmentRequirement): string {
  if ('unsupportedByThisOrca' in requirement) {
    return `${requirement.id}  ${requirement.kind}  unsupported by this Orca`
  }
  if ('malformed' in requirement) {
    return `${requirement.id}  ${requirement.kind}  malformed`
  }
  const prepare = requirement.prepare === undefined ? '' : '  [prepare declared, not run]'
  return `${requirement.id}  ${requirement.kind}${prepare}`
}

function describeProbe(probe: RequirementProbeResult | undefined): string {
  if (!probe) {
    return 'no result'
  }
  const detail = [probe.version, probe.resolvedPath, probe.reason].filter(Boolean).join('  ')
  return detail ? `${probe.outcome}  ${detail}` : probe.outcome
}

const LABEL_WORDS: Record<PrepareStepLabel, string> = {
  'asks-for-elevation': 'asks for elevated privileges',
  'script-content-not-covered':
    "runs a repository script; the script's own contents are not covered by the approval",
  'hidden-characters':
    'contains hidden or direction-changing characters, written below as <U+XXXX> code points'
}

/** Every declared prepare step with the exact text and the hash that approves it, never run here. */
export function formatPreparePlan(plan: PreparePlan, repoSelector: string): string {
  const lines = [`Host: ${plan.hostKey}`]
  if (plan.contractVerdict) {
    const { reason } = plan.contractVerdict
    const verdict =
      reason === 'contract-unparseable'
        ? 'UNPARSEABLE'
        : reason === 'contract-unreadable'
          ? 'UNREADABLE'
          : `NOT READ (host ${reason})`
    lines.push(`Contract: ${verdict} (not the same as none declared)`)
    return lines.join('\n')
  }
  if (plan.steps.length === 0) {
    lines.push('No prepare steps declared.')
  }
  for (const step of plan.steps) {
    const state = plan.rows.find((row) => row.id === step.requirementId)?.verdict.state
    lines.push(
      '',
      `Step ${step.requirementId} (${state ?? 'unknown'})`,
      'Runs exactly this text in a terminal on that host:',
      '----- begin exact text -----',
      escapeHiddenCharacters(step.bytes),
      '----- end exact text -----',
      `as JSON: ${escapeHiddenCharacters(JSON.stringify(step.bytes))}`
    )
    if (step.labels.length > 0) {
      lines.push(`labels: ${step.labels.map((label) => LABEL_WORDS[label]).join('; ')}`)
    }
    lines.push(
      `approval hash: ${step.approvalHash}`,
      `approve with: orca project prepare --repo ${repoSelector} --requirement ${step.requirementId} --approve ${step.approvalHash}`
    )
  }
  return lines.join('\n')
}

export function formatPrepareRun(
  value: { status: 'started' } | { status: 'refused'; reason: string }
): string {
  return value.status === 'started' ? 'started' : `refused: ${value.reason}`
}

export function formatEnvironmentRequirements(value: EnvironmentRequirementsMeasurement): string {
  const lines = [`Contract: ${CONTRACT_LABEL[value.contract]}`]
  if (value.contractSource) {
    lines.push(
      `  ${value.contractSource.path}  sha256:${value.contractSource.contentHash.slice(0, 12)}`
    )
  }
  const { measurement } = value
  lines.push(
    measurement.status === 'measured'
      ? `Host: ${measurement.hostKey}  ${measurement.platform.os}/${measurement.platform.arch}`
      : `Host: ${measurement.hostKey}  NOT MEASURED: ${measurement.status} (${measurement.detail})`
  )
  for (const diagnostic of value.diagnostics) {
    lines.push(`  diagnostic #${diagnostic.index}: ${diagnostic.message}`)
  }
  for (const requirement of value.requirements) {
    const probe =
      measurement.status === 'measured'
        ? describeProbe(measurement.probes.find((entry) => entry.id === requirement.id))
        : 'not measured'
    lines.push(`  ${describeRequirement(requirement)}  ->  ${probe}`)
  }
  return lines.join('\n')
}
