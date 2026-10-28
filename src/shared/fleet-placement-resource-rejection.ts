import type {
  NodeEligibility,
  NodeEligibilityFinding,
  NodeEligibilityFamily
} from './node-manifest-eligibility'

export type FleetResourceRejection =
  | { reason: 'insufficient-memory'; availableMemory: number; required: number }
  | { reason: 'insufficient-disk'; availableBytes: number; required: number }
  | { reason: 'insufficient-vram'; freeBytes: number; required: number }
  | { reason: 'model-not-resident'; modelId: string }
  | {
      reason: 'resource-unknown'
      family: NodeEligibilityFamily
      cause: NodeEligibilityFinding['cause']
      detail: string
    }

function unknownOf(finding: NodeEligibilityFinding): FleetResourceRejection {
  return {
    reason: 'resource-unknown',
    family: finding.family,
    cause: finding.cause,
    detail: finding.detail
  }
}

function rejectionOf(finding: NodeEligibilityFinding): FleetResourceRejection {
  const { have, need } = finding
  if (finding.cause === 'insufficient' && have !== undefined && need !== undefined) {
    if (finding.family === 'memory') {
      return { reason: 'insufficient-memory', availableMemory: have, required: need }
    }
    if (finding.family === 'disk') {
      return { reason: 'insufficient-disk', availableBytes: have, required: need }
    }
    if (finding.family === 'vram') {
      return { reason: 'insufficient-vram', freeBytes: have, required: need }
    }
  }
  if (finding.cause === 'model-not-resident') {
    return { reason: 'model-not-resident', modelId: finding.detail }
  }
  return unknownOf(finding)
}

/**
 * Ineligible and unknown both reject (an unknown read is never enough). `memoryAlreadyReported`
 * drops memory unmeasured/stale findings that the sample-unmeasured / sample-stale reasons already state.
 */
export function resourceRejectionsOf(
  eligibility: NodeEligibility,
  options: { memoryAlreadyReported: boolean }
): FleetResourceRejection[] {
  if (eligibility.verdict === 'eligible') {
    return []
  }
  return eligibility.reasons
    .filter(
      (finding) =>
        !(
          options.memoryAlreadyReported &&
          finding.family === 'memory' &&
          (finding.cause === 'unmeasured' || finding.cause === 'stale')
        )
    )
    .map(rejectionOf)
}
