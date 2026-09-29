import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { readBacklogHealth, type BacklogHealthOutcome } from './backlog-client'
import { loadBacklogSnapshot, type BacklogLoadOutcome } from './backlog-snapshot'

export type BacklogSnapshotState = {
  /** null until the first load answers: a page that never loaded is loading, never empty. */
  load: BacklogLoadOutcome | null
  health: BacklogHealthOutcome | null
  refreshing: boolean
  refresh: () => Promise<void>
}

/** Page data: fetch on mount and on explicit refresh. No timer, no subscription. */
export function useBacklogSnapshot(): BacklogSnapshotState {
  const environmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId ?? null)
  const [load, setLoad] = useState<BacklogLoadOutcome | null>(null)
  const [health, setHealth] = useState<BacklogHealthOutcome | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    generation.current += 1
    const mine = generation.current
    setRefreshing(true)
    const settings = { activeRuntimeEnvironmentId: environmentId }
    const [nextLoad, nextHealth] = await Promise.all([
      loadBacklogSnapshot(settings),
      readBacklogHealth(settings)
    ])
    // Why: a slower, older fetch must not overwrite the answer of a newer one.
    if (mine !== generation.current) {
      return
    }
    setLoad(nextLoad)
    setHealth(nextHealth)
    setRefreshing(false)
  }, [environmentId])

  useEffect(() => {
    void refresh()
    return () => {
      generation.current += 1
    }
  }, [refresh])

  return { load, health, refreshing, refresh }
}
