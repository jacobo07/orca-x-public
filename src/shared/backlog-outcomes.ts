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

export type BacklogWriteOutcome<R> =
  | { outcome: 'published'; record: R }
  | { outcome: 'unchanged'; record: R }
  | { outcome: 'superseded'; expectedRevision: number; actualRevision: number }
  | { outcome: 'absent' }
  | { outcome: 'unreadable'; code: BacklogUnreadableCode; reason: string }
  | { outcome: 'schema-too-new'; storedVersion: number }
  | BacklogStorageFailure
  | BacklogRefusal
