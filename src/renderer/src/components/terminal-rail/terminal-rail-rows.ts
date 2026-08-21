import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../../shared/terminal-tab-types'

/**
 * Projects terminal tabs into the rail's rows.
 *
 * Orca already draws the distinction Cursor's terminal panel does, it just never showed it: a
 * terminal tab owns a pane tree, and each leaf of that tree is a running terminal. So a tab is the
 * group, a leaf is the instance, and the rail needs no new abstraction — only a walk of the tree
 * the tab already persists.
 *
 * A tab with one pane gets no child row. The pane *is* the tab there, and a lone child row would
 * suggest a grouping the user never made.
 */

export type TerminalRailRow =
  | {
      readonly kind: 'tab'
      readonly tabId: string
      /** Set only when the tab holds exactly one pane, so selecting the row can focus it. */
      readonly leafId: string | null
      readonly paneCount: number
    }
  | {
      readonly kind: 'pane'
      readonly tabId: string
      readonly leafId: string
      /** 1-based position in the tab, used to name a pane the user never named. */
      readonly position: number
    }

/** Leaves in the order the tree lays them out, which is the order the user sees on screen. */
export function collectOrderedLeafIds(root: TerminalPaneLayoutNode | null | undefined): string[] {
  if (!root) {
    return []
  }
  if (root.type === 'leaf') {
    return [root.leafId]
  }
  return [...collectOrderedLeafIds(root.first), ...collectOrderedLeafIds(root.second)]
}

export function buildTerminalRailRows({
  tabIds,
  layoutsByTabId
}: {
  tabIds: readonly string[]
  layoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot | undefined>>
}): TerminalRailRow[] {
  const rows: TerminalRailRow[] = []
  for (const tabId of tabIds) {
    const leafIds = collectOrderedLeafIds(layoutsByTabId[tabId]?.root)
    rows.push({
      kind: 'tab',
      tabId,
      leafId: leafIds.length === 1 ? leafIds[0] : null,
      paneCount: leafIds.length
    })
    if (leafIds.length < 2) {
      continue
    }
    leafIds.forEach((leafId, index) => {
      rows.push({ kind: 'pane', tabId, leafId, position: index + 1 })
    })
  }
  return rows
}

/**
 * The row a selection should land on: the pane row when the active pane is one of several, the tab
 * row otherwise. Derived from the layout's own `activeLeafId` rather than from what looks focused,
 * so the rail cannot disagree with the pane that actually has the runtime.
 */
export function findActiveTerminalRailRow(
  rows: readonly TerminalRailRow[],
  activeTabId: string | null,
  activeLeafId: string | null | undefined
): TerminalRailRow | null {
  if (!activeTabId) {
    return null
  }
  const paneRow = activeLeafId
    ? rows.find(
        (row) => row.kind === 'pane' && row.tabId === activeTabId && row.leafId === activeLeafId
      )
    : undefined
  return paneRow ?? rows.find((row) => row.kind === 'tab' && row.tabId === activeTabId) ?? null
}
