import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from './execution-host'
import {
  compareFleetAddresses,
  groupFleetHostsByIdentity,
  type FleetHostIdentity
} from './fleet-host-identity'
import {
  fleetSampleAgeMs,
  type FleetHostFacts,
  type FleetResourceSample,
  type FleetUnmeasuredOutcome
} from './fleet-resource-observation'

export type FleetPlacementMember = {
  address: ExecutionHostId
  label: string
  identity: FleetHostIdentity
  facts: FleetHostFacts
  sample: FleetResourceSample
}

export type FleetPlacementRequest = {
  now: number
  maxSampleAgeMs: number
  minAvailableBytes?: number
  platform?: NodeJS.Platform
  requiredCapabilities?: readonly string[]
  currentFingerprint?: string | null
}

export type FleetPlacementRejection =
  | { reason: 'identity-unavailable' }
  | { reason: 'sample-unmeasured'; outcome: FleetUnmeasuredOutcome }
  | { reason: 'sample-stale'; ageMs: number }
  | { reason: 'protocol-blocked' }
  | { reason: 'protocol-unknown' }
  | { reason: 'platform-unknown' }
  | { reason: 'platform-mismatch'; platform: NodeJS.Platform }
  | { reason: 'capabilities-unknown' }
  | { reason: 'capability-missing'; capabilities: string[] }
  | { reason: 'insufficient-memory'; availableMemory: number; required: number }

export type FleetPlacementCandidate = {
  key: string
  fingerprint: string
  label: string
  addresses: ExecutionHostId[]
  /** The member whose sample and facts were judged. */
  evidenceAddress: ExecutionHostId
  availableMemory: number
  availableMemorySource: string
  sampleAgeMs: number
  isCurrent: boolean
}

export type FleetPlacementRejected = {
  key: string
  fingerprint: string | null
  addresses: ExecutionHostId[]
  reasons: FleetPlacementRejection[]
}

// Why: a proposal authorizes nothing. An apply path must re-resolve identity, lease and state.
export type FleetPlacementProposal = {
  decision: 'selected' | 'no-eligible-host'
  selected: FleetPlacementCandidate | null
  eligible: FleetPlacementCandidate[]
  rejected: FleetPlacementRejected[]
}

// Why: the in-process reading beats a copy of the same host fetched over its own socket;
// otherwise the freshest measurement, and the address as the last, total tie-break.
function compareEvidence(a: FleetPlacementMember, b: FleetPlacementMember): number {
  const measured = Number(b.sample.outcome === 'measured') - Number(a.sample.outcome === 'measured')
  if (measured !== 0) {
    return measured
  }
  const local =
    Number(b.address === LOCAL_EXECUTION_HOST_ID) - Number(a.address === LOCAL_EXECUTION_HOST_ID)
  if (local !== 0) {
    return local
  }
  if (a.sample.startedAt !== b.sample.startedAt) {
    return b.sample.startedAt - a.sample.startedAt
  }
  return compareFleetAddresses(a.address, b.address)
}

function judge(
  member: FleetPlacementMember,
  request: FleetPlacementRequest
): FleetPlacementRejection[] {
  const reasons: FleetPlacementRejection[] = []
  if (member.identity.state !== 'keyed') {
    reasons.push({ reason: 'identity-unavailable' })
  }
  const { sample, facts } = member
  if (sample.outcome !== 'measured') {
    reasons.push({ reason: 'sample-unmeasured', outcome: sample.outcome })
  } else {
    const ageMs = fleetSampleAgeMs(sample, request.now)
    if (ageMs > request.maxSampleAgeMs) {
      reasons.push({ reason: 'sample-stale', ageMs })
    }
  }
  if (facts.protocol === 'blocked') {
    reasons.push({ reason: 'protocol-blocked' })
  } else if (facts.protocol === 'unknown') {
    reasons.push({ reason: 'protocol-unknown' })
  }
  if (request.platform) {
    if (facts.platform === null) {
      reasons.push({ reason: 'platform-unknown' })
    } else if (facts.platform !== request.platform) {
      reasons.push({ reason: 'platform-mismatch', platform: facts.platform })
    }
  }
  const required = [...new Set(request.requiredCapabilities ?? [])].sort()
  if (required.length > 0) {
    if (facts.capabilities === null) {
      reasons.push({ reason: 'capabilities-unknown' })
    } else {
      const have = new Set(facts.capabilities)
      const missing = required.filter((capability) => !have.has(capability))
      if (missing.length > 0) {
        reasons.push({ reason: 'capability-missing', capabilities: missing })
      }
    }
  }
  const minimum = request.minAvailableBytes ?? 0
  if (sample.outcome === 'measured' && minimum > 0 && sample.availableMemory < minimum) {
    reasons.push({
      reason: 'insufficient-memory',
      availableMemory: sample.availableMemory,
      required: minimum
    })
  }
  return reasons
}

/** Eligibility first; only hosts with no rejection are ranked. Deterministic for any input order. */
export function planFleetPlacement(
  members: readonly FleetPlacementMember[],
  request: FleetPlacementRequest
): FleetPlacementProposal {
  const eligible: FleetPlacementCandidate[] = []
  const rejected: FleetPlacementRejected[] = []
  for (const group of groupFleetHostsByIdentity(members)) {
    const evidence = [...group.members].sort(compareEvidence)[0]
    const reasons = judge(evidence, request)
    if (
      reasons.length > 0 ||
      group.fingerprint === null ||
      evidence.sample.outcome !== 'measured'
    ) {
      rejected.push({
        key: group.key,
        fingerprint: group.fingerprint,
        addresses: group.addresses,
        reasons
      })
      continue
    }
    eligible.push({
      key: group.key,
      fingerprint: group.fingerprint,
      label: evidence.label,
      addresses: group.addresses,
      evidenceAddress: evidence.address,
      availableMemory: evidence.sample.availableMemory,
      availableMemorySource: evidence.sample.availableMemorySource,
      sampleAgeMs: fleetSampleAgeMs(evidence.sample, request.now),
      isCurrent: group.fingerprint === request.currentFingerprint
    })
  }
  eligible.sort((a, b) => {
    if (a.availableMemory !== b.availableMemory) {
      return b.availableMemory - a.availableMemory
    }
    if (a.isCurrent !== b.isCurrent) {
      return a.isCurrent ? -1 : 1
    }
    return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0
  })
  const selected = eligible[0] ?? null
  return {
    decision: selected ? 'selected' : 'no-eligible-host',
    selected,
    eligible,
    rejected
  }
}
