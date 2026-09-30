import type {
  BacklogHarvestCapHit,
  BacklogHarvestRefusalCode,
  BacklogHarvestSkipCounts
} from '../../../shared/backlog-harvest-report'
import type { BacklogStorageStage } from '../../../shared/backlog-outcomes'
import { BACKLOG_INGEST_BATCH_MAX } from '../../../shared/backlog-rpc-limits'
import type {
  BacklogCandidateIngestEntry,
  BacklogIngestEntryResult
} from '../backlog-candidate-operations'

export type HarvestIngestPort = {
  ingestCandidates: (
    entries: readonly BacklogCandidateIngestEntry[]
  ) => Promise<BacklogIngestEntryResult[]>
}

export type HarvestIngestTally = {
  candidatesNew: number
  candidatesDuplicate: number
  candidatesFailed: Record<string, number>
  halted: { stage: BacklogStorageStage; code: string | null } | null
}

/** What one unit's harvester hands the runner; the runner stamps unit and times. */
export type HarvestUnitResult =
  | { outcome: 'refused'; code: BacklogHarvestRefusalCode }
  | {
      outcome: 'scanned'
      seen: number
      read: number
      skipped: BacklogHarvestSkipCounts
      cap: BacklogHarvestCapHit | null
      tally: HarvestIngestTally
    }

const STORAGE_STAGES: readonly BacklogStorageStage[] = [
  'prepare',
  'scan',
  'write',
  'barrier',
  'publish'
]

// The ingest answer flattens a storage failure to "<stage>:<errno>"; split it back apart.
function haltOf(code: string | null): HarvestIngestTally['halted'] {
  const [stage, ...rest] = (code ?? '').split(':')
  const errno = rest.join(':')
  return {
    stage: STORAGE_STAGES.find((known) => known === stage) ?? 'write',
    code: errno === '' || errno === 'unknown' ? null : errno
  }
}

/** Sequential chunks of at most BACKLOG_INGEST_BATCH_MAX; a storage failure stops the run. */
export async function ingestHarvestedCandidates(
  port: HarvestIngestPort,
  entries: readonly BacklogCandidateIngestEntry[]
): Promise<HarvestIngestTally> {
  const tally: HarvestIngestTally = {
    candidatesNew: 0,
    candidatesDuplicate: 0,
    candidatesFailed: {},
    halted: null
  }
  for (let start = 0; start < entries.length; start += BACKLOG_INGEST_BATCH_MAX) {
    const results = await port.ingestCandidates(
      entries.slice(start, start + BACKLOG_INGEST_BATCH_MAX)
    )
    for (const result of results) {
      if (result.outcome === 'published') {
        tally.candidatesNew += 1
      } else if (result.outcome === 'unchanged') {
        tally.candidatesDuplicate += 1
      } else if (result.outcome === 'storage-failed') {
        tally.halted = haltOf(result.code)
      } else {
        const key = result.code ?? result.outcome
        tally.candidatesFailed[key] = (tally.candidatesFailed[key] ?? 0) + 1
      }
    }
    if (tally.halted !== null) {
      return tally
    }
  }
  return tally
}
