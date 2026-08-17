import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'

// Why this file exists: orca-data.json already carries the crash-durable contract
// persistence.profile-data-file, and loading-store/store.ts honours it. Profile transfer publishes
// the same file through a second writer, so the contract is only as strong as its weakest publisher.
const syscalls = vi.hoisted(() => {
  const calls = { recording: false, ordered: [] as string[] }
  return calls
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched = {
    ...actual,
    // Recorded after the real call returns: an fsync that throws is not a barrier, and Windows
    // fails directory fsync with EPERM while opening the directory succeeds.
    fsyncSync: (fd: number): void => {
      const kind = actual.fstatSync(fd).isDirectory() ? 'fsync:directory' : 'fsync:file'
      actual.fsyncSync(fd)
      if (syscalls.recording) {
        syscalls.ordered.push(kind)
      }
    },
    renameSync: (from: NodeFs.PathLike, to: NodeFs.PathLike): void => {
      actual.renameSync(from, to)
      if (syscalls.recording) {
        syscalls.ordered.push('rename')
      }
    }
  }
  return { ...patched, default: patched }
})

describe('profile project state durability', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-profile-state-'))
    syscalls.ordered.length = 0
    syscalls.recording = false
  })

  afterEach(() => {
    syscalls.recording = false
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('fsyncs the profile data file before publishing it', async () => {
    const { writeProfileState, readProfileState } = await import('./profile-project-state-file')
    const state = getDefaultPersistedState('/home/example')

    syscalls.recording = true
    try {
      writeProfileState('transfer-target', userDataPath, state)
    } finally {
      syscalls.recording = false
    }

    // The state must actually publish; a barrier on a write that never lands proves nothing.
    expect(readProfileState('transfer-target', userDataPath).repos).toEqual([])
    // The directory leg is best-effort by contract, so it is excluded from the ordering claim.
    // A rename that lands before the data fsync can expose a zero-length profile, which is the
    // empty-workspace failure persistence.profile-data-file exists to prevent.
    expect(
      syscalls.ordered.filter((entry) => entry !== 'fsync:directory'),
      `recorded: ${syscalls.ordered.join(' | ') || '<none>'}`
    ).toEqual(['fsync:file', 'rename'])
  })

  it('leaves no temp file behind once the transfer is published', async () => {
    const { writeProfileState } = await import('./profile-project-state-file')
    const { getOrcaProfileDataFile } = await import('./profile-index-store')
    writeProfileState('transfer-target', userDataPath, getDefaultPersistedState('/home/example'))

    const dataFile = getOrcaProfileDataFile('transfer-target', userDataPath)
    expect(readFileSync(dataFile, 'utf-8').length).toBeGreaterThan(0)
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(join(dataFile, '..')).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
