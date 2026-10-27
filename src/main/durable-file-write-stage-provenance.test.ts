// Every durable publisher names the step that failed and keeps the OS code.
//
// Stage is the difference between "nothing was written" and "written but not flushed" — what a
// caller needs to decide whether the previous file is still trustworthy. Before this, only
// writeFileDurableExclusive threw DurablePublishError; the async, sync and rename publishers threw
// a raw errno, so four of five paths could report that a write failed and never where.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync as realWrite } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fault = vi.hoisted(() => ({
  at: 'none' as 'none' | 'write' | 'barrier' | 'publish',
  tmp: '',
  fired: 0,
  hit(stage: string, target: unknown): boolean {
    return fault.at === stage && typeof target === 'string' && target === fault.tmp
  },
  raise(): never {
    fault.fired += 1
    const error = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
    error.code = 'ENOSPC'
    throw error
  }
}))

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof NodeFsPromises>()
  const { open, rename } = actual
  const patched: Record<string, unknown> = { ...(actual as unknown as Record<string, unknown>) }

  patched.open = async (...args: Parameters<typeof open>): Promise<unknown> => {
    const handle = (await open(...args)) as unknown as Record<string, unknown>
    const target = args[0]
    return new Proxy(handle, {
      get(base, prop, receiver) {
        if (prop === 'writeFile' || prop === 'sync') {
          const stage = prop === 'writeFile' ? 'write' : 'barrier'
          return async (payload?: unknown): Promise<unknown> => {
            if (fault.hit(stage, target)) {
              fault.raise()
            }
            return (base[prop] as (p?: unknown) => Promise<unknown>).call(base, payload)
          }
        }
        return Reflect.get(base, prop, receiver)
      }
    })
  }
  patched.rename = async (...args: Parameters<typeof rename>): Promise<void> => {
    if (fault.hit('publish', args[0])) {
      fault.raise()
    }
    return rename(...args)
  }
  return { ...patched, default: patched }
})

vi.mock('node:fs', async (load) => {
  const actual = await load<typeof NodeFs>()
  const patched: Record<string, unknown> = { ...(actual as unknown as Record<string, unknown>) }
  patched.writeFileSync = (...args: Parameters<typeof actual.writeFileSync>): void => {
    if (fault.hit('write', args[0])) {
      fault.raise()
    }
    actual.writeFileSync(...args)
  }
  patched.renameSync = (...args: Parameters<typeof actual.renameSync>): void => {
    if (fault.hit('publish', args[0])) {
      fault.raise()
    }
    actual.renameSync(...args)
  }
  patched.promises = actual.promises
  return { ...patched, default: patched }
})

describe('durable publish stage provenance', () => {
  let dir: string
  let finalPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-stage-prov-'))
    finalPath = join(dir, 'state.json')
    fault.at = 'none'
    fault.fired = 0
    fault.tmp = `${finalPath}.staged.tmp`
  })

  afterEach(() => {
    fault.at = 'none'
    rmSync(dir, { recursive: true, force: true })
  })

  // Why every case asserts the fault fired: unplanted, the happy path runs and does not throw, so
  // without this the stage assertions are lines nobody reached — a textbook false green.
  async function expectStage(stage: 'write' | 'barrier' | 'publish'): Promise<void> {
    const { writeFileDurable, DurablePublishError } = await import('./durable-file-write')
    realWrite(finalPath, 'PRIOR')
    fault.at = stage
    const thrown = await writeFileDurable(fault.tmp, finalPath, 'NEXT').then(
      () => null,
      (error: unknown) => error
    )
    fault.at = 'none'

    expect(fault.fired, `the ${stage} fault never fired; this case measured nothing`).toBe(1)
    expect(thrown).toBeInstanceOf(DurablePublishError)
    const failure = thrown as InstanceType<typeof DurablePublishError>
    expect(failure.stage).toBe(stage)
    expect(failure.code).toBe('ENOSPC')
    // The old bytes surviving is the guarantee a caller may state to the user.
    expect(readFileSync(finalPath, 'utf-8')).toBe('PRIOR')
  }

  it('names the write stage', async () => expectStage('write'))
  it('names the barrier stage', async () => expectStage('barrier'))
  it('names the publish stage', async () => expectStage('publish'))

  it('names the write stage from the sync publisher', async () => {
    const { writeFileDurableSync, DurablePublishError } = await import('./durable-file-write')
    realWrite(finalPath, 'PRIOR')
    fault.at = 'write'
    let thrown: unknown = null
    try {
      writeFileDurableSync(fault.tmp, finalPath, 'NEXT')
    } catch (error) {
      thrown = error
    }
    fault.at = 'none'

    expect(fault.fired, 'the write fault never fired; this case measured nothing').toBe(1)
    expect(thrown).toBeInstanceOf(DurablePublishError)
    expect((thrown as InstanceType<typeof DurablePublishError>).stage).toBe('write')
    expect((thrown as InstanceType<typeof DurablePublishError>).code).toBe('ENOSPC')
    expect(readFileSync(finalPath, 'utf-8')).toBe('PRIOR')
  })

  it('names the publish stage when a bare rename fails', async () => {
    const { renameDurable, DurablePublishError } = await import('./durable-file-write')
    realWrite(fault.tmp, 'STAGED')
    fault.at = 'publish'
    const thrown = await renameDurable(fault.tmp, finalPath).then(
      () => null,
      (error: unknown) => error
    )
    fault.at = 'none'

    expect(fault.fired, 'the publish fault never fired; this case measured nothing').toBe(1)
    expect(thrown).toBeInstanceOf(DurablePublishError)
    expect((thrown as InstanceType<typeof DurablePublishError>).stage).toBe('publish')
  })

  it('control: unarmed, the publish succeeds and nothing throws', async () => {
    const { writeFileDurable } = await import('./durable-file-write')
    realWrite(finalPath, 'PRIOR')

    await writeFileDurable(fault.tmp, finalPath, 'NEXT')

    // Without this, a primitive that threw unconditionally would satisfy every case above.
    expect(fault.fired, 'nothing should fire on the control').toBe(0)
    expect(readFileSync(finalPath, 'utf-8')).toBe('NEXT')
  })
})
