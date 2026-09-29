import { BACKLOG_SCHEMA_VERSION } from '../../shared/backlog-types'
import { isBacklogEventId } from '../../shared/backlog-identity'
import type { BacklogLoadResult } from '../../shared/backlog-outcomes'

function invalid(reason: string): BacklogLoadResult<never> {
  return { outcome: 'unreadable', code: 'invalid-field', reason }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeEventsDefect(events: unknown, allowed: readonly string[]): string | null {
  if (!Array.isArray(events)) {
    return 'events is not an array'
  }
  const seen = new Set<string>()
  for (const event of events) {
    if (!isPlainObject(event) || !isBacklogEventId(event.id) || seen.has(event.id as string)) {
      return 'event has a missing, malformed or duplicate id'
    }
    seen.add(event.id as string)
    if (typeof event.type !== 'string' || !allowed.includes(event.type)) {
      return 'event has an unknown type'
    }
    if (typeof event.at !== 'number' || !Number.isFinite(event.at) || !isPlainObject(event.data)) {
      return 'event has a bad timestamp or data'
    }
  }
  return null
}

/** Returns the parsed object itself so fields a newer build wrote survive a read-modify-write. */
export function parseBacklogEnvelope(
  raw: string,
  expectedId: string,
  allowedEventTypes: readonly string[]
): BacklogLoadResult<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { outcome: 'unreadable', code: 'not-json', reason: 'record is not valid JSON' }
  }
  if (!isPlainObject(parsed)) {
    return { outcome: 'unreadable', code: 'not-object', reason: 'record is not a JSON object' }
  }
  const version = parsed.schemaVersion
  if (typeof version === 'number' && Number.isInteger(version) && version > BACKLOG_SCHEMA_VERSION) {
    return { outcome: 'schema-too-new', storedVersion: version }
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < BACKLOG_SCHEMA_VERSION) {
    return { outcome: 'unreadable', code: 'schema-too-old', reason: 'schemaVersion is not current' }
  }
  // The filename is not evidence about the contents.
  if (parsed.id !== expectedId) {
    return { outcome: 'unreadable', code: 'id-mismatch', reason: 'stored id differs from file name' }
  }
  if (typeof parsed.revision !== 'number' || !Number.isInteger(parsed.revision) || parsed.revision < 1) {
    return invalid('revision is not an integer of at least 1')
  }
  const defect = describeEventsDefect(parsed.events, allowedEventTypes)
  return defect === null ? { outcome: 'loaded', record: parsed } : invalid(defect)
}
