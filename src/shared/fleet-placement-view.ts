import type {
  FleetPlacementMember,
  FleetPlacementProposal,
  FleetPlacementRequest
} from './fleet-placement'

/** Counts only, so no fingerprint, host or key crosses the wire. */
export type FleetSshHostIdentityCounts = {
  pinned: number
  unpinnedLegacy: number
  unverifiable: number
  delegated: number
  refusedChanged: number
}

export type FleetObservation = {
  observedAt: number
  /** Same clock as every sample's `startedAt`; plans judge age against this, not their own. */
  completedAt: number
  members: FleetPlacementMember[]
  /** What this view covers; SSH targets carry no Orca key and are not enumerated yet. */
  coverage: {
    runtimeEnvironments: number
    sshTargets: 'not-enumerated'
    /** Optional sibling: an older host omits it and an older reader ignores it. */
    sshHostIdentity?: FleetSshHostIdentityCounts
  }
}

export type FleetPlacementViewParams = {
  minAvailableBytes?: number
  platform?: string
  requiredCapabilities?: string[]
  currentFingerprint?: string
  maxSampleAgeMs?: number
}

export type FleetPlacementViewResult =
  | { status: 'refused'; reason: 'remote-caller' }
  | { status: 'unavailable'; reason: 'no-fleet-reader' }
  | {
      status: 'ok'
      request: FleetPlacementRequest
      observation: FleetObservation
      proposal: FleetPlacementProposal
    }
