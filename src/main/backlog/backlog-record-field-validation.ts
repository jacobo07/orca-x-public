import { isBacklogEvidenceId } from '../../shared/backlog-identity'
import {
  BACKLOG_PROJECT_ID_MAX,
  BACKLOG_PROJECT_REFS_MAX,
  BACKLOG_REF_MAX,
  BACKLOG_SHORT_TEXT_MAX
} from '../../shared/backlog-rpc-limits'
import {
  BACKLOG_EVIDENCE_CLASSES,
  BACKLOG_EVIDENCE_ORIGINS,
  BACKLOG_EVIDENCE_SUBJECTS,
  BACKLOG_EXECUTION_LINK_KINDS,
  BACKLOG_PROJECT_MAPPINGS,
  BACKLOG_SOURCE_KINDS
} from '../../shared/backlog-types'

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneOf(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value)
}

export function isBacklogBoundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

export function describeBacklogProjectRefsDefect(refs: unknown): string | null {
  if (!Array.isArray(refs) || refs.length > BACKLOG_PROJECT_REFS_MAX) {
    return 'projectRefs is not a bounded array'
  }
  const seen = new Set<string>()
  for (const ref of refs) {
    if (!isRow(ref) || !isBacklogBoundedText(ref.projectId, 1, BACKLOG_PROJECT_ID_MAX)) {
      return 'projectRef has a bad projectId'
    }
    if (seen.has(ref.projectId as string)) {
      return 'projectRefs repeats a projectId'
    }
    seen.add(ref.projectId as string)
    if (!oneOf(BACKLOG_PROJECT_MAPPINGS, ref.mapping)) {
      return 'projectRef has an unknown mapping'
    }
    if (!isBacklogBoundedText(ref.evidence, 0, BACKLOG_SHORT_TEXT_MAX)) {
      return 'projectRef evidence is not bounded text'
    }
  }
  return null
}

export function describeBacklogSourceLinkDefect(link: unknown): string | null {
  if (!isRow(link) || !oneOf(BACKLOG_SOURCE_KINDS, link.kind)) {
    return 'source link has an unknown kind'
  }
  if (!isBacklogBoundedText(link.ref, 1, BACKLOG_REF_MAX)) {
    return 'source link ref is not bounded text'
  }
  if (typeof link.capturedAt !== 'number' || !Number.isFinite(link.capturedAt)) {
    return 'source link capturedAt is not finite'
  }
  if (link.candidateId !== null && typeof link.candidateId !== 'string') {
    return 'source link candidateId is neither null nor a string'
  }
  return null
}

export function describeBacklogExecutionLinkDefect(link: unknown): string | null {
  if (!isRow(link) || !oneOf(BACKLOG_EXECUTION_LINK_KINDS, link.kind)) {
    return 'execution link has an unknown kind'
  }
  return isBacklogBoundedText(link.ref, 1, BACKLOG_REF_MAX)
    ? null
    : 'execution link ref is not bounded text'
}

export function describeBacklogEvidenceDefect(row: unknown): string | null {
  if (!isRow(row) || !isBacklogEvidenceId(row.id)) {
    return 'evidence has a malformed id'
  }
  if (
    !oneOf(BACKLOG_EVIDENCE_CLASSES, row.class) ||
    !oneOf(BACKLOG_EVIDENCE_ORIGINS, row.origin) ||
    !oneOf(BACKLOG_EVIDENCE_SUBJECTS, row.subject)
  ) {
    return 'evidence has an unknown class, origin or subject'
  }
  if (!isBacklogBoundedText(row.source, 1, BACKLOG_SHORT_TEXT_MAX)) {
    return 'evidence source is not bounded text'
  }
  if (row.ref !== null && !isBacklogBoundedText(row.ref, 1, BACKLOG_REF_MAX)) {
    return 'evidence ref is neither null nor bounded text'
  }
  if (typeof row.observedAt !== 'number' || !Number.isFinite(row.observedAt)) {
    return 'evidence observedAt is not finite'
  }
  if (row.class === 'PROVEN' && row.origin === 'model') {
    return 'model-origin evidence can never be PROVEN'
  }
  return null
}
