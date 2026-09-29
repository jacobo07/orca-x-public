// Why a schemaVersion bump for a new enum value: older builds quarantine values they do not know,
// so widening any array below without bumping makes their reads refuse records a newer build wrote.
export const BACKLOG_SCHEMA_VERSION = 1

export const BACKLOG_ITEM_KINDS = ['engineering', 'research', 'decision', 'manual', 'idea'] as const
export type BacklogItemKind = (typeof BACKLOG_ITEM_KINDS)[number]

export const BACKLOG_ITEM_STATES = [
  'needs-triage',
  'ready',
  'waiting-for-executor',
  'preparing',
  'running',
  'review',
  'done',
  'blocked',
  'stale',
  'superseded',
  'dismissed',
  'unknown'
] as const
export type BacklogItemState = (typeof BACKLOG_ITEM_STATES)[number]

export const BACKLOG_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const
export type BacklogPriority = (typeof BACKLOG_PRIORITIES)[number]

export const BACKLOG_PROJECT_MAPPINGS = ['explicit', 'inferred'] as const
export type BacklogProjectMapping = (typeof BACKLOG_PROJECT_MAPPINGS)[number]

export const BACKLOG_SOURCE_KINDS = [
  'manual',
  'orca-conversation',
  'claude-code-transcript',
  'codex-transcript',
  'chatgpt-export',
  'infinityops'
] as const
export type BacklogSourceKind = (typeof BACKLOG_SOURCE_KINDS)[number]

export const BACKLOG_SOURCE_CAPABILITY_LEVELS = ['full', 'best-effort', 'bounded'] as const
export type BacklogSourceCapabilityLevel = (typeof BACKLOG_SOURCE_CAPABILITY_LEVELS)[number]

export const BACKLOG_EXECUTION_LINK_KINDS = [
  'orchestration-task',
  'github-issue',
  'conversation',
  'founder-task'
] as const
export type BacklogExecutionLinkKind = (typeof BACKLOG_EXECUTION_LINK_KINDS)[number]

export const BACKLOG_EVIDENCE_CLASSES = [
  'PROVEN',
  'OBSERVED',
  'INFERRED',
  'HYPOTHESIZED',
  'RETRACTED',
  'UNKNOWN',
  'STALE'
] as const
export type BacklogEvidenceClass = (typeof BACKLOG_EVIDENCE_CLASSES)[number]

export const BACKLOG_EVIDENCE_ORIGINS = ['human', 'tool', 'model'] as const
export type BacklogEvidenceOrigin = (typeof BACKLOG_EVIDENCE_ORIGINS)[number]

export const BACKLOG_EVIDENCE_SUBJECTS = [
  'revision',
  'gate',
  'artifact',
  'human-resolution',
  'confirmation',
  'other'
] as const
export type BacklogEvidenceSubject = (typeof BACKLOG_EVIDENCE_SUBJECTS)[number]

export const BACKLOG_LANES = [
  'human',
  'claude',
  'chatgpt-unattended',
  'chatgpt-interactive',
  'deterministic'
] as const
export type BacklogLane = (typeof BACKLOG_LANES)[number]

export const BACKLOG_ITEM_EVENT_TYPES = [
  'created',
  'updated',
  'transitioned',
  'source-linked',
  'merged-in',
  'merged-into'
] as const
export type BacklogItemEventType = (typeof BACKLOG_ITEM_EVENT_TYPES)[number]

export const BACKLOG_CANDIDATE_STATUSES = [
  'open',
  'accepted',
  'merged',
  'already-done',
  'superseded',
  'dismissed'
] as const
export type BacklogCandidateStatus = (typeof BACKLOG_CANDIDATE_STATUSES)[number]

// An enum, never a percentage: an unknown uncertainty must stay unknown.
export const BACKLOG_CANDIDATE_UNCERTAINTIES = ['low', 'medium', 'high', 'unknown'] as const
export type BacklogCandidateUncertainty = (typeof BACKLOG_CANDIDATE_UNCERTAINTIES)[number]

export const BACKLOG_CANDIDATE_EVENT_TYPES = ['ingested', 'resolved'] as const
export type BacklogCandidateEventType = (typeof BACKLOG_CANDIDATE_EVENT_TYPES)[number]

export type BacklogProjectRef = {
  projectId: string
  mapping: BacklogProjectMapping
  evidence: string
}

export type BacklogSourceLink = {
  kind: BacklogSourceKind
  ref: string
  capturedAt: number
  candidateId: string | null
}

export type BacklogExecutionLink = { kind: BacklogExecutionLinkKind; ref: string }

export type BacklogEvidence = {
  id: string
  class: BacklogEvidenceClass
  origin: BacklogEvidenceOrigin
  subject: BacklogEvidenceSubject
  source: string
  ref: string | null
  observedAt: number
}

export type BacklogExecutorPolicy = { preferred: BacklogLane; fallback: BacklogLane | null }

export type BacklogEventData = Record<
  string,
  string | number | boolean | null | readonly string[]
>

export type BacklogItemEvent = {
  id: string
  type: BacklogItemEventType
  at: number
  data: BacklogEventData
}

export type BacklogCandidateEvent = {
  id: string
  type: BacklogCandidateEventType
  at: number
  data: BacklogEventData
}

export type BacklogItem = {
  schemaVersion: number
  id: string
  kind: BacklogItemKind
  originalText: string
  normalizedIntent: string
  projectRefs: BacklogProjectRef[]
  state: BacklogItemState
  priority: BacklogPriority
  dependencies: string[]
  executorPolicy: BacklogExecutorPolicy | null
  sourceLinks: BacklogSourceLink[]
  executionLinks: BacklogExecutionLink[]
  evidence: BacklogEvidence[]
  events: BacklogItemEvent[]
  mergedInto: string | null
  revision: number
  createdAt: number
  updatedAt: number
}

export type BacklogCandidateSource = {
  kind: BacklogSourceKind
  ref: string
  capturedAt: number
  adapter: string
  capabilityLevel: BacklogSourceCapabilityLevel
}

export type BacklogProjectHint = { projectId: string; evidence: string }

export type BacklogCandidate = {
  schemaVersion: number
  id: string
  fingerprint: string
  source: BacklogCandidateSource
  text: string
  uncertainty: BacklogCandidateUncertainty
  status: BacklogCandidateStatus
  resolvedItemId: string | null
  projectHint: BacklogProjectHint | null
  events: BacklogCandidateEvent[]
  revision: number
}
