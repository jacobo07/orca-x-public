import type { BacklogRefusalCode } from './backlog-outcomes'

type EventLike = { id: string }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonical((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/** JSON with recursively sorted keys, so a re-serialized but unchanged event compares equal. */
export function canonicalBacklogEventJson(event: unknown): string {
  return JSON.stringify(canonical(event))
}

/**
 * Append-only rule: the stored events must survive as an exact prefix, and exactly one new event is
 * appended per mutation. Returns the refusal code, or null when the log is a valid extension.
 */
export function describeBacklogEventLogDefect(
  stored: readonly EventLike[],
  next: readonly EventLike[]
): Extract<BacklogRefusalCode, 'event-log-not-extended' | 'event-count'> | null {
  if (next.length < stored.length) {
    return 'event-log-not-extended'
  }
  for (let index = 0; index < stored.length; index += 1) {
    if (canonicalBacklogEventJson(stored[index]) !== canonicalBacklogEventJson(next[index])) {
      return 'event-log-not-extended'
    }
  }
  if (new Set(next.map((event) => event.id)).size !== next.length) {
    return 'event-log-not-extended'
  }
  return next.length === stored.length + 1 ? null : 'event-count'
}
