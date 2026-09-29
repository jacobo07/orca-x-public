import type { BacklogLoadResult, BacklogWriteOutcome } from '../../shared/backlog-outcomes'
import { mintBacklogEventId } from './backlog-identity-mint'
import {
  backlogRecordPath,
  publishNewBacklogRecord,
  readBacklogRecordText,
  readOnDiskBacklogRevision,
  serializeBacklogRecord
} from './backlog-record-file'
import { BacklogRecordQueue } from './backlog-record-queue'

export type BacklogRecordCodec<R> = {
  isId: (value: unknown) => boolean
  parse: (raw: string, id: string) => BacklogLoadResult<R>
  describeDefect: (value: unknown) => string | null
}

export type BacklogFoldContext = { now: number; mintEventId: () => string }

type Fenced = { id: string; revision: number; events: readonly unknown[] }

export class BacklogRecordStore<R extends Fenced> {
  private readonly queue = new BacklogRecordQueue()

  constructor(
    private readonly directory: string,
    private readonly codec: BacklogRecordCodec<R>,
    private readonly clock: () => number
  ) {}

  /** Resolved outside the queue and any try so a malformed id is loud, not a "corrupt record". */
  private pathFor(id: string): string {
    return backlogRecordPath(this.directory, id, this.codec.isId)
  }

  async load(id: string): Promise<BacklogLoadResult<R>> {
    const finalPath = this.pathFor(id)
    const read = await readBacklogRecordText(finalPath)
    if (read.outcome === 'absent') {
      return { outcome: 'absent' }
    }
    if (read.outcome === 'unreadable') {
      return read
    }
    return this.codec.parse(read.text, id)
  }

  /** Creates a record that must not exist yet; never overwrites an existing file. */
  create(
    id: string,
    build: (context: BacklogFoldContext) => R,
    options: { onExisting: 'unchanged' | 'superseded' }
  ): Promise<BacklogWriteOutcome<R>> {
    const finalPath = this.pathFor(id)
    return this.queue.run(id, async () => {
      const record = build({ now: this.clock(), mintEventId: mintBacklogEventId })
      if (record.id !== id) {
        throw new Error('Backlog create built a record whose id differs from the requested id')
      }
      if (record.revision !== 1 || record.events.length !== 1) {
        return { outcome: 'refused', code: 'event-count', detail: 'a new record has revision 1 and one event' }
      }
      const defect = this.codec.describeDefect(record)
      if (defect !== null) {
        return { outcome: 'refused', code: 'invalid-record', detail: defect }
      }
      const serialized = serializeBacklogRecord(record)
      if (serialized.payload === undefined) {
        return serialized
      }
      const published = await publishNewBacklogRecord(finalPath, serialized.payload)
      if (published === 'published') {
        return { outcome: 'published', record }
      }
      if (published !== 'exists') {
        return published
      }
      if (options.onExisting === 'superseded') {
        return {
          outcome: 'superseded',
          expectedRevision: 0,
          actualRevision: readOnDiskBacklogRevision(finalPath) ?? -1
        }
      }
      const existing = await this.load(id)
      return existing.outcome === 'loaded'
        ? { outcome: 'unchanged', record: existing.record }
        : existing
    })
  }
}
