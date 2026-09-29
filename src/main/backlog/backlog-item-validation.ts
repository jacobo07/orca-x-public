import { isBacklogItemId } from '../../shared/backlog-identity'
import type { BacklogLoadResult } from '../../shared/backlog-outcomes'
import {
  BACKLOG_DEPENDENCIES_MAX,
  BACKLOG_NORMALIZED_INTENT_MAX,
  BACKLOG_TEXT_MAX
} from '../../shared/backlog-rpc-limits'
import {
  BACKLOG_ITEM_EVENT_TYPES,
  BACKLOG_ITEM_KINDS,
  BACKLOG_ITEM_STATES,
  BACKLOG_PRIORITIES,
  type BacklogItem
} from '../../shared/backlog-types'
import { parseBacklogEnvelope } from './backlog-record-envelope'
import {
  describeBacklogEvidenceDefect,
  describeBacklogExecutionLinkDefect,
  describeBacklogProjectRefsDefect,
  describeBacklogSourceLinkDefect,
  isBacklogBoundedText
} from './backlog-record-field-validation'
import type { BacklogRecordCodec } from './backlog-record-store'

function firstDefect(rows: unknown, describe: (row: unknown) => string | null): string | null {
  if (!Array.isArray(rows)) {
    return 'expected an array'
  }
  for (const row of rows) {
    const defect = describe(row)
    if (defect !== null) {
      return defect
    }
  }
  return null
}

function describeDependenciesDefect(value: unknown, ownId: unknown): string | null {
  if (!Array.isArray(value) || value.length > BACKLOG_DEPENDENCIES_MAX) {
    return 'dependencies is not a bounded array'
  }
  if (new Set(value).size !== value.length) {
    return 'dependencies repeats an id'
  }
  if (!value.every((id) => isBacklogItemId(id))) {
    return 'dependencies holds a non item id'
  }
  return (value as string[]).includes(ownId as string) ? 'item depends on itself' : null
}

export function describeBacklogItemDefect(value: unknown): string | null {
  const item = value as Record<string, unknown>
  if (
    typeof item.originalText !== 'string' ||
    item.originalText.trim().length === 0 ||
    item.originalText.length > BACKLOG_TEXT_MAX
  ) {
    return 'originalText is empty or too long'
  }
  if (!isBacklogBoundedText(item.normalizedIntent, 0, BACKLOG_NORMALIZED_INTENT_MAX)) {
    return 'normalizedIntent is not bounded text'
  }
  if (item.mergedInto !== null && !isBacklogItemId(item.mergedInto)) {
    return 'mergedInto is neither null nor an item id'
  }
  if (
    typeof item.createdAt !== 'number' ||
    !Number.isFinite(item.createdAt) ||
    typeof item.updatedAt !== 'number' ||
    !Number.isFinite(item.updatedAt)
  ) {
    return 'timestamps are not finite numbers'
  }
  if (
    !BACKLOG_ITEM_KINDS.includes(item.kind as never) ||
    !BACKLOG_ITEM_STATES.includes(item.state as never) ||
    !BACKLOG_PRIORITIES.includes(item.priority as never)
  ) {
    return 'kind, state or priority is unknown'
  }
  const prefixed = (label: string, defect: string | null): string | null =>
    defect === null ? null : `${label}: ${defect}`
  return (
    describeDependenciesDefect(item.dependencies, item.id) ??
    describeBacklogProjectRefsDefect(item.projectRefs) ??
    prefixed('sourceLinks', firstDefect(item.sourceLinks, describeBacklogSourceLinkDefect)) ??
    prefixed('executionLinks', firstDefect(item.executionLinks, describeBacklogExecutionLinkDefect)) ??
    prefixed('evidence', firstDefect(item.evidence, describeBacklogEvidenceDefect))
  )
}

export function parseBacklogItem(raw: string, expectedId: string): BacklogLoadResult<BacklogItem> {
  const envelope = parseBacklogEnvelope(raw, expectedId, BACKLOG_ITEM_EVENT_TYPES)
  if (envelope.outcome !== 'loaded') {
    return envelope
  }
  const defect = describeBacklogItemDefect(envelope.record)
  if (defect !== null) {
    return { outcome: 'unreadable', code: 'invalid-field', reason: defect }
  }
  return { outcome: 'loaded', record: envelope.record as unknown as BacklogItem }
}

export const BACKLOG_ITEM_CODEC: BacklogRecordCodec<BacklogItem> = {
  isId: isBacklogItemId,
  parse: parseBacklogItem,
  describeDefect: describeBacklogItemDefect
}
