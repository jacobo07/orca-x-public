import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalSnapshot } from './types'

// Why: the writer takes `promises` off 'node:fs', while durable-file-write takes 'node:fs/promises'.
// Recording only one would make a corrected implementation invisible to these assertions.
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
    /** A handle sync belongs to the file the handle was opened on, not to the fd number. */
    recordHandleSync(target: string): void {
      if (!calls.recording || !target.startsWith(calls.dirPrefix)) {
        return
      }
      calls.ordered.push(`sync:${target}`)
    }
  }
  return calls
})

function patchPromises(actual: Record<string, unknown>): Record<string, unknown> {
  const patched: Record<string, unknown> = { ...actual }
  for (const name of ['writeFile', 'rename', 'appendFile', 'rm', 'mkdir', 'truncate']) {
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
      fsCalls.record('open', args[0])
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
  for (const name of ['fsyncSync', 'writeFileSync', 'renameSync']) {
    const fn = record[name] as ((...args: unknown[]) => unknown) | undefined
    if (!fn) {
      continue
    }
    patched[name] = (...args: unknown[]): unknown => {
      fsCalls.record(name, args[0])
      return fn(...args)
    }
  }
  patched.promises = patchPromises(record.promises as Record<string, unknown>)
  return { ...patched, default: patched }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const patched = patchPromises(actual as unknown as Record<string, unknown>)
  return { ...patched, default: patched }
})

const SESSION_ID = 'durability-repro'

function snapshot(snapshotAnsi: string): TerminalSnapshot {
  return {
    snapshotAnsi,
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd: '/workspace',
    modes: {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    },
    cols: 80,
    rows: 24,
    scrollbackLines: 500
  }
}

function indexOfMatch(entries: readonly string[], pattern: RegExp): number {
  return entries.findIndex((entry) => pattern.test(entry))
}

describe('terminal history checkpoint durability', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-durability-'))
    fsCalls.reset()
    fsCalls.dirPrefix = dir
    fsCalls.recording = false
  })

  afterEach(() => {
    fsCalls.recording = false
    rmSync(dir, { recursive: true, force: true })
  })

  async function checkpointOnce(ansi: string): Promise<void> {
    const { HistoryManager } = await import('./history-manager')
    const manager = new HistoryManager(dir)
    await manager.openSession(SESSION_ID, { cwd: '/workspace', cols: 80, rows: 24 })
    await manager.appendIncrements(SESSION_ID, 1, [{ kind: 'output', data: 'INCREMENT-ALPHA' }])
    fsCalls.recording = true
    try {
      await expect(manager.checkpoint(SESSION_ID, snapshot(ansi))).resolves.toBe('committed')
    } finally {
      fsCalls.recording = false
    }
  }

  it('fsyncs the checkpoint before publishing it with a rename', async () => {
    await checkpointOnce('durable-body')

    const renameAt = indexOfMatch(fsCalls.ordered, /^rename:.*checkpoint\.json\.tmp$|^rename:.*\.tmp$/)
    const syncAt = indexOfMatch(fsCalls.ordered, /^(sync|fsyncSync):/)

    // A rename is atomic for readers but not durable. Publishing an unsynced temp file can expose a
    // zero-length checkpoint after power loss -- the hazard durable-file-write.ts already documents.
    expect(renameAt, `no checkpoint rename recorded: ${fsCalls.ordered.join(' | ')}`).toBeGreaterThanOrEqual(0)
    expect(syncAt, `no durability barrier before rename: ${fsCalls.ordered.join(' | ')}`).toBeGreaterThanOrEqual(0)
    expect(syncAt).toBeLessThan(renameAt)
  })

  it('does not reset the incremental log before the checkpoint superseding it is durable', async () => {
    await checkpointOnce('supersede-body')

    const syncAt = indexOfMatch(fsCalls.ordered, /^(sync|fsyncSync):/)
    const logResetAt = indexOfMatch(fsCalls.ordered, /^writeFile:.*output\.log$/)

    // The log is the only fallback for a torn checkpoint; truncating it first leaves no tier below.
    expect(logResetAt, `no log reset recorded: ${fsCalls.ordered.join(' | ')}`).toBeGreaterThanOrEqual(0)
    expect(syncAt, `log reset with no preceding durability barrier: ${fsCalls.ordered.join(' | ')}`).toBeGreaterThanOrEqual(0)
    expect(syncAt).toBeLessThan(logResetAt)
  })
})
