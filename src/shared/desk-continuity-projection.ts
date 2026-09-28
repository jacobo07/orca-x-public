import type { ExecutionHostId } from './execution-host'
import type { PersistedWindowTopologyEntry } from './window-topology-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import type {
  DormantResumeContinuity,
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from './terminal-tab-types'
import { readDormantResumeContinuity } from './dormant-resume-continuity'
import { parsePaneKey } from './stable-pane-id'

/**
 * The previous desk, read from the owners that already keep it durable.
 *
 * Pure: the session partitions, the recorded window list and each host's live-session answer go
 * in, a tree comes out. Nothing here is stored, so there is no second copy of the desk to go stale.
 * Every axis keeps "could not tell" apart from a negative answer, because this view is the one
 * place a user decides what to wake.
 */

export type DeskLiveness =
  | { kind: 'observed'; liveSessionIds: ReadonlySet<string> }
  | { kind: 'unknown'; reason: 'host-unreachable' | 'peer-too-old' | 'not-asked' }

export type DeskWorkspaceIdentity =
  | { kind: 'known'; name: string; path: string | null }
  | { kind: 'missing' }
  | { kind: 'unknown' }

export type DeskHostInput = {
  hostId: ExecutionHostId
  session: { kind: 'loaded'; state: WorkspaceSessionState } | { kind: 'unreadable'; reason: string }
  liveness: DeskLiveness
}

export type DeskProjectionInput = {
  hosts: readonly DeskHostInput[]
  /** `null` = no usable window list was recorded (absent or unreadable), never "no windows". */
  windows: readonly PersistedWindowTopologyEntry[] | null
  describeWorkspace: (key: string, hostId: ExecutionHostId) => DeskWorkspaceIdentity
}

/** Whether a process exists for this row. Resume promises live on `resume`, never here. */
export type DeskResidency = 'warm' | 'dormant' | 'no-process' | 'unknown'

export type DeskPanePreviewSource =
  | { source: 'session-ref'; ref: string }
  | { source: 'daemon-history'; sessionId: string }
  | { source: 'none' }

export type DeskPane = {
  leafId: string | null
  title: string | null
  preview: DeskPanePreviewSource
}

export type DeskTab = {
  tabId: string
  title: string
  agent: string | null
  residency: DeskResidency
  resume: DormantResumeContinuity
  panes: DeskPane[]
}

export type DeskWindowMembership =
  | { kind: 'bound'; windowId: string; sequence: number }
  | {
      kind: 'unattributed'
      reason: 'folder-workspace' | 'no-window-binding' | 'windows-unrecorded'
    }

export type DeskWorkspace =
  | {
      kind: 'projected'
      key: string
      hostId: ExecutionHostId
      identity: DeskWorkspaceIdentity
      window: DeskWindowMembership
      lastVisitedAt: number | null
      tabs: DeskTab[]
      openFileCount: number
      browserTabCount: number
    }
  | { kind: 'unprojectable'; key: string; hostId: ExecutionHostId; reason: string }

export type DeskHost =
  | { kind: 'loaded'; hostId: ExecutionHostId; workspaces: DeskWorkspace[] }
  | { kind: 'unreadable'; hostId: ExecutionHostId; reason: string }

export type DeskTotals = {
  workspaces: number
  tabs: number
  panes: number
  byResidency: Record<DeskResidency, number>
}

export type DeskProjection = {
  hosts: DeskHost[]
  windowsRecorded: boolean
  windowCount: number
  totals: DeskTotals
}

const MAX_LAYOUT_DEPTH = 64

function worktreeIdOfKey(key: string): string | null {
  if (key.startsWith('folder:')) {
    return null
  }
  return key.startsWith('worktree:') ? key.slice('worktree:'.length) : key
}

function collectLeafIds(node: TerminalPaneLayoutNode | null, depth: number, out: string[]): void {
  if (!node || depth > MAX_LAYOUT_DEPTH) {
    return
  }
  if (node.type === 'leaf') {
    out.push(node.leafId)
    return
  }
  collectLeafIds(node.first, depth + 1, out)
  collectLeafIds(node.second, depth + 1, out)
}

function tabTitle(tab: TerminalTab): string {
  return tab.customTitle || tab.generatedTitle || tab.title || tab.defaultTitle || tab.id
}

