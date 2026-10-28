export type RankableCandidate = {
  key: string
  fingerprint: string
  availableMemory: number
  addresses: readonly string[]
}

export type MissionRankingSignals<T extends RankableCandidate> = {
  isHydrated: (candidate: T) => boolean
  /** Jobs of this mission already placed on the candidate. */
  loadOf: (candidate: T) => number
}

/** Most free memory first, then the lower fingerprint, so equal hosts never depend on input order. */
export function compareFreeMemoryThenFingerprint(
  a: RankableCandidate,
  b: RankableCandidate
): number {
  if (a.availableMemory !== b.availableMemory) {
    return b.availableMemory - a.availableMemory
  }
  return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0
}

/** The one mission order: hydrated, then least loaded within the mission, then free memory, then fingerprint. */
export function rankMissionCandidates<T extends RankableCandidate>(
  candidates: readonly T[],
  signals: MissionRankingSignals<T>
): T[] {
  return [...candidates].sort((a, b) => {
    const hydrated = Number(signals.isHydrated(b)) - Number(signals.isHydrated(a))
    if (hydrated !== 0) {
      return hydrated
    }
    const load = signals.loadOf(a) - signals.loadOf(b)
    if (load !== 0) {
      return load
    }
    return compareFreeMemoryThenFingerprint(a, b)
  })
}
