import type { FleetPlacementRejection } from '../shared/fleet-placement'
import type { FleetPlacementViewResult } from '../shared/fleet-placement-view'
import { formatByteCount } from './workspace-format'

/** 0: a host was selected · 2: the fleet answered and none is eligible · 1: could not ask. */
export function fleetPlacementExitCode(result: FleetPlacementViewResult): number {
  if (result.status !== 'ok') {
    return 1
  }
  return result.proposal.decision === 'selected' ? 0 : 2
}

function describeRejection(rejection: FleetPlacementRejection): string {
  switch (rejection.reason) {
    case 'identity-unavailable':
      return 'no verifiable host key'
    case 'sample-unmeasured':
      return `not measured (${rejection.outcome})`
    case 'sample-stale':
      return `sample ${Math.round(rejection.ageMs / 1000)}s old`
    case 'protocol-blocked':
      return 'protocol incompatible'
    case 'protocol-unknown':
      return 'protocol unknown'
    case 'platform-unknown':
      return 'platform unknown'
    case 'platform-mismatch':
      return `platform is ${rejection.platform}`
    case 'capabilities-unknown':
      return 'capabilities unknown'
    case 'capability-missing':
      return `missing ${rejection.capabilities.join(', ')}`
    case 'insufficient-memory':
      return `${formatByteCount(rejection.availableMemory)} available, ${formatByteCount(rejection.required)} required`
  }
}

export function formatFleetPlacementView(result: FleetPlacementViewResult): string {
  if (result.status === 'refused') {
    return 'fleet: refused — only this machine may ask for its fleet view.'
  }
  if (result.status === 'unavailable') {
    return 'fleet: unavailable — this Orca process has no fleet reader.'
  }
  const { proposal, observation } = result
  const lines: string[] = []
  const selected = proposal.selected
  lines.push(
    selected
      ? `fleet: selected ${selected.label} — ${formatByteCount(selected.availableMemory)} available (${selected.availableMemorySource}), sampled ${Math.round(selected.sampleAgeMs / 1000)}s ago`
      : 'fleet: no eligible host'
  )
  for (const candidate of proposal.eligible) {
    const marker = candidate.key === selected?.key ? '*' : ' '
    const current = candidate.isCurrent ? ' (current)' : ''
    lines.push(
      `  ${marker} ${candidate.label.padEnd(20)} ${formatByteCount(candidate.availableMemory).padStart(10)}  ${candidate.addresses.join(', ')}${current}`
    )
  }
  for (const rejected of proposal.rejected) {
    lines.push(
      `  x ${rejected.addresses.join(', ')}: ${rejected.reasons.map(describeRejection).join('; ') || 'not judged'}`
    )
  }
  lines.push(
    `coverage: this machine + ${observation.coverage.runtimeEnvironments} paired runtime(s); SSH targets are not enumerated`
  )
  lines.push('A proposal only — nothing was moved.')
  return lines.join('\n')
}
