// Syscall-order proof for config/durability-contracts.jsonc persistence.profile-data-file, taken at
// the boundary each writer actually crosses: the store's async publish, the store's sync publish
// and the profile transfer writer. The primitive proof (durable-file-write-syscall-proof.test.ts)
// shows the helper is ordered; it cannot show the store still routes its bytes through it.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../shared/constants'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION, type OrcaProfileIndex } from '../shared/orca-profiles'
import type { PersistedState } from '../shared/persisted-state-types'
import {
  createStore,
  dataFile,
  makeRepo,
  readDataFile,
  testState
} from './persistence-test-harness'

type TraceEvent = { op: 'fsync:file' | 'fsync:directory' | 'close' | 'rename'; path: string }

const trace = vi.hoisted(() => ({ recording: false, events: [] as TraceEvent[] }))

function record(op: TraceEvent['op'], path: string): void {
  if (trace.recording) {
    trace.events.push({ op, path })
  }
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched = {
    ...actual,
    // Recorded after the real call returns: an fsync that throws is not a barrier.
    fsyncSync: (fd: number): void => {
      const op = actual.fstatSync(fd).isDirectory() ? 'fsync:directory' : 'fsync:file'
      actual.fsyncSync(fd)
      record(op, '')
    },
    renameSync: (from: NodeFs.PathLike, to: NodeFs.PathLike): void => {
      actual.renameSync(from, to)
      record('rename', String(to))
    }
  }
  return { ...patched, default: patched }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const patched: Record<string, unknown> = { ...(actual as unknown as Record<string, unknown>) }
  patched.open = async (...args: Parameters<typeof actual.open>): Promise<unknown> => {
    const handle = await actual.open(...args)
    const path = String(args[0])
    return new Proxy(handle, {
      get(base, prop) {
        if (prop === 'sync') {
          return async (): Promise<void> => {
            const isDirectory = (await base.stat()).isDirectory()
            await base.sync()
            record(isDirectory ? 'fsync:directory' : 'fsync:file', path)
          }
        }
        if (prop === 'close') {
          return async (): Promise<void> => {
            await base.close()
            record('close', path)
          }
        }
        const value = Reflect.get(base, prop, base)
        return typeof value === 'function' ? value.bind(base) : value
      }
    })
  }
  patched.rename = async (from: string, to: string): Promise<void> => {
    await actual.rename(from, to)
    record('rename', String(to))
  }
  return { ...patched, default: patched }
})

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('enc:'.length)
  }
}))

/** Windows cannot open a directory for fsync; probe the platform rather than hardcode an OS list. */
function directoryFsyncSupported(directory: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(directory, 'r')
    fsyncSync(fd)
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Nothing actionable in a probe.
      }
    }
  }
}

function profileDataPath(profileId: string): string {
  return join(testState.dir, 'profiles', profileId, 'orca-data.json')
}

function seedProfile(profileId: string, state: PersistedState): void {
  mkdirSync(join(profileDataPath(profileId), '..'), { recursive: true })
  writeFileSync(profileDataPath(profileId), JSON.stringify(state, null, 2), 'utf-8')
}

function profileSummary(id: string, name: string): OrcaProfileIndex['profiles'][number] {
  return {
    id,
    name,
    avatar: { kind: 'initials', initials: name[0], color: 'neutral' },
    kind: 'local',
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1
  }
}

describe('profile data file publish order', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-publish-order-'))
    trace.recording = false
    trace.events.length = 0
  })

  afterEach(() => {
    trace.recording = false
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('async store publish fsyncs the temp file before the rename and the directory after it', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const supported = directoryFsyncSupported(testState.dir)

    trace.recording = true
    try {
      await store.flushPendingOrThrowAsync()
    } finally {
      trace.recording = false
    }

    // A barrier on a write that never lands proves nothing.
    expect((readDataFile() as { repos: { id: string }[] }).repos.map((repo) => repo.id)).toEqual([
      'r1'
    ])
    const target = dataFile()
    const sequence = trace.events
      .filter((event) =>
        event.op === 'fsync:directory'
          ? event.path === testState.dir
          : event.op === 'rename'
            ? event.path === target
            : event.path.startsWith(`${target}.`) && event.path.endsWith('.tmp')
      )
      .map((event) => event.op)
    expect(sequence, `recorded: ${JSON.stringify(trace.events)}`).toEqual(
      supported
        ? ['fsync:file', 'close', 'rename', 'fsync:directory']
        : ['fsync:file', 'close', 'rename']
    )
  })

  it('sync store publish fsyncs the temp file before the rename and the directory after it', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const supported = directoryFsyncSupported(testState.dir)

    trace.recording = true
    try {
      store.flushOrThrow()
    } finally {
      trace.recording = false
    }

    expect((readDataFile() as { repos: { id: string }[] }).repos.map((repo) => repo.id)).toEqual([
      'r1'
    ])
    const sequence = trace.events
      .filter((event) => event.op !== 'rename' || event.path === dataFile())
      .map((event) => event.op)
    expect(sequence, `recorded: ${JSON.stringify(trace.events)}`).toEqual(
      supported ? ['fsync:file', 'rename', 'fsync:directory'] : ['fsync:file', 'rename']
    )
  })

  it('profile transfer publishes target then source, each fsynced before its rename and its directory after', async () => {
    const index: OrcaProfileIndex = {
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: 'personal',
      profiles: [profileSummary('personal', 'Personal'), profileSummary('work', 'Work')]
    }
    writeFileSync(join(testState.dir, 'orca-profile-index.json'), JSON.stringify(index), 'utf-8')
    const defaults = getDefaultPersistedState('/Users/tester')
    seedProfile('personal', {
      ...defaults,
      repos: [makeRepo({ id: 'repo-1', path: '/workspace/a' })]
    })
    seedProfile('work', defaults)
    const supported = directoryFsyncSupported(testState.dir)
    const { transferOrcaProfileProject } = await import('./orca-profiles/profile-project-transfer')

    trace.recording = true
    try {
      const result = transferOrcaProfileProject(
        { sourceProfileId: 'personal', targetProfileId: 'work', repoId: 'repo-1', mode: 'move' },
        testState.dir
      )
      expect(result.status).toBe('transferred')
    } finally {
      trace.recording = false
    }

    const published = (profileId: string): PersistedState =>
      JSON.parse(readFileSync(profileDataPath(profileId), 'utf-8')) as PersistedState
    expect(published('work').repos.map((repo) => repo.path)).toEqual(['/workspace/a'])
    expect(published('personal').repos).toEqual([])
    const tag = (event: TraceEvent): string =>
      event.op === 'rename' ? `rename:${basename(join(event.path, '..'))}` : event.op
    const legs = (profileId: string): string[] => [
      'fsync:file',
      `rename:${profileId}`,
      ...(supported ? ['fsync:directory'] : [])
    ]
    expect(trace.events.map(tag), `recorded: ${JSON.stringify(trace.events)}`).toEqual([
      ...legs('work'),
      ...legs('personal')
    ])
  })
})
