import { BACKLOG_SUMMARY_TEXT_MAX } from './backlog-rpc-limits'
import { BACKLOG_ITEM_STATES, type BacklogItem, type BacklogItemState } from './backlog-types'

export const BACKLOG_LIST_VIEWS = ['full', 'summary'] as const
export type BacklogListView = (typeof BACKLOG_LIST_VIEWS)[number]

export type BacklogItemSummary = Omit<BacklogItem, 'events' | 'evidence'> & {
  textTruncated?: true
}

function clipToCodePoints(text: string, max: number): string | null {
  // A string of at most max UTF-16 units cannot hold more than max code points.
  if (text.length <= max) {
    return null
  }
  const points = Array.from(text)
  return points.length > max ? points.slice(0, max).join('') : null
}

/** Idempotent, so the renderer can normalize a full record and a summary row alike. */
export function toBacklogItemSummary(row: BacklogItem | BacklogItemSummary): BacklogItemSummary {
  const {
    events: _events,
    evidence: _evidence,
    textTruncated,
    ...rest
  } = row as BacklogItem & { textTruncated?: true }
  const clipped = clipToCodePoints(rest.originalText, BACKLOG_SUMMARY_TEXT_MAX)
  if (clipped !== null) {
    return { ...rest, originalText: clipped, textTruncated: true }
  }
  return textTruncated === true ? { ...rest, textTruncated: true } : rest
}

export const BACKLOG_CLOSED_STATES = ['done', 'dismissed', 'superseded'] as const

const CLOSED: ReadonlySet<BacklogItemState> = new Set(BACKLOG_CLOSED_STATES)

/**
 * The single definition of the Backlog's default working set, shared by the host summarizer and
 * the renderer selector so the two cannot drift.
 */
export const BACKLOG_OPEN_STATES: readonly BacklogItemState[] = BACKLOG_ITEM_STATES.filter(
  (state) => !CLOSED.has(state)
)

export function isBacklogStateOpen(state: BacklogItemState): boolean {
  return !CLOSED.has(state)
}
