// IN-03: directories the first capture creates are made durable in their parents before the
// record is published. Recorded at the durable-file-write boundary, so it holds on Windows too,
// where the directory fsync itself is a best-effort no-op.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type * as DurableFileWrite from '../durable-file-write'

const calls = vi.hoisted(() => [] as string[])

vi.mock('../durable-file-write', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableFileWrite>()
  return {
    ...actual,
    syncDirectory: async (directory: string) => {
      calls.push(`sync:${directory}`)
      return actual.syncDirectory(directory)
    },
    writeFileDurableExclusive: (async (...args) => {
      calls.push('publish')
      return actual.writeFileDurableExclusive(...args)
    }) as typeof actual.writeFileDurableExclusive
  }
})

let base: string

beforeEach(() => {
  calls.length = 0
  base = mkdtempSync(join(tmpdir(), 'orca-backlog-dirsync-'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

it('fsyncs the parent of every directory the first capture creates, before publishing', async () => {
  const { BacklogService } = await import('./backlog-service')
  const root = join(base, 'backlog')
  const service = new BacklogService(() => root)

  const first = await service.capture({ text: 'First intent', kind: 'idea' })

  expect(first.outcome).toBe('published')
  expect(calls).toEqual([`sync:${resolve(base)}`, `sync:${resolve(root)}`, 'publish'])

  calls.length = 0
  const second = await service.capture({ text: 'Second intent', kind: 'idea' })

  expect(second.outcome).toBe('published')
  // Control: nothing new was created, so only the publish runs.
  expect(calls).toEqual(['publish'])
})
