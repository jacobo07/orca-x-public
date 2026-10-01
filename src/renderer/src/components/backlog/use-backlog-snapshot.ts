import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { readBacklogHealth, type BacklogHealthOutcome } from './backlog-client'
import { loadBacklogSnapshot, type BacklogLoadOutcome } from './backlog-snapshot'

export type BacklogSnapshotState = {
  /** null until the first load answers: a page that never loaded is loading, never empty. */
  load: BacklogLoadOutcome | null
  /** null while the health read is pending. */
  health: BacklogHealthOutcome | null
  refreshing: boolean
  /** The last refetch failed and the rows shown are from the last successful read. */
  refreshFailed: boolean
  refresh: () => Promise<void>
  refreshHealth: () => Promise<void>
}

type KeptLoad = { environmentId: string | null; load: BacklogLoadOutcome }

/**
 * Page data, event-driven: fetch on mount, on window focus while mounted, and on explicit refresh.
 * No timer, no subscription. Every sequence is generation-fenced; focus is skipped while one is in
 * flight (focus fires repeatedly around menus and dialogs).
 */
export function useBacklogSnapshot(): BacklogSnapshotState {
  const environmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId ?? null)
  const [load, setLoad] = useState<BacklogLoadOutcome | null>(null)
  const [health, setHealth] = useState<BacklogHealthOutcome | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const generation = useRef(0)
  const healthGeneration = useRef(0)
  const inFlight = useRef(false)
  const kept = useRef<KeptLoad | null>(null)

  const refresh = useCallback(async () => {
    generation.current += 1
    healthGeneration.current += 1
    const mine = generation.current
    const mineHealth = healthGeneration.current
    inFlight.current = true
    setRefreshing(true)
    const settings = { activeRuntimeEnvironmentId: environmentId }
    const [nextLoad, nextHealth] = await Promise.all([
      loadBacklogSnapshot(settings),
      readBacklogHealth(settings)
    ])
    if (mineHealth === healthGeneration.current) {
      setHealth(nextHealth)
    }
    // Why: a slower, older fetch must not overwrite the answer of a newer one.
    if (mine !== generation.current) {
      return
    }
    inFlight.current = false
    const previous = kept.current
    // A failed refetch keeps rows read from this same host and says so; it never blanks them.
    if (
      nextLoad.status !== 'ready' &&
      previous?.load.status === 'ready' &&
      previous.environmentId === environmentId
    ) {
      setRefreshFailed(true)
    } else {
      kept.current = { environmentId, load: nextLoad }
      setLoad(nextLoad)
      setRefreshFailed(false)
    }
    setRefreshing(false)
  }, [environmentId])

  const refreshHealth = useCallback(async () => {
    healthGeneration.current += 1
    const mine = healthGeneration.current
    setHealth(null)
    const nextHealth = await readBacklogHealth({ activeRuntimeEnvironmentId: environmentId })
    if (mine === healthGeneration.current) {
      setHealth(nextHealth)
    }
  }, [environmentId])

  useEffect(() => {
    void refresh()
    const onFocus = (): void => {
      if (!inFlight.current) {
        void refresh()
      }
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      generation.current += 1
      healthGeneration.current += 1
      inFlight.current = false
    }
  }, [refresh])

  return { load, health, refreshing, refreshFailed, refresh, refreshHealth }
}
