import type { BacklogLoadResult, BacklogWriteOutcome } from '../../shared/backlog-outcomes'
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
  capture: (input: BacklogCaptureInput) => Promise<BacklogWriteOutcome<BacklogItem>>
  get: (id: string) => Promise<BacklogLoadResult<BacklogItem>>
  update: (id: string, patch: BacklogItemPatch) => Promise<BacklogWriteOutcome<BacklogItem>>
  transition: (
    id: string,
    input: BacklogTransitionInput
  ) => Promise<BacklogWriteOutcome<BacklogItem>>
  ingestCandidates: (
    entries: readonly BacklogCandidateIngestEntry[]
  ) => Promise<BacklogIngestEntryResult[]>
  resolveCandidate: (resolution: BacklogCandidateResolution) => Promise<BacklogResolveResult>
  merge: (input: BacklogItemMergeInput) => Promise<BacklogItemMergeResult>
}

export function createBacklogHost(service: BacklogService): BacklogHost {
  return {
    capture: (input) => service.capture(input),
    get: (id) => service.get(id),
    update: (id, patch) => service.update(id, patch),
    transition: (id, input) => service.transition(id, input),
    ingestCandidates: (entries) => service.ingestCandidates(entries),
    resolveCandidate: (resolution) => service.resolveCandidate(resolution),
    merge: (input) => service.mergeItems(input)
  }
}
