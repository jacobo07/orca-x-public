// What a full disk costs a profile project transfer. The transfer rewrites two profile data files
// (target first, then the source in move mode), so a failure at either write must leave the project
// in at least one profile and every file that was not reached byte-identical. Each case proves the
// injector fired; a fault that never ran would read as a transfer that simply worked.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import {
  ORCA_PROFILE_INDEX_SCHEMA_VERSION,
  type OrcaProfileIndex
} from '../../shared/orca-profiles'
import type { PersistedState } from '../../shared/persisted-state-types'

const fault = vi.hoisted(() => {
  const state = {
    prefix: '',
    fired: 0,
    matches(path: unknown): boolean {
      return (
        state.prefix !== '' &&
        typeof path === 'string' &&
        path.startsWith(`${state.prefix}.`) &&
        path.endsWith('.tmp')
      )
    }
  }
  return state
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched = {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>): void => {
      if (fault.matches(args[0])) {
        // Why half the payload lands first: a full disk truncates mid-write.
        actual.writeFileSync(
          args[0],
          String(args[1]).slice(0, Math.floor(String(args[1]).length / 2))
        )
        fault.fired += 1
        const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException
        error.code = 'ENOSPC'
        error.syscall = 'write'
        error.errno = -28
        throw error
      }
      actual.writeFileSync(...args)
    }
  }
  return { ...patched, default: patched }
})

const testState = { dir: '' }

vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))

function profileDataPath(profileId: string): string {
  return join(testState.dir, 'profiles', profileId, 'orca-data.json')
}

function seedProfile(profileId: string, state: PersistedState): void {
  mkdirSync(join(profileDataPath(profileId), '..'), { recursive: true })
  writeFileSync(profileDataPath(profileId), JSON.stringify(state, null, 2), 'utf-8')
}

function sha256(profileId: string): string {
  return createHash('sha256')
    .update(readFileSync(profileDataPath(profileId)))
    .digest('hex')
}

function repoPaths(profileId: string): string[] {
  const parsed = JSON.parse(readFileSync(profileDataPath(profileId), 'utf-8')) as PersistedState
  return parsed.repos.map((repo) => repo.path)
}

function tempSiblings(): string[] {
  return ['personal', 'work'].flatMap((profileId) =>
    readdirSync(join(profileDataPath(profileId), '..')).filter((name) => name.endsWith('.tmp'))
  )
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

describe('profile project transfer when the disk is full', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-transfer-enospc-'))
    fault.prefix = ''
    fault.fired = 0
    const index: OrcaProfileIndex = {
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: 'personal',
      profiles: [profileSummary('personal', 'Personal'), profileSummary('work', 'Work')]
    }
    writeFileSync(join(testState.dir, 'orca-profile-index.json'), JSON.stringify(index), 'utf-8')
    const defaults = getDefaultPersistedState('/Users/tester')
    seedProfile('personal', {
      ...defaults,
      repos: [
        {
          id: 'repo-1',
          path: '/workspace/orca',
          displayName: 'Orca',
          badgeColor: '#33aa99',
          addedAt: 100,
          kind: 'git',
          connectionId: null
        }
      ]
    })
    seedProfile('work', defaults)
  })

  afterEach(() => {
    fault.prefix = ''
    rmSync(testState.dir, { recursive: true, force: true })
  })

  async function moveProject(): Promise<unknown> {
    const { transferOrcaProfileProject } = await import('./profile-project-transfer')
    return transferOrcaProfileProject(
      { sourceProfileId: 'personal', targetProfileId: 'work', repoId: 'repo-1', mode: 'move' },
      testState.dir
    )
  }

  it('control: with space available a move publishes the project to the target and removes it from the source', async () => {
    const result = (await moveProject()) as { status: string }

    expect(result.status).toBe('transferred')
    expect(repoPaths('work')).toEqual(['/workspace/orca'])
    expect(repoPaths('personal')).toEqual([])
    expect(fault.fired).toBe(0)
  })

  it('a failed target write rejects with ENOSPC and leaves both profile files byte-identical', async () => {
    const before = { personal: sha256('personal'), work: sha256('work') }
    fault.prefix = profileDataPath('work')

    const failure = await moveProject().then(
      () => null,
      (error: NodeJS.ErrnoException & { stage?: string }) => error
    )

    expect(fault.fired, 'the injector must have run').toBe(1)
    expect(failure?.code).toBe('ENOSPC')
    expect(failure?.stage).toBe('write')
    expect({ personal: sha256('personal'), work: sha256('work') }).toEqual(before)
    expect(tempSiblings()).toEqual([])
  })

  it('a failed source write rejects with ENOSPC after the target holds the project: duplicated, never lost', async () => {
    const sourceBefore = sha256('personal')
    fault.prefix = profileDataPath('personal')

    const failure = await moveProject().then(
      () => null,
      (error: NodeJS.ErrnoException) => error
    )

    expect(fault.fired, 'the injector must have run').toBe(1)
    expect(failure?.code).toBe('ENOSPC')
    expect(repoPaths('work')).toEqual(['/workspace/orca'])
    expect(sha256('personal')).toBe(sourceBefore)
    expect(repoPaths('personal')).toEqual(['/workspace/orca'])
    expect(tempSiblings()).toEqual([])
  })
})
