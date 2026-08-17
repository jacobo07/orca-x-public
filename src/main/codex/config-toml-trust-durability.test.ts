import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why this file: config.toml is the user's own Codex configuration — their comments, key order and
// every unrelated setting. Orca regex-edits it in place, so the write owes two things it did not
// have: a barrier, and a rule that the last known-good backup is not spent on a degenerate copy.
const syscalls = vi.hoisted(() => ({ recording: false, ordered: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched = {
    ...actual,
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

describe('codex config.toml write durability', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-codex-config-'))
    configPath = join(dir, 'config.toml')
    syscalls.ordered.length = 0
    syscalls.recording = false
  })

  afterEach(() => {
    syscalls.recording = false
    rmSync(dir, { recursive: true, force: true })
  })

  it('fsyncs the config before publishing it', async () => {
    const { writeConfigAtomically } = await import('./config-toml-trust')
    writeFileSync(configPath, '# user config\nmodel = "o3"\n', 'utf-8')

    syscalls.recording = true
    try {
      writeConfigAtomically(configPath, '# user config\nmodel = "o4"\n')
    } finally {
      syscalls.recording = false
    }

    expect(readFileSync(configPath, 'utf-8')).toContain('o4')
    // Why not an exact sequence: rolling .bak forward is itself a rename, so this publish issues
    // two. The invariant that matters is that no rename happens before the data is on disk —
    // without it, a power loss leaves config.toml zero-length, which reads back as a legitimately
    // empty document and lets the next trust edit rewrite the user's whole configuration.
    const ordered = syscalls.ordered.filter((entry) => entry !== 'fsync:directory')
    const trace = `recorded: ${ordered.join(' | ') || '<none>'}`
    expect(ordered.indexOf('fsync:file'), trace).toBe(0)
    expect(ordered.lastIndexOf('rename'), trace).toBeGreaterThan(0)
  })

  it('does not spend the last known-good backup on an empty config', async () => {
    const { writeConfigAtomically } = await import('./config-toml-trust')
    const backupPath = `${configPath}.bak`
    writeFileSync(backupPath, '# the only surviving copy\nmodel = "o3"\n', 'utf-8')
    // The state a torn write leaves behind: present, zero-length, and indistinguishable from a
    // legitimately empty document at the read boundary.
    writeFileSync(configPath, '', 'utf-8')

    writeConfigAtomically(configPath, '[hooks]\ntrusted = true\n')

    expect(readFileSync(configPath, 'utf-8')).toContain('[hooks]')
    // Rolling the backup forward from the empty file would destroy both meaningful copies in one
    // operation: the config is already gone, and the backup is the only way back.
    expect(readFileSync(backupPath, 'utf-8')).toContain('the only surviving copy')
  })

  it('still refreshes the backup from a non-empty config', async () => {
    const { writeConfigAtomically } = await import('./config-toml-trust')
    const backupPath = `${configPath}.bak`
    writeFileSync(backupPath, 'ancient\n', 'utf-8')
    writeFileSync(configPath, '# current\nmodel = "o3"\n', 'utf-8')

    writeConfigAtomically(configPath, '# current\nmodel = "o4"\n')

    // The guard must not freeze the backup: a real edit still rotates the previous good copy in.
    expect(readFileSync(backupPath, 'utf-8')).toContain('model = "o3"')
  })
})
