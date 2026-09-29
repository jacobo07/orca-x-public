import type { BacklogItemSummary } from '../../../../shared/backlog-summary'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { listBacklogPage, type BacklogReadFailure } from './backlog-client'

const FIRST_PAGE_LIMIT = 100
// Only a host that proved it projects summary rows is asked for bigger pages.
const SUMMARY_PAGE_LIMIT = 500

export type BacklogLoadOutcome =
  | {
      status: 'ready'
      rows: BacklogItemSummary[]
      ledgerTotal: number
      hostView: 'summary' | 'full'
      quarantinedItems: number
    }
  | BacklogReadFailure

/** One whole-ledger read, paged to nextCursor null. Holds no timer or cache; callers decide when. */
export async function loadBacklogSnapshot(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
): Promise<BacklogLoadOutcome> {
  const rows: BacklogItemSummary[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  let limit = FIRST_PAGE_LIMIT
  for (;;) {
    const page = await listBacklogPage(settings, { cursor, limit })
    if (page.status !== 'ok') {
      return page
    }
    for (const row of page.rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id)
        rows.push(row)
      }
    }
    if (page.nextCursor === null) {
      return {
        status: 'ready',
        rows,
        ledgerTotal: page.total,
        hostView: page.hostView,
        quarantinedItems: page.quarantinedCount
      }
    }
    const next = Number(page.nextCursor)
    // A cursor that does not advance would loop forever; treat the host as not answering.
    if (!Number.isSafeInteger(next) || next <= (cursor === null ? 0 : Number(cursor))) {
      return { status: 'unreachable' }
    }
    cursor = page.nextCursor
    limit = page.hostView === 'summary' ? SUMMARY_PAGE_LIMIT : FIRST_PAGE_LIMIT
  }
}
