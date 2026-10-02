import { satisfiesVersionRange } from './environment-version-range'
import type { ContractReadState } from './environment-requirements-measurement'
import type {
  CredentialRequirement,
  EnvironmentRequirement,
  EvaluatedRequirement,
  HostMeasurement,
  RequirementProbeResult
} from './environment-requirement-types'
import { isEvaluatedRequirement } from './environment-requirement-types'

export type RequirementState =
  | 'satisfied'
  | 'missing'
  | 'incompatible'
  | 'unsupported'
  | 'needs-authorization'
  | 'unknown'

// Why: evidence is a version string or a resolved path, never command output or a value.
export type RequirementEvidence = { version?: string; resolvedPath?: string }

export type RequirementVerdict = {
  state: RequirementState
  reason: string
  actor?: 'user'
  measuredAt: number
  hostKey: string
  evidence?: RequirementEvidence
}

export type RequirementAuthorization = { prepareApproved: boolean }

type Stamp = { measuredAt: number; hostKey: string }

function verdict(
  stamp: Stamp,
  state: RequirementState,
  reason: string,
  extra: { actor?: 'user'; evidence?: RequirementEvidence } = {}
): RequirementVerdict {
  const evidence = extra.evidence
  return {
    state,
    reason,
    ...(extra.actor ? { actor: extra.actor } : {}),
    measuredAt: stamp.measuredAt,
    hostKey: stamp.hostKey,
    ...(evidence && (evidence.version || evidence.resolvedPath) ? { evidence } : {})
  }
}

function evidenceOf(probe: RequirementProbeResult): RequirementEvidence {
  return {
    ...(probe.version ? { version: probe.version } : {}),
    ...(probe.resolvedPath ? { resolvedPath: probe.resolvedPath } : {})
  }
}

// A requirement that is not met: a declared prepare nobody approved is what the person must act on.
function unmet(
  requirement: EvaluatedRequirement,
  stamp: Stamp,
  reason: string,
  authorization: RequirementAuthorization
): RequirementVerdict {
  if (requirement.prepare !== undefined && !authorization.prepareApproved) {
    return verdict(stamp, 'needs-authorization', 'prepare-unapproved', { actor: 'user' })
  }
  return verdict(stamp, 'missing', reason)
}

function classifyCredential(
  requirement: CredentialRequirement,
  probe: RequirementProbeResult,
  stamp: Stamp,
  authorization: RequirementAuthorization
): RequirementVerdict {
  if (probe.outcome === 'absent') {
    return unmet(requirement, stamp, probe.reason ?? 'credential-cli-absent', authorization)
  }
  return probe.authenticated === true
    ? verdict(stamp, 'satisfied', 'signed-in')
    : verdict(stamp, 'needs-authorization', 'sign-in-required', { actor: 'user' })
}

function classifyCommand(
  requirement: EvaluatedRequirement & { kind: 'command' },
  probe: RequirementProbeResult,
  stamp: Stamp,
  authorization: RequirementAuthorization
): RequirementVerdict {
  if (probe.outcome === 'absent') {
    return unmet(requirement, stamp, 'command-absent', authorization)
  }
  const evidence = evidenceOf(probe)
  const range = requirement.versionRange
  if (!range) {
    return verdict(stamp, 'satisfied', 'found', { evidence })
  }
  if (range.status !== 'supported') {
    return verdict(stamp, 'unknown', 'unsupported-version-range')
  }
  if (!probe.version) {
    return verdict(stamp, 'unknown', 'version-missing', { evidence })
  }
  return satisfiesVersionRange(probe.version, range.comparators)
    ? verdict(stamp, 'satisfied', 'version-in-range', { evidence })
    : verdict(stamp, 'incompatible', 'version-out-of-range', { evidence })
}

function platformFilterUnmeasured(
  requirement: EvaluatedRequirement,
  measurement: Extract<HostMeasurement, { status: 'measured' }>
): boolean {
  const { os, arch } = measurement.platform
  return (requirement.platforms?.length ?? 0) > 0 && (!os || os === 'unknown' || arch === 'unknown')
}

// Precedence: unknown > unsupported > satisfied > incompatible > needs-authorization > missing.
export function classifyRequirement(
  requirement: EnvironmentRequirement,
  measurement: HostMeasurement,
  authorization: RequirementAuthorization
): RequirementVerdict {
  const stamp: Stamp = { measuredAt: measurement.at, hostKey: measurement.hostKey }
  if (measurement.status !== 'measured') {
    return verdict(stamp, 'unknown', measurement.status)
  }
  if ('unsupportedByThisOrca' in requirement) {
    return verdict(stamp, 'unknown', 'kind-not-evaluated')
  }
  if (!isEvaluatedRequirement(requirement)) {
    return verdict(stamp, 'unknown', 'malformed-requirement')
  }
  if (requirement.kind === 'command' && requirement.versionRange?.status === 'unsupported') {
    return verdict(stamp, 'unknown', 'unsupported-version-range')
  }
  if (platformFilterUnmeasured(requirement, measurement)) {
    return verdict(stamp, 'unknown', 'platform-unmeasured')
  }
  const probe = measurement.probes.find((entry) => entry.id === requirement.id)
  if (!probe) {
    return verdict(stamp, 'unknown', 'probe-missing')
  }
  if (probe.outcome === 'refused' || probe.outcome === 'failed') {
    return verdict(stamp, 'unknown', probe.reason ?? `probe-${probe.outcome}`)
  }
  if (probe.outcome === 'skipped-platform') {
    return verdict(stamp, 'unsupported', probe.reason ?? 'platform-skipped')
  }
  switch (requirement.kind) {
    case 'command':
      return classifyCommand(requirement, probe, stamp, authorization)
    case 'credential':
      return classifyCredential(requirement, probe, stamp, authorization)
    case 'agent':
      return probe.outcome === 'found'
        ? verdict(stamp, 'satisfied', 'agent-detected')
        : unmet(requirement, stamp, 'agent-not-detected', authorization)
    case 'env':
      return probe.outcome === 'found' && probe.present !== false
        ? verdict(stamp, 'satisfied', 'env-present')
        : unmet(requirement, stamp, 'env-unset', authorization)
    case 'platform':
      return verdict(stamp, 'satisfied', 'platform-matches')
  }
}

// An unreadable or unparseable contract is not "no requirements": it is unknown, by name.
export function classifyContractRead(
  contract: ContractReadState,
  hostKey: string,
  measuredAt: number,
  hostStatus: HostMeasurement['status'] = 'measured'
): RequirementVerdict | null {
  // Why: an unmeasured host also fails the read; its status is the cause, not the file.
  if (contract === 'unreadable' && hostStatus !== 'measured') {
    return verdict({ measuredAt, hostKey }, 'unknown', hostStatus)
  }
  if (contract === 'unreadable' || contract === 'unparseable') {
    return verdict({ measuredAt, hostKey }, 'unknown', `contract-${contract}`)
  }
  return null
}
