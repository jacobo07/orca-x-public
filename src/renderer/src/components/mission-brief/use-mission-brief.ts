import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { MissionBriefResult, MissionSignal } from '../../../../shared/mission-brief-types'

/**
 * The last brief read for each workspace, keyed by host and workspace so one project's brief can
 * never render under another's row. Reads happen on selection and on Refresh only; nothing polls.
 */
export type MissionBriefEntry =
  | { status: 'loading'; previous: MissionBriefResult | null }
  | { status: 'loaded'; result: MissionBriefResult }
  | { status: 'failed' }

const entries = new Map<string, MissionBriefEntry>()
const chosenWorkstreams = new Map<string, string>()
const generations = new Map<string, number>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function missionBriefKey(hostId: ExecutionHostId, workspaceKey: string): string {
  return `${hostId}\u0000${workspaceKey}`
}

export function readMissionBriefInto(
  hostId: ExecutionHostId,
  workspaceKey: string,
  refresh: boolean
): Promise<void> {
  const key = missionBriefKey(hostId, workspaceKey)
  const generation = (generations.get(key) ?? 0) + 1
  generations.set(key, generation)
  const current = entries.get(key)
  entries.set(key, {
    status: 'loading',
    previous: current?.status === 'loaded' ? current.result : null
  })
  emit()
  const workstream = chosenWorkstreams.get(key)
  const settle = (next: MissionBriefEntry): void => {
    // Why the generation: a slow earlier read must not overwrite a later one.
    if (generations.get(key) === generation) {
      entries.set(key, next)
      emit()
    }
  }
  return window.api.missionBrief
    .read({ hostId, workspaceKey, ...(workstream ? { workstream } : {}), refresh })
    .then(
      (result) => settle({ status: 'loaded', result }),
      () => settle({ status: 'failed' })
    )
}

export function getMissionBriefEntry(
  hostId: ExecutionHostId,
  workspaceKey: string
): MissionBriefEntry | undefined {
  return entries.get(missionBriefKey(hostId, workspaceKey))
}

function useEntry(key: string): MissionBriefEntry | undefined {
  // Why no version counter: every write stores a new entry object, so the snapshot changes with it.
  return useSyncExternalStore(subscribe, () => entries.get(key))
}

export function useMissionBrief(
  hostId: ExecutionHostId,
  workspaceKey: string
): {
  entry: MissionBriefEntry | undefined
  refresh: () => void
  chooseWorkstream: (workstream: string) => void
} {
  const key = missionBriefKey(hostId, workspaceKey)
  const entry = useEntry(key)
  useEffect(() => {
    if (!entries.has(key)) {
      void readMissionBriefInto(hostId, workspaceKey, false)
    }
  }, [hostId, workspaceKey, key])
  const refresh = useCallback(
    () => void readMissionBriefInto(hostId, workspaceKey, true),
    [hostId, workspaceKey]
  )
  const chooseWorkstream = useCallback(
    (workstream: string) => {
      chosenWorkstreams.set(key, workstream)
      void readMissionBriefInto(hostId, workspaceKey, false)
    },
    [hostId, workspaceKey, key]
  )
  return { entry, refresh, chooseWorkstream }
}

/** The signal of a brief already read for this row, or null when none was read. Never reads. */
export function useCachedMissionSignal(
  hostId: ExecutionHostId,
  workspaceKey: string
): { signal: MissionSignal; action: string | null } | null {
  const entry = useEntry(missionBriefKey(hostId, workspaceKey))
  const result =
    entry?.status === 'loaded' ? entry.result : entry?.status === 'loading' ? entry.previous : null
  if (result?.status !== 'read') {
    return null
  }
  const { brief } = result
  return {
    signal: brief.signal,
    action: brief.nextAction.kind === 'known' ? brief.nextAction.label : null
  }
}

/** Forget every read brief (tests). */
export function resetMissionBriefStore(): void {
  entries.clear()
  chosenWorkstreams.clear()
  generations.clear()
  emit()
}
