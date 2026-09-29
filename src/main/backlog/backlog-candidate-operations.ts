import type { BacklogWriteOutcome } from '../../shared/backlog-outcomes'
import {
  BACKLOG_SCHEMA_VERSION,
  type BacklogCandidate,
  type BacklogCandidateSource,
  type BacklogCandidateUncertainty,
  type BacklogProjectHint
} from '../../shared/backlog-types'
import { deriveBacklogCandidateId } from './backlog-identity-mint'
import type { BacklogRecordStore } from './backlog-record-store'

export type BacklogCandidateIngestEntry = {
  source: BacklogCandidateSource
  fingerprint: string
  text: string
  uncertainty: BacklogCandidateUncertainty
  projectHint?: BacklogProjectHint | null
}

/** Compact per-entry answer: never carries the candidate text back to the caller. */
export type BacklogIngestEntryResult = {
  index: number
  id: string | null
  outcome: BacklogWriteOutcome<BacklogCandidate>['outcome']
  code: string | null
}

function hasNul(entry: BacklogCandidateIngestEntry): boolean {
  return [entry.source?.kind, entry.source?.ref, entry.fingerprint].some(
    (part) => typeof part !== 'string' || part.includes('\0')
  )
}

function codeOf(outcome: BacklogWriteOutcome<BacklogCandidate>): string | null {
  switch (outcome.outcome) {
    case 'refused':
    case 'unreadable':
      return outcome.code
    case 'storage-failed':
      return `${outcome.stage}:${outcome.code ?? 'unknown'}`
    default:
      return null
  }
}

async function ingestOne(
  store: BacklogRecordStore<BacklogCandidate>,
  entry: BacklogCandidateIngestEntry,
  index: number
): Promise<BacklogIngestEntryResult> {
  if (hasNul(entry)) {
    return { index, id: null, outcome: 'refused', code: 'invalid-record' }
  }
  const id = deriveBacklogCandidateId(entry.source.kind, entry.source.ref, entry.fingerprint)
  // An existing candidate is never rewritten, whatever its status: re-ingest cannot resurrect it.
  const outcome = await store.create(
    id,
    ({ now, mintEventId }) => ({
      schemaVersion: BACKLOG_SCHEMA_VERSION,
      id,
      fingerprint: entry.fingerprint,
      source: { ...entry.source },
      text: entry.text.trim(),
      uncertainty: entry.uncertainty,
      status: 'open',
      resolvedItemId: null,
      projectHint: entry.projectHint ?? null,
      events: [
        { id: mintEventId(), type: 'ingested', at: now, data: { adapter: entry.source.adapter } }
      ],
      revision: 1
    }),
    { onExisting: 'unchanged' }
  )
  return {
    index,
    id: outcome.outcome === 'refused' ? null : id,
    outcome: outcome.outcome,
    code: codeOf(outcome)
  }
}

/** Sequential on purpose; the RPC boundary bounds the batch at BACKLOG_INGEST_BATCH_MAX. */
export async function ingestBacklogCandidates(
  store: BacklogRecordStore<BacklogCandidate>,
  entries: readonly BacklogCandidateIngestEntry[]
): Promise<BacklogIngestEntryResult[]> {
  const results: BacklogIngestEntryResult[] = []
  for (const [index, entry] of entries.entries()) {
    results.push(await ingestOne(store, entry, index))
  }
  return results
}
