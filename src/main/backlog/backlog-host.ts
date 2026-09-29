import type {
  BacklogCandidateListQuery,
  BacklogCandidateListResult,
  BacklogHealth,
  BacklogListQuery,
  BacklogListResult,
  BacklogLoadResult,
  BacklogWriteOutcome
} from '../../shared/backlog-outcomes'
import type { BacklogItem } from '../../shared/backlog-types'
import type {
  BacklogCandidateIngestEntry,
  BacklogIngestEntryResult
} from './backlog-candidate-operations'
import type {
  BacklogCandidateResolution,
  BacklogResolveResult
} from './backlog-candidate-resolution'
import type { BacklogItemPatch, BacklogTransitionInput } from './backlog-item-folds'
import type { BacklogItemMergeInput, BacklogItemMergeResult } from './backlog-item-merge'
import type { BacklogCaptureInput, BacklogService } from './backlog-service'

/** What runtime RPC clients may ask of this host's intent ledger; one service behind every client. */
export type BacklogHost = {
  list: (query: BacklogListQuery) => Promise<BacklogListResult>
  capture: (input: BacklogCaptureInput) => Promise<BacklogWriteOutcome<BacklogItem>>
  get: (id: string) => Promise<BacklogLoadResult<BacklogItem>>
  update: (id: string, patch: BacklogItemPatch) => Promise<BacklogWriteOutcome<BacklogItem>>
  transition: (
    id: string,
    input: BacklogTransitionInput
  ) => Promise<BacklogWriteOutcome<BacklogItem>>
  listCandidates: (query: BacklogCandidateListQuery) => Promise<BacklogCandidateListResult>
  ingestCandidates: (
    entries: readonly BacklogCandidateIngestEntry[]
  ) => Promise<BacklogIngestEntryResult[]>
  resolveCandidate: (resolution: BacklogCandidateResolution) => Promise<BacklogResolveResult>
  merge: (input: BacklogItemMergeInput) => Promise<BacklogItemMergeResult>
  health: () => Promise<BacklogHealth>
}

export function createBacklogHost(service: BacklogService): BacklogHost {
  return {
    list: (query) => service.list(query),
    capture: (input) => service.capture(input),
    get: (id) => service.get(id),
    update: (id, patch) => service.update(id, patch),
    transition: (id, input) => service.transition(id, input),
    listCandidates: (query) => service.listCandidates(query),
    ingestCandidates: (entries) => service.ingestCandidates(entries),
    resolveCandidate: (resolution) => service.resolveCandidate(resolution),
    merge: (input) => service.mergeItems(input),
    health: () => service.health()
  }
}
