import path from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  MissionRecordsPresence,
  MissionRecordsProbeResult
} from '../../shared/mission-brief-types'
import type { MissionWorkspaceLocation } from './mission-workspace-location'

export type MissionRecordsIo = {
  /** Directory names under `dir`, or `null` when it does not exist. */
  listDirs: (dir: string) => Promise<string[] | null>
  fileExists: (file: string) => Promise<boolean>
}

/**
 * The read's own no-mission gate: a `.planning` with a roadmap, a state file or a workstream.
 * The brief and the Resume Center row both ask here, so they cannot disagree about "no mission".
 */
export async function hasMissionRecords(
  io: MissionRecordsIo,
  planningDir: string
): Promise<boolean> {
  if ((await io.listDirs(planningDir)) === null) {
    return false
  }
  const workstreams = (await io.listDirs(path.join(planningDir, 'workstreams'))) ?? []
  if (workstreams.length > 0) {
    return true
  }
  const [roadmap, state] = await Promise.all([
    io.fileExists(path.join(planningDir, 'ROADMAP.md')),
    io.fileExists(path.join(planningDir, 'STATE.md'))
  ])
  return roadmap || state
}

// Why a cap: a desk lists every workspace the person ever opened; the probe never reads unbounded.
const MAX_KEYS = 500
const MAX_KEY_LENGTH = 1024
// Why a small pool: each probe is a few stats, but a desk of hundreds must not open hundreds at once.
const CONCURRENCY = 8

export function createMissionRecordsProbe(
  deps: MissionRecordsIo & { locate: (workspaceKey: string) => MissionWorkspaceLocation }
) {
  async function presenceOf(workspaceKey: string): Promise<MissionRecordsPresence> {
    const location = deps.locate(workspaceKey)
    if (location.kind !== 'local') {
      return location.kind
    }
    try {
      return (await hasMissionRecords(deps, path.join(location.path, '.planning')))
        ? 'present'
        : 'absent'
    } catch {
      return 'unknown'
    }
  }

  return async function probeMissionRecords(request: unknown): Promise<MissionRecordsProbeResult> {
    const r = request && typeof request === 'object' ? (request as Record<string, unknown>) : null
    const keys = r?.workspaceKeys
    if (
      !r ||
      typeof r.hostId !== 'string' ||
      !Array.isArray(keys) ||
      keys.length > MAX_KEYS ||
      !keys.every((key) => typeof key === 'string' && key && key.length <= MAX_KEY_LENGTH)
    ) {
      return { status: 'unavailable', reason: 'invalid-request' }
    }
    const unique = [...new Set(keys as string[])]
    // Why no prototype: keys come from the caller, and `__proto__` must stay a plain key.
    const presence = Object.create(null) as Record<string, MissionRecordsPresence>
    if (r.hostId !== LOCAL_EXECUTION_HOST_ID) {
      for (const key of unique) {
        presence[key] = 'remote'
      }
      return { status: 'probed', presence }
    }
    for (let i = 0; i < unique.length; i += CONCURRENCY) {
      const batch = unique.slice(i, i + CONCURRENCY)
      const answers = await Promise.all(batch.map(presenceOf))
      batch.forEach((key, index) => {
        presence[key] = answers[index]
      })
    }
    return { status: 'probed', presence }
  }
}
