import path from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { projectMissionBrief } from '../../shared/mission-brief-projection'
import type {
  GitHeadReading,
  MissionBriefResult,
  MissionReadings,
  RalphMissionRecord,
  StateMdRecord
} from '../../shared/mission-brief-types'
import type { GsdRunner } from './gsd-tools-runner'
import type { MissionWorkspaceLocation } from './mission-workspace-location'

export type MissionBriefReadDeps = {
  locate: (workspaceKey: string) => MissionWorkspaceLocation
  gsdAvailable: () => boolean
  runGsd: GsdRunner
  /** Directory names under `dir`, or `null` when it does not exist. */
  listDirs: (dir: string) => Promise<string[] | null>
  fileExists: (file: string) => Promise<boolean>
  readStateRecord: (statePath: string) => Promise<StateMdRecord | null>
  readMissions: (workspacePath: string) => Promise<RalphMissionRecord[]>
  readGitHead: (workspacePath: string, recordedHead: string | null) => Promise<GitHeadReading>
  /** Changes whenever the planning files or HEAD change; `null` = could not tell, so never cached. */
  fingerprint: (planningDir: string, workspacePath: string) => Promise<string | null>
  now: () => number
}

type ParsedRequest = {
  workspaceKey: string
  hostId: string
  workstream: string | null
  refresh: boolean
}

const WORKSTREAM_NAME = /^[A-Za-z0-9._-]{1,64}$/
// Why two: each read spawns GSD three times, and the brief is read on demand, never in bulk.
const MAX_CONCURRENT_READS = 2

function parseRequest(request: unknown): ParsedRequest | null {
  if (!request || typeof request !== 'object') {
    return null
  }
  const r = request as Record<string, unknown>
  if (typeof r.workspaceKey !== 'string' || !r.workspaceKey || r.workspaceKey.length > 1024) {
    return null
  }
  if (typeof r.hostId !== 'string') {
    return null
  }
  if (
    r.workstream !== undefined &&
    (typeof r.workstream !== 'string' || !WORKSTREAM_NAME.test(r.workstream))
  ) {
    return null
  }
  return {
    workspaceKey: r.workspaceKey,
    hostId: r.hostId,
    workstream: (r.workstream as string | undefined) ?? null,
    refresh: r.refresh === true
  }
}

type WorkstreamChoice =
  | { kind: 'use'; workstream: string | null }
  | { kind: 'choose'; workstreams: string[] }
  | { kind: 'none' }
  | { kind: 'invalid' }

async function chooseWorkstream(
  deps: MissionBriefReadDeps,
  planningDir: string,
  requested: string | null,
  missions: RalphMissionRecord[]
): Promise<WorkstreamChoice> {
  const workstreams = (await deps.listDirs(path.join(planningDir, 'workstreams'))) ?? []
  if (requested) {
    return workstreams.includes(requested)
      ? { kind: 'use', workstream: requested }
      : { kind: 'invalid' }
  }
  const missionWorkstream = missions[0]?.workstream
  if (missionWorkstream && workstreams.includes(missionWorkstream)) {
    return { kind: 'use', workstream: missionWorkstream }
  }
  const [roadmap, state] = await Promise.all([
    deps.fileExists(path.join(planningDir, 'ROADMAP.md')),
    deps.fileExists(path.join(planningDir, 'STATE.md'))
  ])
  if (roadmap || state) {
    return { kind: 'use', workstream: null }
  }
  if (workstreams.length === 1) {
    return { kind: 'use', workstream: workstreams[0] }
  }
  return workstreams.length > 1 ? { kind: 'choose', workstreams } : { kind: 'none' }
}

