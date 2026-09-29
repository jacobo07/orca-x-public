import type {
  BacklogCandidate,
  BacklogCandidateStatus,
  BacklogItem,
  BacklogItemKind,
  BacklogItemState
} from './backlog-types'

export type BacklogStorageStage = 'prepare' | 'scan' | 'write' | 'barrier' | 'publish'

export type BacklogUnreadableCode =
  | 'read-failed'
  | 'too-large'
  | 'not-json'
  | 'not-object'
  | 'schema-too-old'
  | 'id-mismatch'
  | 'invalid-field'

export type BacklogLoadResult<R> =
  | { outcome: 'loaded'; record: R }
  | { outcome: 'absent' }
  | { outcome: 'unreadable'; code: BacklogUnreadableCode; reason: string }
  | { outcome: 'schema-too-new'; storedVersion: number }

export type BacklogRefusalCode =
  | 'illegal-transition'
  | 'completion-evidence-missing'
  | 'idea-cannot-complete'
  | 'kind-change-while-done'
  | 'model-evidence-proven'
  | 'event-log-not-extended'
  | 'event-count'
  | 'invalid-record'
  | 'record-too-large'
  | 'self-merge'
  | 'self-dependency'
  | 'merge-target-superseded'
  | 'candidate-already-resolved'
  | 'use-merge'
  | 'item-capacity-exceeded'

export type BacklogRefusal = {
  outcome: 'refused'
  code: BacklogRefusalCode
  detail: string | null
}

export type BacklogStorageFailure = {
  outcome: 'storage-failed'
  stage: BacklogStorageStage
  code: string | null
}

export type BacklogRecordKind = 'item' | 'candidate'

export type BacklogQuarantineCode = BacklogUnreadableCode | 'schema-too-new' | 'invalid-name'

/** A file the ledger could not load; it is reported and left byte-for-byte on disk. */
export type BacklogQuarantineEntry = {
  recordKind: BacklogRecordKind
  fileName: string
  id: string | null
  code: BacklogQuarantineCode
  reason: string
}

export type BacklogListQuery = {
  state?: BacklogItemState
  kind?: BacklogItemKind
  projectId?: string
  unassigned?: boolean
  limit?: number
  cursor?: string
}

export type BacklogListResult =
  | {
      outcome: 'listed'
      items: BacklogItem[]
      total: number
      nextCursor: string | null
      quarantinedCount: number
    }
  | BacklogStorageFailure

export type BacklogCandidateListQuery = {
  status?: BacklogCandidateStatus
  limit?: number
  cursor?: string
}

export type BacklogCandidateListResult =
  | {
      outcome: 'listed'
      candidates: BacklogCandidate[]
      total: number
      nextCursor: string | null
      quarantinedCount: number
    }
  | BacklogStorageFailure

export type BacklogHealthReport = {
  outcome: 'opened'
  items: { total: number; byState: Record<BacklogItemState, number> }
  candidates: { total: number; byStatus: Record<BacklogCandidateStatus, number> }
  quarantined: BacklogQuarantineEntry[]
}

export type BacklogHealth = BacklogHealthReport | BacklogStorageFailure

export type BacklogWriteOutcome<R> =
  | { outcome: 'published'; record: R }
  | { outcome: 'unchanged'; record: R }
  | { outcome: 'superseded'; expectedRevision: number; actualRevision: number }
  | { outcome: 'absent' }
  | { outcome: 'unreadable'; code: BacklogUnreadableCode; reason: string }
  | { outcome: 'schema-too-new'; storedVersion: number }
  | BacklogStorageFailure
  | BacklogRefusal
