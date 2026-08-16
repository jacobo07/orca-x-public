import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Why both module specifiers are patched: the snapshot writer imports from 'node:fs' and
// 'node:fs/promises', while durable-file-write uses 'node:fs/promises'. Recording one alone would
// leave a corrected implementation invisible here.
const fsCalls = vi.hoisted(() => {
  const calls = {
    recording: false,
    dirPrefix: '',
    ordered: [] as string[],
    reset(): void {
      calls.ordered.length = 0
    },
    record(fn: string, target: unknown): void {
      if (!calls.recording || typeof target !== 'string' || !target.startsWith(calls.dirPrefix)) {
        return
      }
      calls.ordered.push(`${fn}:${target}`)
    },
    recordHandleSync(target: string): void {
      if (!calls.recording || !target.startsWith(calls.dirPrefix)) {
        return
      }
      calls.ordered.push(`sync:${target}`)
    },
    /** A descriptor sync carries no path to match, so it is kept whenever recording is armed. */
    recordDescriptorSync(kind: 'file' | 'directory'): void {
      if (!calls.recording) {
        return
      }
      calls.ordered.push(`fsyncSync:${kind}`)
    }
  }
  return calls
})

function patchPromises(actual: Record<string, unknown>): Record<string, unknown> {
  const patched: Record<string, unknown> = { ...actual }
  for (const name of ['writeFile', 'rename', 'rm', 'mkdir']) {
    const fn = actual[name] as ((...args: unknown[]) => unknown) | undefined
    if (!fn) {
      continue
    }
    patched[name] = (...args: unknown[]): unknown => {
      fsCalls.record(name, args[0])
      return fn(...args)
    }
  }
  const open = actual.open as ((...args: unknown[]) => Promise<unknown>) | undefined
  if (open) {
    patched.open = async (...args: unknown[]): Promise<unknown> => {
      const handle = (await open(...args)) as { sync: () => Promise<void> }
      const target = String(args[0])
      return new Proxy(handle, {
        get(base, prop, receiver) {
          if (prop === 'sync') {
            return async (): Promise<void> => {
              fsCalls.recordHandleSync(target)
              await base.sync()
            }
          }
          return Reflect.get(base, prop, receiver)
        }
      })
    }
  }
  return patched
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const record = actual as unknown as Record<string, unknown>
  const patched: Record<string, unknown> = { ...record }
  for (const name of ['writeFileSync', 'renameSync']) {
    const fn = record[name] as ((...args: unknown[]) => unknown) | undefined
    if (!fn) {
      continue
    }
    patched[name] = (...args: unknown[]): unknown => {
      fsCalls.record(name, args[0])
      return fn(...args)
    }
  }
  // Why fsyncSync is special-cased: it takes a file descriptor, not a path, so the string-prefix
  // recorder above would silently drop every sync and make a fixed implementation look unfixed.
  patched.fsyncSync = (fd: number): unknown => {
    fsCalls.recordDescriptorSync(actual.fstatSync(fd).isDirectory() ? 'directory' : 'file')
    return actual.fsyncSync(fd)
  }
  patched.promises = patchPromises(record.promises as Record<string, unknown>)
  return { ...patched, default: patched }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const patched = patchPromises(actual as unknown as Record<string, unknown>)
  return { ...patched, default: patched }
})

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

function indexOfMatch(entries: readonly string[], pattern: RegExp): number {
  return entries.findIndex((entry) => pattern.test(entry))
}

describe('terminal scrollback snapshot durability', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-scrollback-durability-'))
    fsCalls.reset()
    fsCalls.dirPrefix = dir
    fsCalls.recording = false
  })

  afterEach(() => {
    fsCalls.recording = false
    rmSync(dir, { recursive: true, force: true })
  })

  it('fsyncs an async snapshot before publishing it with a rename', async () => {
    const { writeTerminalScrollbackSnapshot } = await import('./terminal-scrollback-snapshots')
    fsCalls.recording = true
    try {
      await writeTerminalScrollbackSnapshot({
        tabId: 'tab-async',
        leafId: 'leaf-async',
        buffer: 'scrollback-body',
        storage: { snapshotRoot: dir }
      })
    } finally {
      fsCalls.recording = false
    }

    const renameAt = indexOfMatch(fsCalls.ordered, /^rename:/)
    const syncAt = indexOfMatch(fsCalls.ordered, /^sync:/)
    // The session file holding this ref is fsynced. Publishing the blob without a barrier lets the
    // durable pointer outlive its referent, and the reader reports that loss as empty history.
    expect(renameAt, `no snapshot rename recorded: ${fsCalls.ordered.join(' | ')}`).toBeGreaterThanOrEqual(0)
    expect(syncAt, `snapshot published with no durability barrier: ${fsCalls.ordered.join(' | ')}`).toBeGreaterThanOrEqual(0)
    expect(syncAt).toBeLessThan(renameAt)
  })

  it('fsyncs a sync snapshot before publishing it with a rename', async () => {
    const { writeTerminalScrollbackSnapshotSync } = await import('./terminal-scrollback-snapshots')
    fsCalls.recording = true
    try {
      writeTerminalScrollbackSnapshotSync({
        tabId: 'tab-sync',
        leafId: 'leaf-sync',
        buffer: 'scrollback-body',
        storage: { snapshotRoot: dir }
      })
    } finally {
      fsCalls.recording = false
    }

    const renameAt = indexOfMatch(fsCalls.ordered, /^renameSync:/)
    const syncAt = indexOfMatch(fsCalls.ordered, /^fsyncSync:/)
    expect(renameAt, `no snapshot rename recorded: ${fsCalls.ordered.join(' | ')}`).toBeGreaterThanOrEqual(0)
    expect(syncAt, `snapshot published with no durability barrier: ${fsCalls.ordered.join(' | ')}`).toBeGreaterThanOrEqual(0)
    expect(syncAt).toBeLessThan(renameAt)
  })
})
