import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why this file: fs-utils.writeFileAtomically is the shared writer for every Codex and Claude
// auth.json, .credentials.json and managed-auth path. A rename is atomic for readers but not
// durable, so without a barrier a power loss can leave the credential at its old bytes or at a
// zero-length inode — which reads back as "signed out" with no error to explain it.
const syscalls = vi.hoisted(() => ({ recording: false, ordered: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched = {
    ...actual,
    // Recorded only after the real call returns: an fsync that throws is not a barrier, and on
    // Windows a directory opens fine and then fails its fsync with EPERM.
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

describe('managed auth durability', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-managed-auth-'))
    syscalls.ordered.length = 0
    syscalls.recording = false
  })

  afterEach(() => {
    syscalls.recording = false
    rmSync(dir, { recursive: true, force: true })
  })

  async function recordWrite(target: string, contents: string): Promise<void> {
    const { writeFileAtomically } = await import('./fs-utils')
    syscalls.recording = true
    try {
      writeFileAtomically(target, contents, { mode: 0o600 })
    } finally {
      syscalls.recording = false
    }
  }

  it('fsyncs a managed credential before publishing it', async () => {
    const target = join(dir, 'auth.json')
    await recordWrite(target, '{"tokens":{"id_token":"fresh"}}\n')

    expect(readFileSync(target, 'utf-8')).toBe('{"tokens":{"id_token":"fresh"}}\n')
    // The directory leg is best-effort by contract, so it is excluded from the ordering claim.
    // Data-fsync before rename is the part that must hold on every platform: publishing the name
    // first is what lets a crash expose the old credential or an empty one.
    expect(
      syscalls.ordered.filter((entry) => entry !== 'fsync:directory'),
      `recorded: ${syscalls.ordered.join(' | ') || '<none>'}`
    ).toEqual(['fsync:file', 'rename'])
  })

  it('fsyncs when replacing an existing credential', async () => {
    const target = join(dir, 'auth.json')
    await recordWrite(target, 'first')
    syscalls.ordered.length = 0
    await recordWrite(target, 'second')

    expect(readFileSync(target, 'utf-8')).toBe('second')
    expect(syscalls.ordered.indexOf('fsync:file')).toBeLessThan(syscalls.ordered.indexOf('rename'))
  })

  it('leaves no credential temp file behind when the publish fails', async () => {
    const { writeFileAtomically } = await import('./fs-utils')
    const { readdirSync } = await import('node:fs')
    // A directory at the target fails the rename after the temp exists — the only window where a
    // credential temp can survive, and it holds secret bytes at 0600.
    const { mkdirSync } = await import('node:fs')
    const target = join(dir, 'occupied')
    mkdirSync(target)

    expect(() => writeFileAtomically(target, 'secret', { mode: 0o600 })).toThrow()
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
