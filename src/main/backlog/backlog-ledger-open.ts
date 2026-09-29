import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  BacklogQuarantineEntry,
  BacklogRecordKind,
  BacklogStorageFailure
} from '../../shared/backlog-outcomes'
import { BACKLOG_OPEN_CONCURRENCY } from '../../shared/backlog-rpc-limits'
import type { BacklogCandidate, BacklogItem } from '../../shared/backlog-types'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import { BACKLOG_CANDIDATE_CODEC } from './backlog-candidate-validation'
import { BACKLOG_ITEM_CODEC } from './backlog-item-validation'
import { readBacklogRecordText } from './backlog-record-file'
import type { BacklogRecordCodec } from './backlog-record-store'

// Read-only by design: nothing here writes, renames or deletes, so a quarantined file keeps its bytes.

const RECORD_SUFFIX = '.json'

export type BacklogLedgerSnapshot = {
  outcome: 'opened'
  items: BacklogItem[]
  candidates: BacklogCandidate[]
  quarantined: BacklogQuarantineEntry[]
}

type DirectoryScan<R> = { records: R[]; quarantined: BacklogQuarantineEntry[] }

type Classified<R> = { record: R } | { entry: BacklogQuarantineEntry } | { vanished: true }

async function listRecordFileNames(directory: string): Promise<string[] | BacklogStorageFailure> {
  try {
    // Orphan temp files end in `.tmp`, so this suffix filter leaves them out.
    return (await readdir(directory)).filter((name) => name.endsWith(RECORD_SUFFIX)).sort()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return []
    }
    // Any other failure must never read as an empty ledger.
    return { outcome: 'storage-failed', stage: 'scan', code: typeof code === 'string' ? code : null }
  }
}

async function classifyRecordFile<R>(
  directory: string,
  fileName: string,
  recordKind: BacklogRecordKind,
  codec: BacklogRecordCodec<R>
): Promise<Classified<R>> {
  const id = fileName.slice(0, -RECORD_SUFFIX.length)
  const quarantine = (
    code: BacklogQuarantineEntry['code'],
    reason: string,
    knownId: string | null = id
  ): Classified<R> => ({ entry: { recordKind, fileName, id: knownId, code, reason } })
  if (!codec.isId(id)) {
    return quarantine('invalid-name', 'file name is not a record id', null)
  }
  const read = await readBacklogRecordText(join(directory, fileName))
  if (read.outcome === 'absent') {
    return { vanished: true }
  }
  if (read.outcome === 'unreadable') {
    return quarantine(read.code, read.reason)
  }
  const parsed = codec.parse(read.text, id)
  if (parsed.outcome === 'loaded') {
    return { record: parsed.record }
  }
  if (parsed.outcome === 'schema-too-new') {
    return quarantine('schema-too-new', `stored schemaVersion ${parsed.storedVersion}`)
  }
  if (parsed.outcome === 'unreadable') {
    return quarantine(parsed.code, parsed.reason)
  }
  return { vanished: true }
}

async function scanRecordDirectory<R>(
  directory: string,
  recordKind: BacklogRecordKind,
  codec: BacklogRecordCodec<R>
): Promise<DirectoryScan<R> | BacklogStorageFailure> {
  const names = await listRecordFileNames(directory)
  if (!Array.isArray(names)) {
    return names
  }
  const settled = await mapSettledWithConcurrency(names, BACKLOG_OPEN_CONCURRENCY, (name) =>
    classifyRecordFile(directory, name, recordKind, codec)
  )
  const scan: DirectoryScan<R> = { records: [], quarantined: [] }
  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : 'read threw'
      scan.quarantined.push({ recordKind, fileName: names[index], id: null, code: 'read-failed', reason })
    } else if ('record' in result.value) {
      scan.records.push(result.value.record)
    } else if ('entry' in result.value) {
      scan.quarantined.push(result.value.entry)
    }
  })
  return scan
}

/** One corrupt record never stops the ledger opening; a directory that cannot be read does. */
export async function openBacklogLedger(
  root: string
): Promise<BacklogLedgerSnapshot | BacklogStorageFailure> {
  const items = await scanRecordDirectory(join(root, 'items'), 'item', BACKLOG_ITEM_CODEC)
  if ('outcome' in items) {
    return items
  }
  const candidates = await scanRecordDirectory(
    join(root, 'candidates'),
    'candidate',
    BACKLOG_CANDIDATE_CODEC
  )
  if ('outcome' in candidates) {
    return candidates
  }
  return {
    outcome: 'opened',
    items: items.records,
    candidates: candidates.records,
    quarantined: [...items.quarantined, ...candidates.quarantined]
  }
}
