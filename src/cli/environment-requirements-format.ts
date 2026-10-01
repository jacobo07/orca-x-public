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
