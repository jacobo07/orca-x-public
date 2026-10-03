import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMissionBriefReader } from './mission-brief-read'
import { createMissionRecordsProbe, hasMissionRecords } from './mission-records-presence'

const PLANNING = path.resolve('/w/a/.planning')

function io(tree: { dirs?: Record<string, string[]>; files?: string[] }) {
  return {
    listDirs: async (dir: string) => tree.dirs?.[path.resolve(dir)] ?? null,
    fileExists: async (file: string) => (tree.files ?? []).includes(path.resolve(file))
  }
}

describe('hasMissionRecords — the one no-mission gate', () => {
  it('has none without a .planning directory', async () => {
    expect(await hasMissionRecords(io({}), PLANNING)).toBe(false)
  })

  it('has none for an empty .planning: a folder alone is not a mission', async () => {
    expect(await hasMissionRecords(io({ dirs: { [PLANNING]: [] } }), PLANNING)).toBe(false)
  })

  it('has records with a STATE.md, a ROADMAP.md, or any workstream', async () => {
    const planning = { [PLANNING]: [] }
    const state = io({ dirs: planning, files: [path.join(PLANNING, 'STATE.md')] })
    const roadmap = io({ dirs: planning, files: [path.join(PLANNING, 'ROADMAP.md')] })
    const workstream = io({
      dirs: { [PLANNING]: ['workstreams'], [path.join(PLANNING, 'workstreams')]: ['ub'] }
    })
    expect(await hasMissionRecords(state, PLANNING)).toBe(true)
    expect(await hasMissionRecords(roadmap, PLANNING)).toBe(true)
    expect(await hasMissionRecords(workstream, PLANNING)).toBe(true)
  })

  it('makes the brief say no mission for an empty .planning even when GSD is absent', async () => {
    const read = createMissionBriefReader({
      ...io({ dirs: { [PLANNING]: [] } }),
      locate: () => ({ kind: 'local', path: path.resolve('/w/a') }),
      gsdAvailable: () => false,
      runGsd: vi.fn(),
      readStateRecord: async () => null,
      readProjectRecord: async () => null,
      listRecordFiles: async () => ({ kind: 'listed', files: [], truncated: false }),
      readMissions: async () => [],
      readGitHead: async () => ({ kind: 'unreadable' }),
      fingerprint: async () => null,
      now: () => 0
    })
    expect(await read({ hostId: 'local', workspaceKey: 'r::/w/a' })).toEqual({
      status: 'no-mission'
    })
  })
})

describe('probeMissionRecords — every row, one batched call', () => {
  const locations: Record<
    string,
    ReturnType<Parameters<typeof createMissionRecordsProbe>[0]['locate']>
  > = {
    'r::/w/a': { kind: 'local', path: path.resolve('/w/a') },
    'r::/w/b': { kind: 'local', path: path.resolve('/w/b') },
    'ssh::/x': { kind: 'remote' }
  }
  const probe = createMissionRecordsProbe({
    ...io({ dirs: { [PLANNING]: [] }, files: [path.join(PLANNING, 'STATE.md')] }),
    locate: (key) => locations[key] ?? { kind: 'unknown' }
  })

  it('answers each key by its own path, so one workspace never answers for another', async () => {
    const result = await probe({
      hostId: 'local',
      workspaceKeys: ['r::/w/a', 'r::/w/b', 'ssh::/x', 'gone::/z']
    })
    expect(result).toEqual({
      status: 'probed',
      presence: {
        'r::/w/a': 'present',
        'r::/w/b': 'absent',
        'ssh::/x': 'remote',
        'gone::/z': 'unknown'
      }
    })
  })

  it('never touches the disk for another host', async () => {
    const locate = vi.fn()
    const remote = createMissionRecordsProbe({ ...io({}), locate })
    expect(await remote({ hostId: 'ssh:box', workspaceKeys: ['r::/w/a'] })).toEqual({
      status: 'probed',
      presence: { 'r::/w/a': 'remote' }
    })
    expect(locate).not.toHaveBeenCalled()
  })

  it('reports an unreadable disk as unknown, never as absent', async () => {
    const failing = createMissionRecordsProbe({
      listDirs: async () => {
        throw new Error('EIO')
      },
      fileExists: async () => false,
      locate: () => ({ kind: 'local', path: path.resolve('/w/a') })
    })
    expect(await failing({ hostId: 'local', workspaceKeys: ['r::/w/a'] })).toEqual({
      status: 'probed',
      presence: { 'r::/w/a': 'unknown' }
    })
  })

  it('refuses malformed and oversized requests', async () => {
    for (const bad of [
      null,
      { hostId: 'local' },
      { hostId: 'local', workspaceKeys: [''] },
      { hostId: 'local', workspaceKeys: [42] },
      { hostId: 'local', workspaceKeys: Array.from({ length: 501 }, (_, i) => `k${i}`) }
    ]) {
      expect(await probe(bad)).toEqual({ status: 'unavailable', reason: 'invalid-request' })
    }
  })

  it('keeps a __proto__ key a plain key', async () => {
    const result = await probe({ hostId: 'local', workspaceKeys: ['__proto__'] })
    expect(result.status === 'probed' && Object.keys(result.presence)).toEqual(['__proto__'])
  })
})
