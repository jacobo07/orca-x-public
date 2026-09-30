import type {
  BacklogHarvestRpcUnit,
  BacklogHarvestRunReport,
  BacklogHarvestStatusReport
} from '../../shared/backlog-harvest-report'
import type {
  BacklogCandidateListQuery,
  BacklogCandidateListResult,
  BacklogHealth,
  BacklogListQuery,
  BacklogListResult,
  BacklogLoadResult,
  BacklogWriteOutcome
} from '../../shared/backlog-outcomes'
import type { BacklogCandidate, BacklogItem } from '../../shared/backlog-types'
import type { BacklogCandidateAssignment } from './backlog-candidate-assign'
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
import type { BacklogHarvestRunner } from './harvest/backlog-harvest-runner'

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
  assignCandidate: (
    assignment: BacklogCandidateAssignment
  ) => Promise<BacklogWriteOutcome<BacklogCandidate>>
  merge: (input: BacklogItemMergeInput) => Promise<BacklogItemMergeResult>
  health: () => Promise<BacklogHealth>
  harvest: (unit: BacklogHarvestRpcUnit) => Promise<BacklogHarvestRunReport>
  harvestStatus: () => Promise<BacklogHarvestStatusReport>
}

// The runner is required: a host without harvest would answer every run as an empty success.
export function createBacklogHost(
  service: BacklogService,
  harvester: BacklogHarvestRunner
): BacklogHost {
  return {
    harvest: (unit) => harvester.run(unit),
    harvestStatus: () => harvester.status(),
    list: (query) => service.list(query),
    capture: (input) => service.capture(input),
    get: (id) => service.get(id),
    update: (id, patch) => service.update(id, patch),
    transition: (id, input) => service.transition(id, input),
    listCandidates: (query) => service.listCandidates(query),
    ingestCandidates: (entries) => service.ingestCandidates(entries),
    resolveCandidate: (resolution) => service.resolveCandidate(resolution),
    assignCandidate: (assignment) => service.assignCandidate(assignment),
    merge: (input) => service.mergeItems(input),
    health: () => service.health()
  }
}
