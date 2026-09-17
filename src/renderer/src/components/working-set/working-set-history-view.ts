import type {
  WorkingSetHistoryItem,
  WorkingSetListResult
} from '../../../../shared/project-working-set-store-types'

/**
 * What the snapshot list may say about one workspace's sealed history.
 *
 * Each store answer keeps its own state: a client without a store, a store that could not be read,
 * and a store holding nothing are three different facts, and only the last one is "empty".
 */

export type WorkingSetHistoryRow = {
  /** The durable identity; labels and times are presentation and may repeat. */
  workingSetId: string
  label: string | null
  createdAt: number
  tabCount: number
  isLatest: boolean
}

export type WorkingSetProblemKind =
  | 'unsupported-version'
  | 'corrupt'
  | 'unreadable'
  | 'missing'
  | 'unverified'
  | 'unrecognized'

export type WorkingSetProblemRow = {
  key: string
  workingSetId: string | null
  kind: WorkingSetProblemKind
}

export type WorkingSetHistoryView =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'invalid-request' }
  | { kind: 'unreadable'; code: string }
  | { kind: 'listed'; rows: WorkingSetHistoryRow[]; problems: WorkingSetProblemRow[] }

function problemRow(item: WorkingSetHistoryItem): WorkingSetProblemRow | null {
  if ('fileName' in item) {
    return { key: `file:${item.fileName}`, workingSetId: null, kind: 'unrecognized' }
  }
  const { status } = item.outcome
  // Why skipped: the store lists valid manifests separately, so a valid outcome here is a duplicate.
  if (status === 'valid') {
    return null
  }
  return { key: `id:${item.workingSetId}`, workingSetId: item.workingSetId, kind: status }
}

export function projectWorkingSetHistory(result: WorkingSetListResult): WorkingSetHistoryView {
  if (result.status === 'unavailable') {
    return { kind: 'unavailable' }
  }
  if (result.status === 'invalid-request') {
    return { kind: 'invalid-request' }
  }
  if (result.status === 'unreadable') {
    return { kind: 'unreadable', code: result.code }
  }
  return {
    kind: 'listed',
    rows: result.valid.map((manifest) => ({
      workingSetId: manifest.workingSetId,
      label: manifest.label,
      createdAt: manifest.createdAt,
      tabCount: manifest.entries.length,
      isLatest: manifest.workingSetId === result.latestWorkingSetId
    })),
    problems: result.problems.flatMap((item) => {
      const row = problemRow(item)
      return row ? [row] : []
    })
  }
}
