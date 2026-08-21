import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  TERMINAL_RAIL_COLLAPSED_WIDTH,
  TERMINAL_RAIL_MAX_WIDTH,
  TERMINAL_RAIL_MIN_WIDTH
} from '../../../../shared/terminal-rail-width'
import {
  resolveTerminalTabActivityStatus,
  terminalTabHasUnreadActivity
} from '../tab-bar/terminal-tab-activity-status'
import { useTabAgent } from '@/lib/use-tab-agent'
import { buildTerminalRailRows, findActiveTerminalRailRow } from './terminal-rail-rows'
import { TerminalRailPaneRow, TerminalRailTabRow } from './TerminalRailRow'
import { TerminalRailToolbar } from './TerminalRailToolbar'
import { useTerminalRailResize } from './use-terminal-rail-resize'

/**
 * The terminal rail: which terminals exist, which one is selected, and what each is doing.
 *
 * Before this, terminal instances were only visible as horizontal tabs and the sole control near
 * the terminal was an 18px split glyph alone in an overlay strip across the canvas. The rail is
 * where the terminal's own chrome lives, so those actions have somewhere to belong.
 */

function TerminalRailTab({
  tab,
  paneCount,
  isActive,
  onSelect
}: {
  tab: TerminalTab
  paneCount: number
  isActive: boolean
  onSelect: () => void
}): React.JSX.Element {
  // Why: the same selector the tab strip uses, so the rail cannot show a state the tab denies.
  const activityStatus = useAppStore((s) =>
    resolveTerminalTabActivityStatus({
      tab,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      agentStatusEpoch: s.agentStatusEpoch,
      runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
      ptyIdsByTabId: s.ptyIdsByTabId,
      terminalLayout: s.terminalLayoutsByTabId?.[tab.id]
    })
  )
  const hasUnreadActivity = useAppStore((s) =>
    terminalTabHasUnreadActivity({
      terminalTabId: tab.id,
      unreadTerminalTabs: s.unreadTerminalTabs,
      unreadAgentCompletionPanes: s.unreadAgentCompletionPanes
    })
  )
  const agent = useTabAgent(tab)

  return (
    <TerminalRailTabRow
      tab={tab}
      agent={agent}
      activityStatus={activityStatus}
      paneCount={paneCount}
      isActive={isActive}
      hasUnreadActivity={hasUnreadActivity}
      onSelect={onSelect}
      onContextMenu={(event) => event.preventDefault()}
    />
  )
}

export default function TerminalRail({
  worktreeId,
  groupId,
  tabs,
  activeTabId,
  onNewTerminalTab,
  onNewTerminalWithShell,
  onSplitActiveTerminal,
  onCloseTerminal
}: {
  worktreeId: string
  groupId: string
  tabs: readonly TerminalTab[]
  activeTabId: string | null
  onNewTerminalTab: () => void
  onNewTerminalWithShell?: (shell: string) => void
  onSplitActiveTerminal: (direction: 'vertical' | 'horizontal') => void
  onCloseTerminal: (tabId: string) => void
}): React.JSX.Element | null {
  const { collapsed, width, toggleCollapsed } = useAppStore(
    useShallow((s) => ({
      collapsed: s.terminalRailCollapsed,
      width: s.terminalRailWidth,
      toggleCollapsed: s.toggleTerminalRailCollapsed
    }))
  )
  const layoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const { onResizeHandlePointerDown, isResizing } = useTerminalRailResize()

  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs])
  const rows = useMemo(
    () => buildTerminalRailRows({ tabIds, layoutsByTabId: layoutsByTabId ?? {} }),
    [layoutsByTabId, tabIds]
  )
  const activeRow = findActiveTerminalRailRow(
    rows,
    activeTabId,
    activeTabId ? layoutsByTabId?.[activeTabId]?.activeLeafId : null
  )
  const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs])

  return (
    <div
      data-terminal-rail=""
      {...(collapsed ? { 'data-collapsed': '' } : {})}
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-background"
      style={{ width: collapsed ? TERMINAL_RAIL_COLLAPSED_WIDTH : width }}
    >
      {collapsed ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={translate(
            'auto.components.terminal.rail.TerminalRail.resize',
            'Resize terminal rail'
          )}
          aria-valuemin={TERMINAL_RAIL_MIN_WIDTH}
          aria-valuemax={TERMINAL_RAIL_MAX_WIDTH}
          aria-valuenow={width}
          onPointerDown={onResizeHandlePointerDown}
          className={cn(
            'absolute inset-y-0 -left-[3px] z-10 w-[6px] cursor-col-resize',
            isResizing && 'bg-accent'
          )}
        />
      )}
      <TerminalRailToolbar
        worktreeId={worktreeId}
        groupId={groupId}
        collapsed={collapsed}
        canActOnTerminal={activeTabId !== null}
        onToggleCollapsed={toggleCollapsed}
        onNewTerminalTab={onNewTerminalTab}
        onNewTerminalWithShell={onNewTerminalWithShell}
        onSplitActiveTerminal={onSplitActiveTerminal}
        onCloseActiveTerminal={() => {
          if (activeTabId) {
            onCloseTerminal(activeTabId)
          }
        }}
      />
      {collapsed ? null : (
        <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1">
          {rows.map((row) => {
            if (row.kind === 'tab') {
              const tab = tabsById.get(row.tabId)
              if (!tab) {
                return null
              }
              return (
                <TerminalRailTab
                  key={`tab-${row.tabId}`}
                  tab={tab}
                  paneCount={row.paneCount}
                  isActive={activeRow === row}
                  onSelect={() => activateTabAndFocusPane(row.tabId, row.leafId)}
                />
              )
            }
            // Why: makePaneKey rejects legacy numeric leaf ids, and a pane whose key cannot be
            // built simply has no status to show — better than fabricating one for it.
            const agentState = isTerminalLeafId(row.leafId)
              ? (agentStatusByPaneKey?.[makePaneKey(row.tabId, row.leafId)]?.state ?? null)
              : null
            const customTitle = layoutsByTabId?.[row.tabId]?.titlesByLeafId?.[row.leafId]
            return (
              <TerminalRailPaneRow
                key={`pane-${row.leafId}`}
                label={
                  customTitle ??
                  `${translate('auto.components.terminal.rail.TerminalRail.pane', 'Pane')} ${row.position}`
                }
                agentState={agentState}
                isActive={activeRow === row}
                onSelect={() => activateTabAndFocusPane(row.tabId, row.leafId)}
                onContextMenu={(event) => event.preventDefault()}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
