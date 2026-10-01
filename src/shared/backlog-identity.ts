export const BACKLOG_ITEM_ID_PREFIX = 'bli_'
export const BACKLOG_CANDIDATE_ID_PREFIX = 'blc_'
export const BACKLOG_EVENT_ID_PREFIX = 'ble_'
export const BACKLOG_EVIDENCE_ID_PREFIX = 'blv_'

// Anchored so the predicate itself is filename-safe: an id that passes cannot carry a separator or `..`.
const UUID_SHAPE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ITEM_ID = new RegExp(`^${BACKLOG_ITEM_ID_PREFIX}${UUID_SHAPE}$`)
const EVENT_ID = new RegExp(`^${BACKLOG_EVENT_ID_PREFIX}${UUID_SHAPE}$`)
const EVIDENCE_ID = new RegExp(`^${BACKLOG_EVIDENCE_ID_PREFIX}${UUID_SHAPE}$`)
const CANDIDATE_ID = new RegExp(`^${BACKLOG_CANDIDATE_ID_PREFIX}[0-9a-f]{32}$`)

export function isBacklogItemId(value: unknown): value is string {
  return typeof value === 'string' && ITEM_ID.test(value)
}

export function isBacklogEventId(value: unknown): value is string {
  return typeof value === 'string' && EVENT_ID.test(value)
}

export function isBacklogEvidenceId(value: unknown): value is string {
  return typeof value === 'string' && EVIDENCE_ID.test(value)
}

export function isBacklogCandidateId(value: unknown): value is string {
  return typeof value === 'string' && CANDIDATE_ID.test(value)
}