function tabSessionIds(
  tab: TerminalTab,
  layout: TerminalLayoutSnapshot | undefined,
  remoteSessionIds: Record<string, string>
): string[] {
  const ids = [tab.ptyId, remoteSessionIds[tab.id], ...Object.values(layout?.ptyIdsByLeafId ?? {})]
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

function residencyOf(
  tab: TerminalTab,
  sessionIds: string[],
  liveness: DeskLiveness
): DeskResidency {
  // Why warm first: a live process outranks any marker saying it should not have one.
  if (liveness.kind === 'observed' && sessionIds.some((id) => liveness.liveSessionIds.has(id))) {
    return 'warm'
  }
  if (tab.dormancy) {
    return 'dormant'
  }
  return liveness.kind === 'observed' ? 'no-process' : 'unknown'
}

function projectPanes(
  tab: TerminalTab,
  layout: TerminalLayoutSnapshot | undefined,
  hostId: ExecutionHostId
): DeskPane[] {
  const leafIds: string[] = []
  collectLeafIds(layout?.root ?? null, 0, leafIds)
  const preview = (leafId: string | null): DeskPanePreviewSource => {
    const ref = leafId ? layout?.scrollbackRefsByLeafId?.[leafId] : undefined
    if (ref) {
      return { source: 'session-ref', ref }
    }
    // Why local only: the daemon history lives on this machine; a remote host's is not ours to read.
    const sessionId =
      (leafId ? layout?.ptyIdsByLeafId?.[leafId] : undefined) ??
      (leafIds.length <= 1 ? tab.ptyId : null)
    return hostId === 'local' && sessionId
      ? { source: 'daemon-history', sessionId }
      : { source: 'none' }
  }
  if (leafIds.length === 0) {
    return [{ leafId: null, title: null, preview: preview(null) }]
  }
  return leafIds.map((leafId) => ({
    leafId,
    title: layout?.titlesByLeafId?.[leafId] ?? null,
    preview: preview(leafId)
  }))
}

function windowMembership(
  key: string,
  bindings: ReadonlyMap<string, PersistedWindowTopologyEntry> | null
): DeskWindowMembership {
  const worktreeId = worktreeIdOfKey(key)
  if (worktreeId === null) {
    return { kind: 'unattributed', reason: 'folder-workspace' }
  }
  if (!bindings) {
    return { kind: 'unattributed', reason: 'windows-unrecorded' }
  }
  const entry = bindings.get(worktreeId)
  return entry
    ? { kind: 'bound', windowId: entry.windowId, sequence: entry.sequence }
    : { kind: 'unattributed', reason: 'no-window-binding' }
}

function projectWorkspace(
  key: string,
  tabs: readonly TerminalTab[],
  host: DeskHostInput & { session: { kind: 'loaded'; state: WorkspaceSessionState } },
  bindings: ReadonlyMap<string, PersistedWindowTopologyEntry> | null,
  describe: DeskProjectionInput['describeWorkspace'],
  resumeHandleTabIds: ReadonlySet<string>
): DeskWorkspace {
  const state = host.session.state
  const remote = state.remoteSessionIdsByTabId ?? {}
  const worktreeId = worktreeIdOfKey(key)
  const projectedTabs: DeskTab[] = [...tabs]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((tab) => {
      const layout = state.terminalLayoutsByTabId[tab.id]
      return {
        tabId: tab.id,
        title: tabTitle(tab),
        agent: tab.launchAgent ?? null,
        residency: residencyOf(tab, tabSessionIds(tab, layout, remote), host.liveness),
        resume: readDormantResumeContinuity(
          tab.dormancy?.resumeContinuity,
          resumeHandleTabIds.has(tab.id)
        ),
        panes: projectPanes(tab, layout, host.hostId)
      }
    })
  return {
    kind: 'projected',
    key,
    hostId: host.hostId,
    identity: describe(key, host.hostId),
    window: windowMembership(key, bindings),
    lastVisitedAt: worktreeId ? (state.lastVisitedAtByWorktreeId?.[worktreeId] ?? null) : null,
    tabs: projectedTabs,
    openFileCount: state.openFilesByWorktree?.[key]?.length ?? 0,
    browserTabCount: state.browserTabsByWorktree?.[key]?.length ?? 0
  }
}

function workspaceOrder(a: DeskWorkspace, b: DeskWorkspace): number {
  if (a.kind !== 'projected' || b.kind !== 'projected') {
    return a.kind === b.kind ? 0 : a.kind === 'projected' ? -1 : 1
  }
  const aSeq = a.window.kind === 'bound' ? a.window.sequence : Number.POSITIVE_INFINITY
  const bSeq = b.window.kind === 'bound' ? b.window.sequence : Number.POSITIVE_INFINITY
  if (aSeq !== bSeq) {
    return aSeq - bSeq
  }
  return (b.lastVisitedAt ?? 0) - (a.lastVisitedAt ?? 0)
}

export function projectDesk(input: DeskProjectionInput): DeskProjection {
  const bindings = input.windows
    ? new Map(
        input.windows.flatMap((entry) =>
          entry.binding ? [[entry.binding.worktreeId, entry] as const] : []
        )
      )
    : null
  const totals: DeskTotals = {
    workspaces: 0,
    tabs: 0,
    panes: 0,
    byResidency: { warm: 0, dormant: 0, 'no-process': 0, unknown: 0 }
  }
  const hosts: DeskHost[] = input.hosts.map((host) => {
    if (host.session.kind === 'unreadable') {
      return { kind: 'unreadable', hostId: host.hostId, reason: host.session.reason }
    }
    const loaded = host as DeskHostInput & {
      session: { kind: 'loaded'; state: WorkspaceSessionState }
    }
    const resumeHandleTabIds = new Set(
      Object.keys(loaded.session.state.sleepingAgentSessionsByPaneKey ?? {}).flatMap((paneKey) => {
        const parsed = parsePaneKey(paneKey)
        return parsed ? [parsed.tabId] : []
      })
    )
    const workspaces = Object.entries(loaded.session.state.tabsByWorktree)
      .filter(([, tabs]) => tabs.length > 0)
      .map(([key, tabs]): DeskWorkspace => {
        try {
          return projectWorkspace(
            key,
            tabs,
            loaded,
            bindings,
            input.describeWorkspace,
            resumeHandleTabIds
          )
        } catch (error) {
          // Why: one malformed workspace must not take the rest of the desk down with it.
          const reason = error instanceof Error ? error.message : 'unprojectable'
          return { kind: 'unprojectable', key, hostId: host.hostId, reason }
        }
      })
      .sort(workspaceOrder)
    for (const workspace of workspaces) {
      totals.workspaces += 1
      if (workspace.kind !== 'projected') {
        continue
      }
      for (const tab of workspace.tabs) {
        totals.tabs += 1
        totals.panes += tab.panes.length
        totals.byResidency[tab.residency] += 1
      }
    }
    return { kind: 'loaded', hostId: host.hostId, workspaces }
  })
  return {
    hosts,
    windowsRecorded: input.windows !== null,
    windowCount: input.windows?.length ?? 0,
    totals
  }
}
