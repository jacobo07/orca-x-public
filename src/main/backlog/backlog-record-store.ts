import { describeBacklogEventLogDefect } from '../../shared/backlog-event-log'
import type {
  BacklogLoadResult,
  BacklogRefusal,
  BacklogWriteOutcome
} from '../../shared/backlog-outcomes'
import { mintBacklogEventId } from './backlog-identity-mint'
import {
  backlogRecordPath,
  publishBacklogRevision,
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

/** Returns the next record, the same object for "no change", or a refusal. */
export type BacklogFold<R> = (current: R, context: BacklogFoldContext) => R | BacklogRefusal

/** Both keys are already held; only the two paired ids are accepted. */
export type BacklogHeldPair<R> = {
  load: (id: string) => Promise<BacklogLoadResult<R>>
  mutate: (id: string, fold: BacklogFold<R>) => Promise<BacklogWriteOutcome<R>>
}

type Fenced = { id: string; revision: number; events: readonly { id: string }[] }

function isRefusal(value: unknown): value is BacklogRefusal {
  return (value as { outcome?: unknown }).outcome === 'refused'
}

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

  private context(): BacklogFoldContext {
    return { now: this.clock(), mintEventId: mintBacklogEventId }
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
      const record = build(this.context())
      if (record.id !== id) {
        throw new Error('Backlog create built a record whose id differs from the requested id')
      }
      if (record.revision !== 1 || record.events.length !== 1) {
        return {
          outcome: 'refused',
          code: 'event-count',
          detail: 'a new record has revision 1 and one event'
        }
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

  /** Fenced read-modify-write: one appended event, revision + 1, never over a newer file. */
  mutate(id: string, fold: BacklogFold<R>): Promise<BacklogWriteOutcome<R>> {
    this.pathFor(id)
    return this.queue.run(id, () => this.applyFold(id, fold))
  }

  /** Holds both record keys in sorted order, so two opposite pair operations cannot deadlock. */
  withPair<T>(
    firstId: string,
    secondId: string,
    work: (held: BacklogHeldPair<R>) => Promise<T>
  ): Promise<T> {
    if (firstId === secondId) {
      throw new Error('Backlog withPair needs two distinct ids')
    }
    this.pathFor(firstId)
    this.pathFor(secondId)
    const [lower, higher] = firstId < secondId ? [firstId, secondId] : [secondId, firstId]
    const assertHeld = (id: string): void => {
      if (id !== lower && id !== higher) {
        throw new Error('Backlog withPair handle used for an id outside the pair')
      }
    }
    // The handle calls applyFold directly: re-entering the queue for a held key would wait forever.
    const held: BacklogHeldPair<R> = {
      load: (id) => {
        assertHeld(id)
        return this.load(id)
      },
      mutate: (id, fold) => {
        assertHeld(id)
        return this.applyFold(id, fold)
      }
    }
    return this.queue.run(lower, () => this.queue.run(higher, () => work(held)))
  }

  // Caller holds the queue key for `id` and has already validated it through pathFor.
  private async applyFold(id: string, fold: BacklogFold<R>): Promise<BacklogWriteOutcome<R>> {
    const finalPath = this.pathFor(id)
    const loaded = await this.load(id)
    if (loaded.outcome !== 'loaded') {
      return loaded
    }
    const current = loaded.record
    const expectedRevision = current.revision
    const next = fold(current, this.context())
    if (isRefusal(next)) {
      return next
    }
    if (next === current) {
      return { outcome: 'unchanged', record: current }
    }
    const eventDefect = describeBacklogEventLogDefect(current.events, next.events)
    if (eventDefect !== null) {
      return { outcome: 'refused', code: eventDefect, detail: null }
    }
    // The store owns the revision; whatever the fold or a caller put there is overwritten.
    const record = { ...next, revision: expectedRevision + 1 }
    const defect = this.codec.describeDefect(record)
    if (defect !== null) {
      return { outcome: 'refused', code: 'invalid-record', detail: defect }
    }
    const serialized = serializeBacklogRecord(record)
    if (serialized.payload === undefined) {
      return serialized
    }
    const published = await publishBacklogRevision(finalPath, serialized.payload, expectedRevision)
    return published === 'published' ? { outcome: 'published', record } : published
  }
}
