import type * as NodeFs from 'node:fs'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: the fs boundary models a full disk, where write(2) returns a short count instead of throwing.
const fsModel = vi.hoisted(() => ({
  mode: 'real' as 'real' | 'short-once' | 'short-then-enospc' | 'stalled',
  calls: 0
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    writeSync: ((fd: number, buffer: Buffer, offset?: number, length?: number) => {
      fsModel.calls += 1
      const start = offset ?? 0
      const want = length ?? buffer.length - start
      if (fsModel.mode === 'real') {
        return actual.writeSync(fd, buffer, start, want)
      }
      if (fsModel.mode === 'stalled') {
        return 0
      }
      if (fsModel.mode === 'short-then-enospc' && fsModel.calls > 1) {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      }
      if (fsModel.mode === 'short-once' && fsModel.calls > 1) {
        return actual.writeSync(fd, buffer, start, want)
      }
      return actual.writeSync(fd, buffer, start, Math.max(1, Math.floor(want / 2)))
    }) as typeof actual.writeSync
  }
})

const { quarantineUnreadableProfile } = await import('./unreadable-profile-quarantine')

describe('quarantineUnreadableProfile on a disk that short-writes', () => {
  let dir: string
  let dataFile: string
  const original = Buffer.from('{"repos":'.repeat(2000), 'utf-8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-quarantine-'))
    dataFile = join(dir, 'orca-data.json')
    writeFileSync(dataFile, original)
    fsModel.mode = 'real'
    fsModel.calls = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function leftovers(): string[] {
    return readdirSync(dir).filter((name) => name.startsWith('orca-data.json.unreadable-'))
  }

  it('completes a short write and the copy is byte-identical (positive control)', () => {
    fsModel.mode = 'short-once'

    const result = quarantineUnreadableProfile(dataFile)

    expect(result.ok).toBe(true)
    expect(fsModel.calls).toBeGreaterThan(1)
    if (result.ok) {
      expect(readFileSync(result.path).equals(original)).toBe(true)
    }
  })

  it('reports a failure and leaves no partial copy when the disk fills after a short write', () => {
    fsModel.mode = 'short-then-enospc'

    const result = quarantineUnreadableProfile(dataFile)

    expect(result).toEqual({ ok: false, code: 'ENOSPC' })
    expect(leftovers()).toEqual([])
    expect(readFileSync(dataFile).equals(original)).toBe(true)
  })

  it('reports a failure and removes the copy when the write makes no progress', () => {
    fsModel.mode = 'stalled'

    const result = quarantineUnreadableProfile(dataFile)

    expect(result.ok).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('does not remove an earlier quarantine when its own create fails later', () => {
    const earlier = quarantineUnreadableProfile(dataFile)
    expect(earlier.ok).toBe(true)
    fsModel.mode = 'short-then-enospc'
    fsModel.calls = 0

    const result = quarantineUnreadableProfile(dataFile)

    expect(result.ok).toBe(false)
    expect(leftovers()).toHaveLength(1)
    if (earlier.ok) {
      expect(readFileSync(earlier.path).equals(original)).toBe(true)
    }
  })
})
