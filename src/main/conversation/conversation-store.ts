// The durable owner of Orca conversations: one JSON record per conversation, published through
// src/main/durable-file-write.ts.
//
// Why a file per conversation and not the profile blob: the profile is rewritten whole on every
// save, so a chat appending a message would republish every repo, project and workspace session
// with it. Why not the orchestration SQLite database: it is scoped to orchestration runs, and it
// opens WAL with `synchronous = NORMAL`, which does not survive power loss — a crash-durable claim
// on top of it would be false. writeFileDurable already owns the fsync-before-rename barrier this
// tier requires and has a syscall-order proof, so this reuses it rather than minting a second one.

import { readFile, readdir, rm } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { isConversationId } from '../../shared/conversation-identity'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  type ConversationId,
  type ConversationLoadResult,
  type ConversationRecord
} from '../../shared/conversation-types'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

import { assertDurableConversationRecord } from './conversation-record-validation'
import { parseConversationRecord } from './conversation-record-parse'

const RECORD_SUFFIX = '.json'

export class ConversationStore {
  constructor(private readonly directory: string) {}

  private pathFor(id: ConversationId): string {
    // Guarded rather than trusted: an id is the filename, so a caller-supplied string that is not
    // an Orca id must never be able to name a path of its own choosing.
    if (!isConversationId(id) || id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new Error(`Refusing to resolve a path for a non-conversation id: ${String(id)}`)
    }
    return join(this.directory, `${id}${RECORD_SUFFIX}`)
  }

  /** Publish a record. Throws rather than writing when the record carries state that must never
   *  become durable, so the refusal happens before the barrier, not after. */
  async save(record: ConversationRecord): Promise<void> {
    assertDurableConversationRecord(record)
    const finalPath = this.pathFor(record.id)
    await mkdir(this.directory, { recursive: true })
    await writeFileDurable(
      durableWriteTempPath(finalPath),
      finalPath,
      `${JSON.stringify(record, null, 2)}\n`
    )
  }

  /** Four outcomes, never three. `unreadable` is not `absent` and neither is an empty
   *  conversation — a caller that cannot tell them apart will eventually publish the emptiness
   *  back over the user's messages. */
  async load(id: ConversationId): Promise<ConversationLoadResult> {
    // Resolved before the try: a caller passing something that is not an Orca id is a programming
    // error and must stay loud. Folding it into the catch below would report it as a corrupt
    // record, which is a statement about the user's data rather than about the call.
    const path = this.pathFor(id)
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { outcome: 'absent' }
      }
      return { outcome: 'unreadable', reason: (error as Error)?.message ?? 'read failed' }
    }
    return parseConversationRecord(raw, id)
  }

  /** Ids whose records are present on disk. Says nothing about whether each one parses — that is
   *  load()'s answer, and reporting it here would mean reading every record to list them. */
  async list(): Promise<ConversationId[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return []
      }
      throw error
    }
    return names
      .filter((name) => name.endsWith(RECORD_SUFFIX))
      .map((name) => name.slice(0, -RECORD_SUFFIX.length))
      .filter((id) => isConversationId(id))
  }

  /** Deletes the Orca record ONLY. The provider's transcript is a separate artifact under separate
   *  ownership; removing a conversation here must never reach into it. */
  async deleteRecord(id: ConversationId): Promise<void> {
    await rm(this.pathFor(id), { force: true })
  }

  static currentSchemaVersion(): number {
    return CONVERSATION_RECORD_SCHEMA_VERSION
  }
}
