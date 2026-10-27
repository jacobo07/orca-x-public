export type WebContentsTimedFlags = {
  mark: (webContentsId: number, durationMs?: number) => void
  clear: (webContentsId: number) => void
  matches: (webContentsId: number, options?: { consume?: boolean }) => boolean
  size: () => number
}

/**
 * Auto-expiring intent flags, one per webContents. Why keyed: with two windows open a single slot
 * let window B's mark erase window A's, so A's reload or recovery was then misread as a crash.
 */
export function createWebContentsTimedFlags(
  defaultDurationMs = 10_000,
  now: () => number = Date.now
): WebContentsTimedFlags {
  const deadlines = new Map<number, number>()

  const pruneExpired = (): void => {
    const current = now()
    for (const [webContentsId, until] of deadlines) {
      if (current > until) {
        deadlines.delete(webContentsId)
      }
    }
  }

  return {
    mark(webContentsId, durationMs = defaultDurationMs) {
      pruneExpired()
      deadlines.set(webContentsId, now() + durationMs)
    },
    clear(webContentsId) {
      deadlines.delete(webContentsId)
    },
    matches(webContentsId, options) {
      const until = deadlines.get(webContentsId)
      if (until === undefined) {
        return false
      }
      if (now() > until) {
        deadlines.delete(webContentsId)
        return false
      }
      if (options?.consume) {
        deadlines.delete(webContentsId)
      }
      return true
    },
    size: () => deadlines.size
  }
}
