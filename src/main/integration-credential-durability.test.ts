import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Why a syscall-order proof rather than a round-trip read: reading the credential back proves the
// bytes reached the page cache, not the disk. Only the fsync-before-rename ordering survives the
// power loss this file's temp-then-rename dance exists to defend against (STA-3941).
const fsCalls = vi.hoisted(() => {
  const calls = {
    recording: false,
    ordered: [] as string[],
    reset(): void {
      calls.ordered.length = 0
    },
    record(entry: string): void {
      if (calls.recording) {
        calls.ordered.push(entry)
      }
    }
  }
  return calls
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched = {
    ...actual,
    fsyncSync: (fd: number): void => {
      fsCalls.record('fsync')
      return actual.fsyncSync(fd)
    },
    renameSync: (from: NodeFs.PathLike, to: NodeFs.PathLike): void => {
      fsCalls.record('rename')
      return actual.renameSync(from, to)
    }
  }
  return { ...patched, default: patched }
})

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf-8')
  }
}))

describe('integration credential durability', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-credential-durability-'))
    fsCalls.reset()
    fsCalls.recording = false
  })

  afterEach(() => {
    fsCalls.recording = false
    rmSync(dir, { recursive: true, force: true })
  })

  it('fsyncs the credential before publishing it with a rename', async () => {
    const { writeCredentialFileAtomic } = await import('./integration-credential-file')
    const path = join(dir, 'linear-token')
    fsCalls.recording = true
    try {
      writeCredentialFileAtomic(path, Buffer.from('secret-token', 'utf-8'))
    } finally {
      fsCalls.recording = false
    }

    expect(readFileSync(path, 'utf-8')).toBe('secret-token')
    // A rename that lands before the fsync can publish a name pointing at an empty inode, which
    // reads back as "no credential" and silently logs the user out of the integration.
    expect(fsCalls.ordered, `recorded: ${fsCalls.ordered.join(' | ')}`).toEqual(['fsync', 'rename'])
  })

  it('replaces an existing credential without an unsynced window', async () => {
    const { writeCredentialFileAtomic } = await import('./integration-credential-file')
    const path = join(dir, 'jira-token')
    writeCredentialFileAtomic(path, Buffer.from('first', 'utf-8'))
    fsCalls.reset()
    fsCalls.recording = true
    try {
      writeCredentialFileAtomic(path, Buffer.from('second', 'utf-8'))
    } finally {
      fsCalls.recording = false
    }

    expect(readFileSync(path, 'utf-8')).toBe('second')
    expect(fsCalls.ordered.indexOf('fsync')).toBeLessThan(fsCalls.ordered.indexOf('rename'))
  })
})
