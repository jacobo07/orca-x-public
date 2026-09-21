// Drives the REAL handlers against a REAL store on disk. The point of this file is the chain:
// a handler that returned a plausible object without the record reaching disk would satisfy any
// assertion made on its return value alone, so every case here reads back through a second service.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintConversationId } from '../../shared/conversation-identity'
import { ConversationService } from '../conversation/conversation-service'

import { createConversationIpcHandlers, type ConversationIpcHandlers } from './conversations'

let root = ''
let handlers: ConversationIpcHandlers
let readerService: ConversationService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-conv-ipc-'))
  const directory = (): string => join(root, 'conversations')
  handlers = createConversationIpcHandlers(new ConversationService(directory))
  readerService = new ConversationService(directory)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('conversation IPC handlers', () => {
  it('exposes exactly the product operations, and no storage primitive', () => {
    // Named explicitly rather than counted: a `toHaveLength(3)` would stay green if `read` were
    // swapped for `writeFile`, which is the exact mistake this boundary exists to prevent.
    expect(Object.keys(handlers).sort()).toEqual([
      'conversations:create',
      'conversations:list',
      'conversations:read'
    ])
  })

  it('creates a conversation that a separate reader can load from disk', async () => {
    const created = await handlers['conversations:create']({ title: 'first chat' })

    const loaded = await readerService.read(created.id)
    expect(loaded.outcome).toBe('loaded')
    if (loaded.outcome !== 'loaded') {
      throw new Error('unreachable')
    }
    expect(loaded.record.title).toBe('first chat')
  })

  it('lists what was created, through the handler rather than the service', async () => {
    const created = await handlers['conversations:create']({ title: 'listed' })

    const rows = await handlers['conversations:list']()
    expect(rows.map((row) => row.id)).toEqual([created.id])
    expect(rows[0].outcome).toBe('ok')
  })

  it('reads a conversation and answers an outcome, not an exception, when it is absent', async () => {
    const created = await handlers['conversations:create']({})
    expect((await handlers['conversations:read']({ id: created.id })).outcome).toBe('loaded')

    // A well-formed id for a conversation that is not here is a normal product state.
    const absent = await handlers['conversations:read']({ id: mintConversationId() })
    expect(absent.outcome).toBe('absent')
  })

  it('refuses a value that is not a conversation id instead of reporting corrupt data', async () => {
    // Loud, because this is a renderer bug. Folding it into `unreadable` would tell the user their
    // conversation is damaged when the defect is ours.
    await expect(handlers['conversations:read']({ id: '../../etc/passwd' })).rejects.toThrow(
      /not a conversation id/
    )
    await expect(handlers['conversations:read']({ id: '' })).rejects.toThrow(/not a conversation id/)
  })

  it('does not invent a project binding when the renderer sends none', async () => {
    const created = await handlers['conversations:create']({ title: 'unbound' })
    expect(created.projectId).toBeNull()
  })
})
