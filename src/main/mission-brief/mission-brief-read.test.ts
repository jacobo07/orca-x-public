import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import ubInspect from '../../shared/__fixtures__/mission-brief/backlog-ub.planning.json'
import ubRoadmap from '../../shared/__fixtures__/mission-brief/backlog-ub.roadmap.json'
import ubSmart from '../../shared/__fixtures__/mission-brief/backlog-ub.smart-entry.json'
import type { GsdCommand, GsdRun } from './gsd-tools-runner'
import { createMissionBriefReader, type MissionBriefReadDeps } from './mission-brief-read'

const WS_PATH = path.resolve('/work/orca-backlog')
const PLANNING = path.join(WS_PATH, '.planning')
const HEAD = 'a'.repeat(40)

const OUTPUT: Record<GsdCommand, unknown> = {
  'planning-inspect': ubInspect,
  'roadmap-analyze': ubRoadmap,
  'smart-entry': ubSmart
}

function deps(overrides: Partial<MissionBriefReadDeps> = {}): MissionBriefReadDeps & {
  runGsd: ReturnType<typeof vi.fn>
} {
  const runGsd = vi.fn(
    async (command: GsdCommand): Promise<GsdRun> => ({ kind: 'ok', json: OUTPUT[command] })
  )
  return {
    locate: () => ({ kind: 'local', path: WS_PATH }),
    gsdAvailable: () => true,
    runGsd,
    listDirs: async (dir) =>
      dir === PLANNING
        ? ['workstreams']
        : dir === path.join(PLANNING, 'workstreams')
          ? ['ub']
          : null,
    fileExists: async () => false,
    readStateRecord: async () => ({
      recordedHead: HEAD,
      positionPhase: null,
      blockers: null,
      ownerDecisions: []
    }),
    readProjectRecord: async () => null,
    listRecordFiles: async () => ({ kind: 'listed', files: [], truncated: false }),
    readMissions: async () => [],
    readGitHead: async () => ({ kind: 'read', head: HEAD, commitsSinceRecorded: 0 }),
    fingerprint: async () => 'fp-1',
    now: () => 1_000,
    ...overrides
  } as MissionBriefReadDeps & { runGsd: ReturnType<typeof vi.fn> }
}

const REQUEST = { hostId: 'local', workspaceKey: 'repo-1::/work/orca-backlog' }

describe('readMissionBrief — which workspace, which host', () => {
  it('refuses a remote host before touching the disk', async () => {
    const d = deps()
    const result = await createMissionBriefReader(d)({ ...REQUEST, hostId: 'ssh:box' })
    expect(result).toEqual({ status: 'unavailable', reason: 'remote-host' })
    expect(d.runGsd).not.toHaveBeenCalled()
  })

  it('refuses a local-partition workspace whose repo lives on another machine', async () => {
    const result = await createMissionBriefReader(deps({ locate: () => ({ kind: 'remote' }) }))(
      REQUEST
    )
    expect(result).toEqual({ status: 'unavailable', reason: 'remote-host' })
  })

  it('reports no mission when the workspace has no .planning', async () => {
    const result = await createMissionBriefReader(deps({ listDirs: async () => null }))(REQUEST)
    expect(result).toEqual({ status: 'no-mission' })
  })

  it('says GSD is absent instead of reporting an empty mission', async () => {
    const result = await createMissionBriefReader(deps({ gsdAvailable: () => false }))(REQUEST)
    expect(result).toEqual({ status: 'unavailable', reason: 'gsd-tools-absent' })
  })

  it.each([
    [null],
    [{ hostId: 'local' }],
    [{ ...REQUEST, workstream: '../../etc' }],
    [{ ...REQUEST, workspaceKey: 'x'.repeat(2000) }]
  ])('refuses a malformed request %#', async (request) => {
    expect(await createMissionBriefReader(deps())(request)).toEqual({
      status: 'unavailable',
      reason: 'invalid-request'
    })
  })
})

