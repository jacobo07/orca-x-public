// The immutable-artifact publish, counted at the module boundary: the flush must precede the link,
// an occupied name must refuse rather than be replaced, and each fault must name its own stage.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Fault = 'write' | 'sync' | 'link' | null
const recorded: ('write' | 'fsync:file' | 'link')[] = []
let fault: Fault = null

function injected(step: Exclude<Fault, null>): never {
  throw Object.assign(new Error(`injected ${step} fault`), { code: 'EIO' })
}

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      // Why only the temp path is instrumented: the directory fsync opens a handle too, and it is
      // best-effort, so it must not be counted as the barrier.
      if (!String(args[0]).endsWith('.tmp')) {
        return handle
      }
      return {
        writeFile: async (data: string | Buffer) => {
          if (fault === 'write') {
            injected('write')
          }
          await handle.writeFile(data)
          recorded.push('write')
        },
        sync: async () => {
          if (fault === 'sync') {
            injected('sync')
          }
          await handle.sync()
          recorded.push('fsync:file')
        },
        close: () => handle.close()
      }
    },
    link: async (from: string, to: string) => {
      if (fault === 'link') {
        injected('link')
      }
      await actual.link(from, to)
      recorded.push('link')
    }
  }
})

const { DurablePublishError, writeFileDurableExclusive } = await import('./durable-file-write')

describe('writeFileDurableExclusive', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-exclusive-'))
    recorded.length = 0
    fault = null
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('flushes the bytes before publishing the name, and leaves only the published file', async () => {
    const final = join(dir, 'a.json')
    await writeFileDurableExclusive(`${final}.1.tmp`, final, '{"a":1}')
    expect(recorded).toEqual(['write', 'fsync:file', 'link'])
    expect(readFileSync(final, 'utf-8')).toBe('{"a":1}')
    expect(readdirSync(dir)).toEqual(['a.json'])
  })

  it('refuses an occupied name instead of replacing it', async () => {
    const final = join(dir, 'a.json')
    writeFileSync(final, 'original', 'utf-8')
    const error = await writeFileDurableExclusive(`${final}.1.tmp`, final, 'intruder').catch(
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(DurablePublishError)
    expect(error).toMatchObject({ stage: 'publish', code: 'EEXIST' })
    expect(readFileSync(final, 'utf-8')).toBe('original')
    expect(readdirSync(dir)).toEqual(['a.json'])
  })

  for (const [injectedFault, stage] of [
    ['write', 'write'],
    ['sync', 'barrier'],
    ['link', 'publish']
  ] as const) {
    it(`reports a ${injectedFault} fault as stage ${stage} and publishes nothing`, async () => {
      const final = join(dir, 'a.json')
      fault = injectedFault
      const error = await writeFileDurableExclusive(`${final}.1.tmp`, final, 'x').catch(
        (caught: unknown) => caught
      )
      expect(error).toMatchObject({ name: 'DurablePublishError', stage, code: 'EIO' })
      expect(readdirSync(dir), 'no final name and no orphaned temp').toEqual([])
    })
  }
})
