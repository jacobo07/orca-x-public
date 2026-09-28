import type {
  DeskProjection,
  DeskTab,
  DeskWorkspace
} from '../../../../shared/desk-continuity-projection'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type ResumeCenterSort = 'window' | 'recent'

export type WorkspaceRowModel = Extract<DeskWorkspace, { kind: 'projected' }> & {
  /** 1-based position of the window this workspace is bound to, among recorded windows. */
  windowOrder: number | null
  counts: { tabs: number; panes: number; warm: number; dormant: number; unknown: number }
}

export type ResumeCenterModel = {
  workspaces: WorkspaceRowModel[]
  unprojectable: { key: string; hostId: ExecutionHostId; reason: string }[]
  unreadableHosts: { hostId: ExecutionHostId; reason: string }[]
  totals: DeskProjection['totals']
  windowsRecorded: boolean
  windowCount: number
}

function countTabs(tabs: readonly DeskTab[]): WorkspaceRowModel['counts'] {
  const counts = { tabs: tabs.length, panes: 0, warm: 0, dormant: 0, unknown: 0 }
  for (const tab of tabs) {
    counts.panes += tab.panes.length
    if (tab.residency === 'warm') {
      counts.warm += 1
    } else if (tab.residency === 'dormant') {
      counts.dormant += 1
    } else if (tab.residency === 'unknown') {
      counts.unknown += 1
    }
  }
  return counts
}

/** Metadata only: names, paths and titles. Terminal content is never searched. */
function matchesQuery(row: WorkspaceRowModel, query: string): boolean {
  const haystack = [
    row.identity.kind === 'known' ? row.identity.name : row.key,
    row.identity.kind === 'known' ? (row.identity.path ?? '') : '',
    row.hostId,
    ...row.tabs.flatMap((tab) => [tab.title, tab.agent ?? ''])
  ]
    .join('\n')
    .toLowerCase()
  return haystack.includes(query)
}

export function buildResumeCenterModel(
  projection: DeskProjection,
  options: { query: string; sort: ResumeCenterSort }
): ResumeCenterModel {
  const windowSequences = [
    ...new Set(
      projection.hosts.flatMap((host) =>
        host.kind === 'loaded'
          ? host.workspaces.flatMap((w) =>
              w.kind === 'projected' && w.window.kind === 'bound' ? [w.window.sequence] : []
            )
          : []
      )
    )
  ].sort((a, b) => a - b)
  const workspaces: WorkspaceRowModel[] = []
  const unprojectable: ResumeCenterModel['unprojectable'] = []
  const unreadableHosts: ResumeCenterModel['unreadableHosts'] = []
  for (const host of projection.hosts) {
    if (host.kind === 'unreadable') {
      unreadableHosts.push({ hostId: host.hostId, reason: host.reason })
      continue
    }
    for (const workspace of host.workspaces) {
      if (workspace.kind === 'unprojectable') {
        unprojectable.push({
          key: workspace.key,
          hostId: workspace.hostId,
          reason: workspace.reason
        })
        continue
      }
      workspaces.push({
        ...workspace,
        windowOrder:
          workspace.window.kind === 'bound'
            ? windowSequences.indexOf(workspace.window.sequence) + 1
            : null,
        counts: countTabs(workspace.tabs)
      })
    }
  }
  const query = options.query.trim().toLowerCase()
  const filtered = query ? workspaces.filter((row) => matchesQuery(row, query)) : workspaces
  const byRecent = (a: WorkspaceRowModel, b: WorkspaceRowModel): number =>
    (b.lastVisitedAt ?? 0) - (a.lastVisitedAt ?? 0)
  const byWindow = (a: WorkspaceRowModel, b: WorkspaceRowModel): number =>
    (a.windowOrder ?? Number.POSITIVE_INFINITY) - (b.windowOrder ?? Number.POSITIVE_INFINITY) ||
    byRecent(a, b)
  return {
    workspaces: [...filtered].sort(options.sort === 'recent' ? byRecent : byWindow),
    unprojectable,
    unreadableHosts,
    totals: projection.totals,
    windowsRecorded: projection.windowsRecorded,
    windowCount: projection.windowCount
  }
}
