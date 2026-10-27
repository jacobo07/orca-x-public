import { normalizeExecutionHostId } from '../../shared/execution-host'
import { isTerminalLeafId } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { PanePreviewRequest, PanePreviewResult } from '../../shared/desk-continuity-read-types'
import { listTabLeafIds, resolvePanePreviewSource } from '../../shared/desk-continuity-projection'
import type { ColdRestoreDetection } from '../daemon/history-reader'

/** The slice of the headless emulator a preview needs. It is given no reply sink, so a replayed query answers no one. */
export type PreviewEmulator = {
  write: (data: string) => Promise<void>
  getVisibleLines: () => string[]
  dispose: () => void
}

export type PanePreviewDeps = {
  getWorkspaceSession: (hostId: string) => WorkspaceSessionState
  readScrollbackRef: (ref: string) => string | null
  detectHistory: (sessionId: string) => Promise<ColdRestoreDetection>
  createEmulator: (size: { cols: number; rows: number }) => PreviewEmulator
}

// Session refs carry no dimensions of their own; a common terminal shape keeps the last screen legible.
const REF_PREVIEW_SIZE = { cols: 120, rows: 32 }
const MAX_COLS = 400
const MAX_ROWS = 200

function parseRequest(value: unknown): PanePreviewRequest | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { hostId, tabId, leafId } = value as Record<string, unknown>
  if (typeof hostId !== 'string' || !normalizeExecutionHostId(hostId)) {
    return null
  }
  if (typeof tabId !== 'string' || tabId.length === 0 || tabId.length > 256) {
    return null
  }
  if (leafId !== null && (typeof leafId !== 'string' || !isTerminalLeafId(leafId))) {
    return null
  }
  return { hostId, tabId, leafId }
}

function findTab(state: WorkspaceSessionState, tabId: string): TerminalTab | null {
  for (const tabs of Object.values(state.tabsByWorktree)) {
    const found = tabs.find((tab) => tab.id === tabId)
    if (found) {
      return found
    }
  }
  return null
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1]!.trim() === '') {
    end -= 1
  }
  return lines.slice(0, end)
}

async function renderIntoEmulator(
  deps: PanePreviewDeps,
  size: { cols: number; rows: number },
  chunks: string[]
): Promise<{ lines: string[]; cols: number; rows: number }> {
  const cols = Math.min(Math.max(1, size.cols), MAX_COLS)
  const rows = Math.min(Math.max(1, size.rows), MAX_ROWS)
  const emulator = deps.createEmulator({ cols, rows })
  try {
    for (const chunk of chunks) {
      await emulator.write(chunk)
    }
    return { lines: trimTrailingBlankLines(emulator.getVisibleLines()), cols, rows }
  } finally {
    emulator.dispose()
  }
}

/**
 * Render a pane's last recorded screen from durable history. It needs no process, never resizes or
 * focuses a terminal, and sends nothing to a PTY. Main resolves the source from its own saved
 * session: the caller names a pane, never a file or a session id.
 */
export async function renderPanePreview(
  request: unknown,
  deps: PanePreviewDeps
): Promise<PanePreviewResult> {
  const parsed = parseRequest(request)
  if (!parsed) {
    return { status: 'invalid-request' }
  }
  const hostId = normalizeExecutionHostId(parsed.hostId)!
  const state = deps.getWorkspaceSession(hostId)
  const tab = findTab(state, parsed.tabId)
  const layout = state.terminalLayoutsByTabId[parsed.tabId]
  if (!tab || (parsed.leafId !== null && !listTabLeafIds(layout).includes(parsed.leafId))) {
    return { status: 'not-found' }
  }
  const source = resolvePanePreviewSource({ tab, layout, hostId, leafId: parsed.leafId })
  if (source.source === 'none') {
    return { status: 'none' }
  }
  if (source.source === 'session-ref') {
    const data = deps.readScrollbackRef(source.ref)
    if (data === null) {
      return { status: 'unreadable', source: 'session-ref' }
    }
    const rendered = await renderIntoEmulator(deps, REF_PREVIEW_SIZE, [data])
    return { status: 'rendered', source: 'session-ref', ...rendered }
  }
  // Why: history lives under encodeURIComponent(sessionId), which leaves '.' and '..' as they are.
  if (source.sessionId === '.' || source.sessionId === '..') {
    return { status: 'unreadable', source: 'daemon-history' }
  }
  const detection = await deps.detectHistory(source.sessionId)
  if (detection.status === 'none') {
    return { status: 'none' }
  }
  if (detection.status === 'unreadable') {
    return { status: 'unreadable', source: 'daemon-history' }
  }
  const info = detection.restoreInfo
  const rendered = await renderIntoEmulator(deps, { cols: info.cols, rows: info.rows }, [
    info.rehydrateSequences,
    info.snapshotAnsi
  ])
  return { status: 'rendered', source: 'daemon-history', ...rendered }
}
