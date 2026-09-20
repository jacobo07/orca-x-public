// Empirical proof that saving a conversation crosses the durability barrier, in the right order.
//
// Why this exists beside the primitive's own syscall proof: the durability gate accepts
// `imports durable-file-write` as evidence of a barrier, and that is a static text match. It shows
// the module mentions the primitive, not that a save actually goes through it — a store that
// imported the helper and then wrote with its own writeFile+rename would satisfy the gate and
// still lose the newest conversation to a power cut. This counts the syscalls a real save makes.

import { mkdtempSync, rmSync } from 'node:fs'
import { open as actualOpen } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { mintConversationId } from '../../shared/conversation-identity'
import { CONVERSATION_RECORD_SCHEMA_VERSION } from '../../shared/conversation-types'

/** The rename is recorded too: an fsync moved after the rename still fsyncs a file, so a
 *  fsync-only log reads identically for the correct and the broken order. */
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
          // On Windows opening a directory succeeds and syncing it fails, so recording the
          // attempt would claim a barrier the platform never provided.
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

/** Probe rather than assume: Windows cannot open a directory for fsync, and some filesystems
 *  reject it, so the expectation tracks this platform instead of a hardcoded OS list. */
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

it('fsyncs the conversation before publishing its name', async () => {
  const { ConversationStore } = await import('./conversation-store')
  const directory = mkdtempSync(join(tmpdir(), 'orca-conversation-fsync-'))
  try {
    const supported = await directoryFsyncSupported(directory)
    const id = mintConversationId()
    syscalls.length = 0 // Discard the probe's own fsync.

    await new ConversationStore(directory).save({
      schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
      id,
      title: null,
      createdAt: 1,
      updatedAt: 1,
      status: 'active',
      projectId: null,
      provenance: [],
      turns: [],
      messages: [],
      nextSeq: 0
    })

    // The data fsync must precede the rename: that ordering is the whole barrier. Publishing the
    // name first is what lets a crash expose a stale or zero-length conversation.
    expect(syscalls).toEqual(
      supported ? ['fsync:file', 'rename', 'fsync:directory'] : ['fsync:file', 'rename']
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
