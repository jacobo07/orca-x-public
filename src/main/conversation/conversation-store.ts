// The durable owner of Orca conversations: one JSON record per conversation, published through
// src/main/durable-file-write.ts.
//
// Why a file per conversation and not the profile blob: the profile is rewritten whole on every
// save, so a chat appending a message would republish every repo, project and workspace session
// with it. Why not the orchestration SQLite database: it is scoped to orchestration runs, and it
// opens WAL with `synchronous = NORMAL`, which does not survive power loss — a crash-durable claim
// on top of it would be false. writeFileDurable already owns the fsync-before-rename barrier this
// tier requires and has a syscall-order proof, so this reuses it rather than minting a second one.

import { readFileSync } from 'node:fs'
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
import { durableWriteTempPath, writeFileDurable, writeFileDurableIfCurrent } from '../durable-file-write'

import { ConversationAppendQueue } from './conversation-append-queue'
import { assertDurableConversationRecord } from './conversation-record-validation'
import { parseConversationRecord } from './conversation-record-parse'

const RECORD_SUFFIX = '.json'

/**
 * Why an outcome and not a throw: being superseded is a normal race, not a fault. A late provider
 * event arriving after a newer turn was published is expected, and the caller's correct response is
 * to re-read and re-apply — which is a different response from "the disk is broken".
 */
export type ConversationAppendResult =
  | { outcome: 'published'; record: ConversationRecord }
  | { outcome: 'superseded'; expectedNextSeq: number; actualNextSeq: number }
  | { outcome: 'absent' }
  | { outcome: 'unreadable'; reason: string }
  | { outcome: 'schema-too-new'; storedVersion: number }
  | { outcome: 'unchanged'; record: ConversationRecord }

export class ConversationStore {
  private readonly queue = new ConversationAppendQueue()

  constructor(private readonly directory: string) {}

  private pathFor(id: ConversationId): string {
    // Guarded rather than trusted: an id is the filename, so a caller-supplied string that is not
    // an Orca id must never be able to name a path of its own choosing.
    if (!isConversationId(id) || id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new Error(`Refusing to resolve a path for a non-conversation id: ${String(id)}`)
    }
    return join(this.directory, `${id}${RECORD_SUFFIX}`)
  }

  /** Publish a record unconditionally. Throws rather than writing when the record carries state
   *  that must never become durable, so the refusal happens before the barrier, not after.
   *
   *  This is last-write-wins by construction and has no fence: it is for establishing a record, not
   *  for adding to one. Anything that grows a conversation goes through `append`, which serializes
   *  and fences — an unconditional republish of a whole record is exactly how a concurrent append
   *  loses the other writer's messages. */
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

  /**
   * The only way to grow a conversation. Reads, applies, and publishes inside a per-conversation
   * critical section, so two in-process appends to one conversation cannot interleave and lose each
   * other. Appends to DIFFERENT conversations still run concurrently.
   *
   * Serialization alone is not enough, because it binds only this process. `nextSeq` is captured
   * from the record that was read and re-checked on disk immediately before the rename, inside the
   * durable write's own commit veto — so a writer that was superseded between the read and the
   * publish refuses instead of overwriting newer truth. That window is the rename itself; it is
   * narrowed, not eliminated, and against a writer that honours nothing it cannot be.
   *
   * A late provider event that lost the race gets `superseded` with both watermarks, which is a
   * different answer from a fault and calls for a re-read, not a retry of the same payload.
   */
  async append(
    id: ConversationId,
    apply: (current: ConversationRecord) => ConversationRecord
  ): Promise<ConversationAppendResult> {
    // Resolved outside the queue: a non-conversation id is a programming error and must stay loud
    // rather than becoming a queued failure attributed to the conversation.
    const finalPath = this.pathFor(id)
    return this.queue.run(id, async () => {
      const loaded = await this.load(id)
      if (loaded.outcome === 'absent') {
        return { outcome: 'absent' as const }
      }
      if (loaded.outcome === 'schema-too-new') {
        // A newer Orca wrote this record. Appending would republish it in the older shape and
        // silently drop whatever the newer schema carries, so this refuses on its own terms rather
        // than as a read failure — the fix is to update Orca, not to retry.
        return { outcome: 'schema-too-new' as const, storedVersion: loaded.storedVersion }
      }
      if (loaded.outcome === 'unreadable') {
        return { outcome: 'unreadable' as const, reason: loaded.reason }
      }
      const current = loaded.record
      const expectedNextSeq = current.nextSeq
      const next = apply(current)
      if (next === current) {
        // Nothing to publish. Distinguished from a write so a caller cannot read "we wrote" from a
        // fold that decided there was nothing to add.
        return { outcome: 'unchanged' as const, record: current }
      }
      assertDurableConversationRecord(next)
      await mkdir(this.directory, { recursive: true })
      const published = await writeFileDurableIfCurrent(
        durableWriteTempPath(finalPath),
        finalPath,
        `${JSON.stringify(next, null, 2)}\n`,
        () => this.onDiskNextSeq(finalPath) === expectedNextSeq
      )
      if (!published) {
        return {
          outcome: 'superseded' as const,
          expectedNextSeq,
          actualNextSeq: this.onDiskNextSeq(finalPath) ?? -1
        }
      }
      return { outcome: 'published' as const, record: next }
    })
  }

  /**
   * Synchronous on purpose: the durable write's commit veto runs between the fsync and the rename
   * and cannot await. Reading the file again there is what keeps the check close to the effect.
   *
   * An unreadable or unparseable file answers `null`, which matches no expectation and therefore
   * refuses. Absence of an answer is not evidence that publishing is safe.
   */
  private onDiskNextSeq(finalPath: string): number | null {
    try {
      const parsed = JSON.parse(readFileSync(finalPath, 'utf-8')) as { nextSeq?: unknown }
      return typeof parsed.nextSeq === 'number' && Number.isFinite(parsed.nextSeq)
        ? parsed.nextSeq
        : null
    } catch {
      return null
    }
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
