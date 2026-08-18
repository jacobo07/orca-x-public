/** Cap chosen so the launcher's "View all" stays meaningful without the list growing unbounded on disk. */
export const RECENT_PROJECTS_LIMIT = 20

/** Moves `repoId` to the front, keeping each id once and trimming to RECENT_PROJECTS_LIMIT. */
export function withProjectOpened(recentProjectIds: readonly string[], repoId: string): string[] {
  if (!repoId) {
    return [...recentProjectIds]
  }
  return [repoId, ...recentProjectIds.filter((id) => id !== repoId)].slice(
    0,
    RECENT_PROJECTS_LIMIT
  )
}

/**
 * Orders projects most-recent-first. Ids the MRU never saw fall back to newest-added, so a profile
 * that predates recency tracking still shows a sensible list instead of an empty one.
 */
export function orderProjectsByRecency<T extends { id: string; addedAt: number }>(
  projects: readonly T[],
  recentProjectIds: readonly string[]
): T[] {
  const rank = new Map(recentProjectIds.map((id, index) => [id, index]))
  return [...projects].sort((a, b) => {
    const aRank = rank.get(a.id)
    const bRank = rank.get(b.id)
    if (aRank !== undefined && bRank !== undefined) {
      return aRank - bRank
    }
    // A tracked project always outranks an untracked one: it was actually opened, not merely added.
    if (aRank !== undefined) {
      return -1
    }
    if (bRank !== undefined) {
      return 1
    }
    return b.addedAt - a.addedAt
  })
}
