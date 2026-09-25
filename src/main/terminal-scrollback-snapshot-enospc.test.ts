// What a full disk costs a scrollback snapshot.
//
// This file was born as a characterization: the writer caught ENOSPC, logged it, and returned null
// — the same value it returned when there was no snapshot root. A caller holding that null could
// not tell "the disk is full" from "there was nothing to store". These expectations have since
// been inverted against the fix, so the diff between the two revisions is the evidence that the
// cause now survives rather than a paragraph claiming it does.
//
// Every case proves the fault was actually planted before reading the outcome. An injector that
// never fires leaves the happy path running, which is indistinguishable from the defect being gone.

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

    // Without this, "reports storage-full on ENOSPC" is satisfied by a writer that never stores.
    expect(ref.status, 'the happy path must store, or the ENOSPC case proves nothing').toBe('stored')
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

    // The cause now survives the catch, with the stage that failed and the OS code intact.
    expect(onFullDisk).toStrictEqual({
      status: 'not-stored',
      failure: 'storage-full',
      code: 'ENOSPC',
      stage: 'write'
    })

    // Three outcomes that were once ONE null, now telling the caller three different things.
    // A full disk asks the user to free space; an unreachable root is a broken install; an empty
    // buffer is not a failure at all. Collapsing them is what made the first two unactionable.
    const unreachableRoot = await writeTerminalScrollbackSnapshot({
      tabId: 'tab-nowhere',
      leafId: 'leaf-nowhere',
      buffer: 'scrollback-body',
      storage: { snapshotRoot: '' }
    })
    const nothingToSave = await writeTerminalScrollbackSnapshot({
      tabId: 'tab-empty',
      leafId: 'leaf-empty',
      buffer: '',
      storage: { snapshotRoot: dir }
    })

    expect(unreachableRoot).toMatchObject({ status: 'not-stored', failure: 'storage-unavailable' })
    expect(nothingToSave).toStrictEqual({ status: 'nothing-to-store' })
    expect(onFullDisk).not.toStrictEqual(unreachableRoot)
    expect(onFullDisk).not.toStrictEqual(nothingToSave)
  })

  it('the sync writer reports storage-full the same way', async () => {
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
    // The quit path uses this variant, so it must not be the one that still loses the cause.
    expect(onFullDisk).toStrictEqual({
      status: 'not-stored',
      failure: 'storage-full',
      code: 'ENOSPC',
      stage: 'write'
    })
  })
})