describe('readMissionBrief — which workstream', () => {
  it('reads the only workstream and passes it to every GSD call', async () => {
    const d = deps()
    const result = await createMissionBriefReader(d)(REQUEST)
    expect(result.status).toBe('read')
    expect(d.runGsd.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ['planning-inspect', 'ub'],
      ['roadmap-analyze', 'ub'],
      ['smart-entry', 'ub']
    ])
  })

  it('asks which workstream when several exist and nothing names one', async () => {
    const d = deps({
      listDirs: async (dir) =>
        dir === PLANNING
          ? ['workstreams']
          : dir === path.join(PLANNING, 'workstreams')
            ? ['ub', 'dws']
            : null
    })
    expect(await createMissionBriefReader(d)(REQUEST)).toEqual({
      status: 'choose-workstream',
      workstreams: ['ub', 'dws']
    })
  })

  it('follows the workstream the latest mission record runs', async () => {
    const d = deps({
      listDirs: async (dir) =>
        dir === PLANNING
          ? ['workstreams']
          : dir === path.join(PLANNING, 'workstreams')
            ? ['ub', 'dws']
            : null,
      readMissions: async () => [
        {
          missionId: 'm-1',
          state: 'BLOCKED',
          reason: 'r',
          workstream: 'dws',
          heartbeatAtMs: null,
          updatedAtMs: 1
        }
      ]
    })
    const result = await createMissionBriefReader(d)(REQUEST)
    expect(result.status === 'read' && result.brief.workstream).toBe('dws')
  })

  it('refuses a workstream name main did not list', async () => {
    const result = await createMissionBriefReader(deps())({ ...REQUEST, workstream: 'other' })
    expect(result).toEqual({ status: 'unavailable', reason: 'invalid-request' })
  })
})

describe('readMissionBrief — which PROJECT.md', () => {
  const WS_PROJECT = path.join(PLANNING, 'workstreams', 'ub', 'PROJECT.md')
  const ROOT_PROJECT = path.join(PLANNING, 'PROJECT.md')

  it.each([
    ['the workstream’s own', [WS_PROJECT, ROOT_PROJECT], WS_PROJECT],
    ['the repo’s when the workstream has none', [ROOT_PROJECT], ROOT_PROJECT]
  ])('reads %s', async (_label, existing, expected) => {
    const readProjectRecord = vi.fn(async () => null)
    const d = deps({ fileExists: async (file) => existing.includes(file), readProjectRecord })
    await createMissionBriefReader(d)(REQUEST)
    expect(readProjectRecord.mock.calls).toEqual([[expected]])
  })

  it('reads no PROJECT.md when neither exists', async () => {
    const readProjectRecord = vi.fn(async () => null)
    await createMissionBriefReader(deps({ readProjectRecord }))(REQUEST)
    expect(readProjectRecord).not.toHaveBeenCalled()
  })

  it('lists the records of the workspace it read', async () => {
    const listRecordFiles = vi.fn(async () => ({
      kind: 'listed' as const,
      files: [],
      truncated: false
    }))
    await createMissionBriefReader(deps({ listRecordFiles }))(REQUEST)
    expect(listRecordFiles.mock.calls).toEqual([[PLANNING, WS_PATH]])
  })
})

describe('readMissionBrief — cost', () => {
  it('reuses a read while the planning fingerprint is unchanged, and re-reads on refresh', async () => {
    const d = deps()
    const read = createMissionBriefReader(d)
    await read(REQUEST)
    await read(REQUEST)
    expect(d.runGsd).toHaveBeenCalledTimes(3)
    await read({ ...REQUEST, refresh: true })
    expect(d.runGsd).toHaveBeenCalledTimes(6)
  })

  it('never caches when the fingerprint could not be taken', async () => {
    const d = deps({ fingerprint: async () => null })
    const read = createMissionBriefReader(d)
    await read(REQUEST)
    await read(REQUEST)
    expect(d.runGsd).toHaveBeenCalledTimes(6)
  })

  it('shares one read between concurrent requests for the same workspace', async () => {
    const d = deps()
    const read = createMissionBriefReader(d)
    await Promise.all([read(REQUEST), read(REQUEST), read(REQUEST)])
    expect(d.runGsd).toHaveBeenCalledTimes(3)
  })

  it('reports a failed planning read as failed, not as an empty mission', async () => {
    const d = deps({
      runGsd: vi.fn(async () => ({ kind: 'failed' as const, detail: 'planning-inspect: boom' }))
    })
    expect(await createMissionBriefReader(d)(REQUEST)).toEqual({
      status: 'failed',
      stage: 'gsd',
      detail: 'planning-inspect: boom'
    })
  })
})
