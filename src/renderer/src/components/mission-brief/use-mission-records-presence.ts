import { useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  MissionBriefResult,
  MissionRecordsPresence,
  MissionSignal
} from '../../../../shared/mission-brief-types'
import { missionBriefKey } from './use-mission-brief'

/**
 * Which desk workspaces hold mission records, asked once per desk read in one batch. Keyed like the
 * brief (host + workspace), so a row can only ever show its own workspace's answer.
 */
const presence = new Map<string, MissionRecordsPresence>()
const listeners = new Set<() => void>()
let generation = 0

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Replaces every answer: a refresh must not keep a workspace's previous "present". */
export async function probeMissionRecordsInto(
  rows: readonly { hostId: ExecutionHostId; key: string }[]
): Promise<void> {
  const current = ++generation
  presence.clear()
  emit()
  const byHost = new Map<ExecutionHostId, string[]>()
  for (const row of rows) {
    byHost.set(row.hostId, [...(byHost.get(row.hostId) ?? []), row.key])
  }
  await Promise.all(
    [...byHost].map(async ([hostId, workspaceKeys]) => {
      const result = await window.api.missionBrief
        .probe({ hostId, workspaceKeys })
        .catch(() => null)
      // Why the generation: a slow probe from before a refresh must not repopulate the cleared map.
      if (current !== generation || result?.status !== 'probed') {
        return
      }
      for (const key of workspaceKeys) {
        const answer = result.presence[key]
        if (answer) {
          presence.set(missionBriefKey(hostId, key), answer)
        }
      }
      emit()
    })
  )
}

export function useMissionRecordsPresence(
  hostId: ExecutionHostId,
  workspaceKey: string
): MissionRecordsPresence | undefined {
  const key = missionBriefKey(hostId, workspaceKey)
  return useSyncExternalStore(subscribe, () => presence.get(key))
}

export type RowMissionChip =
  | { kind: 'signal'; signal: MissionSignal; action: string | null }
  | { kind: 'available' }
  | null

/**
 * The row's one mission chip. A brief that was read outranks the probe: it is the fresher and
 * fuller answer, and its "no mission" removes a chip the probe drew earlier.
 */
export function rowMissionChip(
  brief: MissionBriefResult | null,
  recordsPresence: MissionRecordsPresence | undefined
): RowMissionChip {
  if (brief?.status === 'read') {
    return {
      kind: 'signal',
      signal: brief.brief.signal,
      action: brief.brief.nextAction.kind === 'known' ? brief.brief.nextAction.label : null
    }
  }
  if (brief?.status === 'no-mission') {
    return null
  }
  return recordsPresence === 'present' ? { kind: 'available' } : null
}

/** Forget every answer (tests). */
export function resetMissionRecordsPresence(): void {
  generation++
  presence.clear()
  emit()
}
