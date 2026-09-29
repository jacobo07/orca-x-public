import type { BacklogRefusal } from './backlog-outcomes'
import {
  BACKLOG_EVIDENCE_PER_ITEM_MAX,
  BACKLOG_EXECUTION_LINKS_PER_ITEM_MAX,
  BACKLOG_SOURCE_LINKS_PER_ITEM_MAX
} from './backlog-rpc-limits'

const CAPS = {
  evidence: BACKLOG_EVIDENCE_PER_ITEM_MAX,
  executionLinks: BACKLOG_EXECUTION_LINKS_PER_ITEM_MAX,
  sourceLinks: BACKLOG_SOURCE_LINKS_PER_ITEM_MAX
} as const

type Counted = Partial<Record<keyof typeof CAPS, unknown>>

/** Names the first bounded array over its per-item count, or null. */
export function describeBacklogItemCapacityExcess(item: Counted): string | null {
  for (const field of Object.keys(CAPS) as (keyof typeof CAPS)[]) {
    const rows = item[field]
    if (Array.isArray(rows) && rows.length > CAPS[field]) {
      return `${field} holds ${rows.length}, the limit is ${CAPS[field]}`
    }
  }
  return null
}

export function backlogItemCapacityRefusal(item: Counted): BacklogRefusal | null {
  const excess = describeBacklogItemCapacityExcess(item)
  return excess === null ? null : { outcome: 'refused', code: 'item-capacity-exceeded', detail: excess }
}
