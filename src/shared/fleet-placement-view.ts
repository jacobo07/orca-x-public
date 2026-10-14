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

export type FleetSshHostUnknownReason =
  | 'not-connected'
  | 'unreachable'
  | 'timeout'
  | 'malformed'

/** One saved SSH target as the relay answered it. Unmeasured carries no numbers, never zeros. */
export type FleetSshHostObservation =
  | {
      targetId: string
      address: `ssh:${string}`
      label: string
      outcome: 'measured'
      /** The observer's clock before the relay call; never a time the remote reports. */
      observedAt: number
      /** The observer's clock when the reply arrived. */
      answeredAt: number
      relayUptimeMs: number
      relayCapabilities: string[]
    }
  | {
      targetId: string
      address: `ssh:${string}`
      label: string
      outcome: 'unknown'
      observedAt: number
      reason: FleetSshHostUnknownReason
      /** Connection status at observation; `null` = the manager had no state. */
      connection: string | null
      detail: string
    }

export type FleetObservation = {
  observedAt: number
  /** Same clock as every sample's `startedAt`; plans judge age against this, not their own. */
  completedAt: number
  members: FleetPlacementMember[]
  /** What this view covers; SSH targets carry no Orca key, so they are listed in `sshHosts`, not as placement members. */
  coverage: {
    runtimeEnvironments: number
    /** `enumerated` only when the host listed its saved targets; an older host says `not-enumerated`. */
    sshTargets: 'not-enumerated' | 'enumerated'
    /** Optional sibling, present with `enumerated`: one entry per saved target, measured or unknown. */
    sshHosts?: FleetSshHostObservation[]
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
