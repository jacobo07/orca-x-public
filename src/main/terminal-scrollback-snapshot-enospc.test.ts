// Characterization of what a full disk currently costs a scrollback snapshot.
//
// This file pins TODAY's behaviour, not the desired one: the writer catches ENOSPC, logs it, and
// returns null — the same value it returns when there is no snapshot root to write to. A caller
// holding that null cannot tell "the disk is full" from "there was nothing to store", so the
// session file publishes without the ref and the save reports success. When the propagation is
// fixed these expectations invert, and the diff between the two revisions is the evidence.
//
// Every case proves the fault was actually planted before reading the outcome. An injector that
// never fires produces null for the ordinary reason, which is indistinguishable from the defect.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const enospc = vi.hoisted(() => {
  const state = {
    armed: false,
    fired: 0,
    reset(): void {
      state.armed = false
      state.fired = 0
    },
    /** Shaped like the real thing: GEX44 measured `code=ENOSPC syscall=write` on a full ext4 loop. */
    raise(): never {
      state.fired += 1
      const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException
      error.code = 'ENOSPC'
      error.syscall = 'write'
      error.errno = -28
      throw error
    }
  }
  return state
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const open = actual.open
  const patched: Record<string, unknown> = { ...(actual as unknown as Record<string, unknown>) }
  patched.open = async (...args: Parameters<typeof open>): Promise<unknown> => {
    const handle = await open(...args)
    return new Proxy(handle, {
      get(base, prop, receiver) {
        if (prop === 'writeFile') {
          return async (payload: unknown): Promise<unknown> => {
            if (enospc.armed) {
              enospc.raise()
            }
            return (base as unknown as { writeFile: (p: unknown) => Promise<unknown> }).writeFile(
              payload
            )
          }
        }
        return Reflect.get(base, prop, receiver)
      }
    })
  }
  return { ...patched, default: patched }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const record = actual as unknown as Record<string, unknown>
  const patched: Record<string, unknown> = { ...record }
  const writeFileSync = actual.writeFileSync
  patched.writeFileSync = (...args: Parameters<typeof writeFileSync>): void => {
    if (enospc.armed) {
      enospc.raise()
    }
    writeFileSync(...args)
  }
  patched.promises = actual.promises
  return { ...patched, default: patched }
})

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

describe('terminal scrollback snapshot under ENOSPC', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-scrollback-enospc-'))
    enospc.reset()
  })

  afterEach(() => {
    enospc.reset()
    rmSync(dir, { recursive: true, force: true })
  })

  it('control: with space available the async writer returns a ref', async () => {
    const { writeTerminalScrollbackSnapshot } = await import('./terminal-scrollback-snapshots')

    const ref = await writeTerminalScrollbackSnapshot({
      tabId: 'tab-control',
      leafId: 'leaf-control',
      buffer: 'scrollback-body',
      storage: { snapshotRoot: dir }
    })

    // Without this, "returns null on ENOSPC" is satisfied by a writer that returns null always.
    expect(ref, 'the happy path must produce a ref, or the ENOSPC case proves nothing').toBeTruthy()
    expect(enospc.fired, 'the injector must not fire on the control').toBe(0)
  })

  it('characterizes: ENOSPC is collapsed into the same null as having nowhere to write', async () => {
    const { writeTerminalScrollbackSnapshot } = await import('./terminal-scrollback-snapshots')

    enospc.armed = true
    const onFullDisk = await writeTerminalScrollbackSnapshot({
      tabId: 'tab-full',
      leafId: 'leaf-full',
      buffer: 'scrollback-body',
      storage: { snapshotRoot: dir }
    })
    enospc.armed = false

    // The plant proof. A harness that crashed before arming would reach the assertions below and
    // pass for the wrong reason — that is exactly how a failure-injection test reports a false green.
    expect(enospc.fired, 'ENOSPC was never injected; this run measured nothing').toBeGreaterThan(0)

    // Today's truth: the disk-full cause is destroyed at the catch and the caller gets a bare null.
    expect(onFullDisk).toBeNull()

    // And the null is not merely "falsy" — it is byte-identical to the null returned when the
    // writer has nowhere to put the snapshot. That indistinguishability IS the defect: one means
    // "your scrollback could not be saved", the other means "there was nothing to save".
    const noWhereToWrite = await writeTerminalScrollbackSnapshot({
      tabId: 'tab-nowhere',
      leafId: 'leaf-nowhere',
      buffer: 'scrollback-body',
      storage: { snapshotRoot: '' }
    })
    expect(onFullDisk).toStrictEqual(noWhereToWrite)
  })

  it('characterizes: the sync writer collapses ENOSPC the same way', async () => {
    const { writeTerminalScrollbackSnapshotSync } = await import('./terminal-scrollback-snapshots')

    enospc.armed = true
    const onFullDisk = writeTerminalScrollbackSnapshotSync({
      tabId: 'tab-full-sync',
      leafId: 'leaf-full-sync',
      buffer: 'scrollback-body',
      storage: { snapshotRoot: dir }
    })
    enospc.armed = false

    expect(enospc.fired, 'ENOSPC was never injected; this run measured nothing').toBeGreaterThan(0)
    expect(onFullDisk).toBeNull()
  })
})
