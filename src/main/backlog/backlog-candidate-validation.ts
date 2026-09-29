import { isBacklogCandidateId, isBacklogItemId } from '../../shared/backlog-identity'
import type { BacklogLoadResult } from '../../shared/backlog-outcomes'
import {
  BACKLOG_FINGERPRINT_MAX,
  BACKLOG_PROJECT_ID_MAX,
  BACKLOG_REF_MAX,
  BACKLOG_SHORT_TEXT_MAX,
  BACKLOG_TEXT_MAX
} from '../../shared/backlog-rpc-limits'
import {
  BACKLOG_CANDIDATE_EVENT_TYPES,
  BACKLOG_CANDIDATE_STATUSES,
  BACKLOG_CANDIDATE_UNCERTAINTIES,
  BACKLOG_SOURCE_CAPABILITY_LEVELS,
  BACKLOG_SOURCE_KINDS,
  type BacklogCandidate
} from '../../shared/backlog-types'
import { parseBacklogEnvelope } from './backlog-record-envelope'
import { isBacklogBoundedText } from './backlog-record-field-validation'
import type { BacklogRecordCodec } from './backlog-record-store'

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneOf(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value)
}

// Identity components are hashed NUL-joined, so a stored NUL would make the id ambiguous.
function isIdentityText(value: unknown, max: number): value is string {
  return isBacklogBoundedText(value, 1, max) && !value.includes('\0')
}

function describeSourceDefect(source: unknown): string | null {
  if (!isRow(source) || !oneOf(BACKLOG_SOURCE_KINDS, source.kind)) {
    return 'source has an unknown kind'
  }
  if (!oneOf(BACKLOG_SOURCE_CAPABILITY_LEVELS, source.capabilityLevel)) {
    return 'source has an unknown capability level'
  }
  if (!isIdentityText(source.ref, BACKLOG_REF_MAX)) {
    return 'source ref is not bounded NUL-free text'
  }
  if (typeof source.capturedAt !== 'number' || !Number.isFinite(source.capturedAt)) {
    return 'source capturedAt is not finite'
  }
  return isBacklogBoundedText(source.adapter, 1, BACKLOG_SHORT_TEXT_MAX)
    ? null
    : 'source adapter is not bounded text'
}

function describeProjectHintDefect(hint: unknown): string | null {
  if (hint === null) {
    return null
  }
  if (!isRow(hint) || !isBacklogBoundedText(hint.projectId, 1, BACKLOG_PROJECT_ID_MAX)) {
    return 'projectHint has a bad projectId'
  }
  return isBacklogBoundedText(hint.evidence, 0, BACKLOG_SHORT_TEXT_MAX)
    ? null
    : 'projectHint evidence is not bounded text'
}

export function describeBacklogCandidateDefect(value: unknown): string | null {
  if (!isRow(value)) {
    return 'candidate is not an object'
  }
  const sourceDefect = describeSourceDefect(value.source)
  if (sourceDefect !== null) {
    return sourceDefect
  }
  if (!isIdentityText(value.fingerprint, BACKLOG_FINGERPRINT_MAX)) {
    return 'fingerprint is not bounded NUL-free text'
  }
  if (
    typeof value.text !== 'string' ||
    value.text.trim().length === 0 ||
    value.text !== value.text.trim() ||
    value.text.length > BACKLOG_TEXT_MAX
  ) {
    return 'text is empty, untrimmed or too long'
  }
  if (
    !oneOf(BACKLOG_CANDIDATE_UNCERTAINTIES, value.uncertainty) ||
    !oneOf(BACKLOG_CANDIDATE_STATUSES, value.status)
  ) {
    return 'uncertainty or status is unknown'
  }
  if (value.resolvedItemId !== null && !isBacklogItemId(value.resolvedItemId)) {
    return 'resolvedItemId is neither null nor an item id'
  }
  const pointsAtItem = value.status === 'accepted' || value.status === 'merged'
  if (pointsAtItem !== (value.resolvedItemId !== null)) {
    return 'resolvedItemId is set exactly when the candidate is accepted or merged'
  }
  return describeProjectHintDefect(value.projectHint)
}

export function parseBacklogCandidate(
  raw: string,
  expectedId: string
): BacklogLoadResult<BacklogCandidate> {
  const envelope = parseBacklogEnvelope(raw, expectedId, BACKLOG_CANDIDATE_EVENT_TYPES)
  if (envelope.outcome !== 'loaded') {
    return envelope
  }
  const defect = describeBacklogCandidateDefect(envelope.record)
  if (defect !== null) {
    return { outcome: 'unreadable', code: 'invalid-field', reason: defect }
  }
  return { outcome: 'loaded', record: envelope.record as unknown as BacklogCandidate }
}

export const BACKLOG_CANDIDATE_CODEC: BacklogRecordCodec<BacklogCandidate> = {
  isId: isBacklogCandidateId,
  parse: parseBacklogCandidate,
  describeDefect: describeBacklogCandidateDefect
}
