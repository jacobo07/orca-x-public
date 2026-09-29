// Empirical proof that capturing a backlog item crosses the durability barrier, in the right order.
//
// Why beside the durability gate: the gate accepts `imports durable-file-write` as evidence, a static
// text match. A store that imported the helper and then wrote with its own writeFile+rename would
// pass it. This counts the syscalls a real capture makes.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { open as actualOpen } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { isBacklogItemId } from '../../shared/backlog-identity'

/** The rename is recorded too: an fsync moved after the rename still fsyncs a file. */
const syscalls: ('fsync:file' | 'fsync:directory' | 'rename')[] = []

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof NodeFsPromises.open>) => {
      const handle = await actual.open(...args)
      const isDirectory = (await handle.stat()).isDirectory()
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property !== 'sync') {
            return Reflect.get(target, property, receiver)
          }
          // Recorded only after the real call returns: an fsync that throws is not a barrier.
          return async () => {
            const result = await target.sync()
            syscalls.push(isDirectory ? 'fsync:directory' : 'fsync:file')
            return result
          }
        }
      })
    },
    rename: async (...args: Parameters<typeof NodeFsPromises.rename>) => {
      const result = await actual.rename(...args)
      syscalls.push('rename')
      return result
    }
  }
})

/** Probe rather than assume: Windows cannot open a directory for fsync. */
async function directoryFsyncSupported(directory: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof actualOpen>> | null = null
  try {
    handle = await actualOpen(directory, 'r')
    await handle.sync()
    return true
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-backlog-fsync-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it('fsyncs the item before publishing its name', async () => {
  const { BacklogService } = await import('./backlog-service')
  const supported = await directoryFsyncSupported(root)
  syscalls.length = 0 // Discard the probe's own fsync.

  const outcome = await new BacklogService(() => root).capture({
    text: 'Ship the intent ledger',
    kind: 'engineering'
  })

  expect(outcome.outcome).toBe('published')
  expect(syscalls).toEqual(
    supported ? ['fsync:file', 'rename', 'fsync:directory'] : ['fsync:file', 'rename']
  )
})

it('reads the captured item back through a fresh service instance', async () => {
  const { BacklogService } = await import('./backlog-service')
  const published = await new BacklogService(() => root).capture({
    text: 'Ship the intent ledger',
    kind: 'engineering'
  })
  if (published.outcome !== 'published') {
    throw new Error(`capture did not publish: ${published.outcome}`)
  }

  const loaded = await new BacklogService(() => root).get(published.record.id)

  expect(isBacklogItemId(published.record.id)).toBe(true)
  expect(loaded).toEqual({ outcome: 'loaded', record: published.record })
  expect(published.record.revision).toBe(1)
  expect(published.record.projectRefs).toEqual([])
  expect(published.record.events.map((event) => event.type)).toEqual(['created'])
})

async function seededStore() {
  const { BacklogService } = await import('./backlog-service')
  const { BacklogRecordStore } = await import('./backlog-record-store')
  const { BACKLOG_ITEM_CODEC } = await import('./backlog-item-validation')
  const captured = await new BacklogService(() => root).capture({ text: 'seed', kind: 'idea' })
  if (captured.outcome !== 'published') {
    throw new Error(`precondition: capture returned ${captured.outcome}`)
  }
  const store = new BacklogRecordStore(join(root, 'items'), BACKLOG_ITEM_CODEC, () => 1)
  return { store, item: captured.record }
}

it('fsyncs a fenced mutate before publishing it', async () => {
  const { store, item } = await seededStore()
  const supported = await directoryFsyncSupported(root)
  syscalls.length = 0

  const outcome = await store.mutate(item.id, (current, ctx) => ({
    ...current,
    priority: 'low',
    events: [...current.events, { id: ctx.mintEventId(), type: 'updated', at: ctx.now, data: {} }]
  }))

  expect(outcome.outcome).toBe('published')
  expect(syscalls).toEqual(
    supported ? ['fsync:file', 'rename', 'fsync:directory'] : ['fsync:file', 'rename']
  )
})

it('never renames a vetoed mutate', async () => {
  const { store, item } = await seededStore()
  const finalPath = join(root, 'items', `${item.id}.json`)
  syscalls.length = 0

  const outcome = await store.mutate(item.id, (current, ctx) => {
    // Sync fs, so the competitor's own write is not in the log.
    writeFileSync(finalPath, `${JSON.stringify({ ...current, revision: current.revision + 1 })}\n`)
    return {
      ...current,
      events: [...current.events, { id: ctx.mintEventId(), type: 'updated', at: ctx.now, data: {} }]
    }
  })

  expect(outcome).toEqual({ outcome: 'superseded', expectedRevision: 1, actualRevision: 2 })
  expect(syscalls).toEqual(['fsync:file'])
})