export function createMissionBriefReader(deps: MissionBriefReadDeps) {
  const inFlight = new Map<string, Promise<MissionBriefResult>>()
  const cache = new Map<string, { fingerprint: string; readings: MissionReadings }>()
  let running = 0
  const waiting: (() => void)[] = []

  async function withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= MAX_CONCURRENT_READS) {
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    running++
    try {
      return await work()
    } finally {
      running--
      waiting.shift()?.()
    }
  }

  async function readUncached(request: ParsedRequest): Promise<MissionBriefResult> {
    const location = deps.locate(request.workspaceKey)
    if (location.kind === 'remote') {
      return { status: 'unavailable', reason: 'remote-host' }
    }
    if (location.kind === 'unknown') {
      return { status: 'unavailable', reason: 'workspace-unknown' }
    }
    const planningDir = path.join(location.path, '.planning')
    if ((await deps.listDirs(planningDir)) === null) {
      return { status: 'no-mission' }
    }
    if (!deps.gsdAvailable()) {
      return { status: 'unavailable', reason: 'gsd-tools-absent' }
    }
    const missions = await deps.readMissions(location.path)
    const choice = await chooseWorkstream(deps, planningDir, request.workstream, missions)
    if (choice.kind === 'invalid') {
      return { status: 'unavailable', reason: 'invalid-request' }
    }
    if (choice.kind === 'none') {
      return { status: 'no-mission' }
    }
    if (choice.kind === 'choose') {
      return { status: 'choose-workstream', workstreams: choice.workstreams }
    }

    const cacheKey = `${location.path}\u0000${choice.workstream ?? ''}`
    const fingerprint = await deps.fingerprint(planningDir, location.path)
    const cached = cache.get(cacheKey)
    if (!request.refresh && fingerprint !== null && cached?.fingerprint === fingerprint) {
      // Why re-read missions: a mission record changes without touching planning files or HEAD.
      const readings = { ...cached.readings, missions: await deps.readMissions(location.path) }
      return { status: 'read', brief: projectMissionBrief(readings, deps.now()) }
    }

    // Why sequential: three concurrent GSD processes per read would triple peak memory.
    const inspect = await deps.runGsd('planning-inspect', location.path, choice.workstream)
    if (inspect.kind === 'failed') {
      return { status: 'failed', stage: 'gsd', detail: inspect.detail }
    }
    const roadmap = await deps.runGsd('roadmap-analyze', location.path, choice.workstream)
    const smartEntry = await deps.runGsd('smart-entry', location.path, choice.workstream)
    const statePath = choice.workstream
      ? path.join(planningDir, 'workstreams', choice.workstream, 'STATE.md')
      : path.join(planningDir, 'STATE.md')
    const stateRecord = await deps.readStateRecord(statePath)
    const readings: MissionReadings = {
      workstream: choice.workstream,
      inspect: inspect.json,
      roadmap: roadmap.kind === 'ok' ? roadmap.json : null,
      smartEntry: smartEntry.kind === 'ok' ? smartEntry.json : null,
      stateRecord,
      git: await deps.readGitHead(location.path, stateRecord?.recordedHead ?? null),
      missions,
      readAt: deps.now()
    }
    if (fingerprint !== null) {
      cache.set(cacheKey, { fingerprint, readings })
    }
    return { status: 'read', brief: projectMissionBrief(readings, deps.now()) }
  }

  return function readMissionBrief(request: unknown): Promise<MissionBriefResult> {
    const parsed = parseRequest(request)
    if (!parsed) {
      return Promise.resolve({ status: 'unavailable', reason: 'invalid-request' })
    }
    if (parsed.hostId !== LOCAL_EXECUTION_HOST_ID) {
      return Promise.resolve({ status: 'unavailable', reason: 'remote-host' })
    }
    const key = `${parsed.workspaceKey}\u0000${parsed.workstream ?? ''}\u0000${parsed.refresh}`
    const existing = inFlight.get(key)
    if (existing) {
      return existing
    }
    const next = withSlot(() => readUncached(parsed))
      .catch(
        (error: unknown): MissionBriefResult => ({
          status: 'failed',
          stage: 'read',
          detail: error instanceof Error ? error.message : String(error)
        })
      )
      .finally(() => inFlight.delete(key))
    inFlight.set(key, next)
    return next
  }
}
