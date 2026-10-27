// A checkpoint that could not be written must not report as one there was never anything to write.
//
// The manager caught a thrown durable write and returned 'unavailable' — the same value it returns
// for a session with no writer or a disabled one. The adapter reads 'unavailable' as "nothing to
// do", clears the session's three retry flags and answers 'done'. Because the same catch also
// disables the session, one transient full disk stopped terminal history for that session's whole
// life while every later checkpoint still said 'done'.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const enospc = vi.hoisted(() => ({
  armed: false,
  fired: 0,
  raise(): never {
    enospc.fired += 1
    const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException
    error.code = 'ENOSPC'
    throw error
  }
}))

// Only the checkpoint publish is eligible; failing every write would break openSession's own setup
// and the manager would never reach the branch under test.
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof NodeFsPromises>()
  const { open } = actual
  const patched: Record<string, unknown> = { ...(actual as unknown as Record<string, unknown>) }
  patched.open = async (...args: Parameters<typeof open>): Promise<unknown> => {
    const handle = (await open(...args)) as unknown as Record<string, unknown>
    const target = String(args[0])
    return new Proxy(handle, {
      get(base, prop, receiver) {
        if (prop === 'writeFile' && enospc.armed && target.includes('checkpoint.json')) {
          return async (): Promise<never> => enospc.raise()
        }
        return Reflect.get(base, prop, receiver)
      }
    })
  }
  return { ...patched, default: patched }
})

import { HistoryManager } from './history-manager'
import { checkpointDidNotLand } from './terminal-history-manager-options'
import type { TerminalModes, TerminalSnapshot } from './types'

const defaultModes: TerminalModes = {
  bracketedPaste: false,
  mouseTracking: false,
  applicationCursor: false,
  alternateScreen: false
}

function makeSnapshot(): TerminalSnapshot {
  return {
    snapshotAnsi: 'hello world\r\n',
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd: '/tmp',
    modes: defaultModes,
    cols: 80,
    rows: 24,
    scrollbackLines: 0
  }
}

describe('history checkpoint under storage failure', () => {
  let dir: string
  let manager: HistoryManager

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-enospc-'))
    manager = new HistoryManager(dir)
    enospc.armed = false
    enospc.fired = 0
  })

  afterEach(() => {
    enospc.armed = false
    rmSync(dir, { recursive: true, force: true })
  })

  it('control: with space available the checkpoint commits', async () => {
    await manager.openSession('sess-ok', { cwd: '/tmp', cols: 80, rows: 24 })

    const result = await manager.checkpoint('sess-ok', makeSnapshot())

    // Without this, "reports failed on ENOSPC" is satisfied by a manager that never commits.
    expect(result).toBe('committed')
    expect(enospc.fired, 'the injector must not fire on the control').toBe(0)
  })

  it('reports a full disk as failed, not as having nothing to checkpoint', async () => {
    const writeErrors: Error[] = []
    manager = new HistoryManager(dir, {
      onWriteError: (_sessionId, error) => writeErrors.push(error)
    })
    await manager.openSession('sess-full', { cwd: '/tmp', cols: 80, rows: 24 })

    enospc.armed = true
    const result = await manager.checkpoint('sess-full', makeSnapshot())
    enospc.armed = false

    // Plant proof: unarmed, this path commits, so the assertions below would pass on a manager
    // that was never asked to survive anything.
    expect(enospc.fired, 'ENOSPC was never injected; this case measured nothing').toBeGreaterThan(0)
    expect(result).toBe('failed')
    expect(result).not.toBe('unavailable')
    // The cause is not merely classified — it is handed to the error channel intact.
    expect((writeErrors.at(0) as NodeJS.ErrnoException | undefined)?.code).toBe('ENOSPC')
  })

  it('a session that was never opened still reports unavailable', async () => {
    // The distinction only pays if the other side of it survives: 'unavailable' must keep meaning
    // "there is no checkpointing here", or 'failed' has simply replaced it everywhere.
    const result = await manager.checkpoint('sess-never-opened', makeSnapshot())

    expect(result).toBe('unavailable')
    expect(enospc.fired).toBe(0)
  })

  it('the adapter predicate treats failed as not-landed and unavailable as landed', () => {
    // These four answers are what the adapter's five flag-clearing sites branch on.
    expect(checkpointDidNotLand('failed')).toBe(true)
    expect(checkpointDidNotLand('retryable')).toBe(true)
    expect(checkpointDidNotLand('committed')).toBe(false)
    // 'unavailable' stays false on purpose: there is nothing to retry for a session that has no
    // checkpointing, and keeping it dirty forever would be its own lie.
    expect(checkpointDidNotLand('unavailable')).toBe(false)
  })
})
