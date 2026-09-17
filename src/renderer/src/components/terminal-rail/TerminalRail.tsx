import { useCallback, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { SortableTabContextMenu } from '../tab-bar/SortableTabContextMenu'
import {
  TERMINAL_RAIL_MAX_WIDTH,
  TERMINAL_RAIL_MIN_WIDTH
} from '../../../../shared/terminal-rail-width'
import {
  resolveTerminalTabActivityStatus,
  terminalTabHasUnreadActivity
} from '../tab-bar/terminal-tab-activity-status'
import { useTabAgent } from '@/lib/use-tab-agent'
import { buildTerminalRailRows, findActiveTerminalRailRow } from './terminal-rail-rows'
import { TerminalPreviewHoverTrigger } from '../terminal-preview/TerminalPreviewHoverTrigger'
import { TerminalRailPaneRow, TerminalRailTabRow } from './TerminalRailRow'
import { useTerminalRailResize } from './use-terminal-rail-resize'

/**
 * The terminal rail: which terminals exist, which one is selected, and what each is doing.
 *
 * Purely the list. The controls that act on it live in the group's header strip, where a terminal
 * panel's toolbar belongs and where they stay reachable once this rail is collapsed away.
 */

/**
 * What the rail can do to a terminal beyond selecting it.
 *
 * Close semantics stay with the group's command layer — it owns which unified item a visible id
 * maps to — while pin, colour and title come straight from the store, since those are tab-level
 * facts with no group-scoped resolution to do.
 */
export type TerminalRailTabActions = {
  groupId: string
  /** Unified tabs for this group; supplies the unified id and pin state the menu needs. */
  groupTabs: readonly Tab[]
  onActivate: (visibleId: string) => void
  onClose: (visibleId: string) => void
  onCloseOthers: (visibleId: string) => void
  onCloseToRight: (visibleId: string) => void
  onCloseToLeft: (visibleId: string) => void
}

function TerminalRailTab({
  tab,
  paneCount,
  isActive,
  onSelect,
  actions,
  tabIndex,
  tabCount
}: {
  tab: TerminalTab
  paneCount: number
  isActive: boolean
  onSelect: () => void
  /** Absent on surfaces that only navigate; the row then has no context menu rather than a dead one. */
  actions?: TerminalRailTabActions
  tabIndex: number
  tabCount: number
}): React.JSX.Element {
  // Why: the same selector the tab strip uses, so the rail cannot show a state the tab denies.
  const activityStatus = useAppStore((s) =>
    resolveTerminalTabActivityStatus({
      tab,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      agentStatusEpoch: s.agentStatusEpoch,
      runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
      ptyIdsByTabId: s.ptyIdsByTabId,
      terminalLayout: s.terminalLayoutsByTabId?.[tab.id],
      lastTerminalOutputAtByPaneKey: s.lastTerminalOutputAtByPaneKey
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
  const pinTab = useAppStore((s) => s.pinTab)
  const unpinTab = useAppStore((s) => s.unpinTab)
  const setTabColor = useAppStore((s) => s.setTabColor)
  const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle)

  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [isEditing, setIsEditing] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  // Why: onBlur fires while the input unmounts, so a committed or cancelled rename must be able to
  // refuse a second commit — otherwise Escape discards the edit and the blur writes it back.
  const renameResolvedRef = useRef(false)

  const title = tab.customTitle ?? tab.title
  const unifiedTab = actions?.groupTabs.find(
    (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tab.id
  )
  const unifiedTabId = unifiedTab?.id ?? tab.id

  const openRename = useCallback(() => {
    renameResolvedRef.current = false
    setRenameValue(tab.customTitle ?? tab.title)
    setIsEditing(true)
  }, [tab.customTitle, tab.title])

  const commitRename = useCallback(() => {
    if (renameResolvedRef.current) {
      return
    }
    renameResolvedRef.current = true
    const trimmed = renameValue.trim()
    setTabCustomTitle(tab.id, trimmed.length > 0 ? trimmed : null)
    setIsEditing(false)
  }, [renameValue, setTabCustomTitle, tab.id])

  const cancelRename = useCallback(() => {
    renameResolvedRef.current = true
    setIsEditing(false)
  }, [])

  if (isEditing) {
    return (
      <Input
        autoFocus
        data-terminal-rail-rename-input="true"
        value={renameValue}
        aria-label={translate(
          'auto.components.tab.bar.SortableTab.ab19f603eb',
          'Rename tab {{value0}}',
          { value0: title }
        )}
        onChange={(event) => setRenameValue(event.target.value)}
        onBlur={commitRename}
        onKeyDown={(event) => {
          // Why the composition guard: an Enter that confirms a CJK IME candidate is not an Enter
          // that commits the rename.
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            commitRename()
            return
          }
          if (event.key === 'Escape') {
            cancelRename()
          }
        }}
        className="h-[26px] px-2 text-[12px]"
      />
    )
  }

  return (
    <>
      <TerminalRailTabRow
        tab={tab}
        agent={agent}
        activityStatus={activityStatus}
        paneCount={paneCount}
        isActive={isActive}
        hasUnreadActivity={hasUnreadActivity}
        onSelect={onSelect}
        onContextMenu={(event) => {
          event.preventDefault()
          if (!actions) {
            return
          }
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setMenuOpen(true)
        }}
      />
      {actions ? (
        <SortableTabContextMenu
          tab={tab}
          unifiedTabId={unifiedTabId}
          groupId={actions.groupId}
          isActive={isActive}
          open={menuOpen}
          point={menuPoint}
          tabCount={tabCount}
          hasTabsToRight={tabIndex < tabCount - 1}
          hasTabsToLeft={tabIndex > 0}
          isPinned={unifiedTab?.isPinned === true}
          onOpenChange={setMenuOpen}
          onActivate={actions.onActivate}
          onClose={actions.onClose}
          onCloseOthers={actions.onCloseOthers}
          onCloseToRight={actions.onCloseToRight}
          onCloseToLeft={actions.onCloseToLeft}
          onRenameOpen={openRename}
          onSetTabColor={setTabColor}
          onTogglePin={() => {
            if (unifiedTab?.isPinned === true) {
              unpinTab(unifiedTabId)
              return
            }
            pinTab(unifiedTabId)
          }}
        />
      ) : null}
    </>
  )
}

export default function TerminalRail({
  tabs,
  activeTabId,
  tabActions
}: {
  tabs: readonly TerminalTab[]
  activeTabId: string | null
  tabActions?: TerminalRailTabActions
}): React.JSX.Element | null {
  const { collapsed, width } = useAppStore(
    useShallow((s) => ({
      collapsed: s.terminalRailCollapsed,
      width: s.terminalRailWidth
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

  // Why nothing rather than a stub strip: the toolbar that brings the rail back now lives in the
  // panel header, so a collapsed rail has no control left to hold and would only take width.
  if (collapsed) {
    return null
  }

  return (
    <div
      data-terminal-rail=""
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-background"
      style={{ width }}
    >
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
      <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1">
          {rows.map((row) => {
            if (row.kind === 'tab') {
              const tab = tabsById.get(row.tabId)
              if (!tab) {
                return null
              }
              return (
                <TerminalPreviewHoverTrigger
                  key={`tab-${row.tabId}`}
                  tabId={row.tabId}
                  leafId={row.leafId}
                  title={tab.customTitle ?? tab.title}
                >
                  <TerminalRailTab
                    tab={tab}
                    paneCount={row.paneCount}
                    isActive={activeRow === row}
                    onSelect={() => activateTabAndFocusPane(row.tabId, row.leafId)}
                    actions={tabActions}
                    tabIndex={tabIds.indexOf(row.tabId)}
                    tabCount={tabIds.length}
                  />
                </TerminalPreviewHoverTrigger>
              )
            }
            // Why: makePaneKey rejects legacy numeric leaf ids, and a pane whose key cannot be
            // built simply has no status to show — better than fabricating one for it.
            const agentState = isTerminalLeafId(row.leafId)
              ? (agentStatusByPaneKey?.[makePaneKey(row.tabId, row.leafId)]?.state ?? null)
              : null
            const customTitle = layoutsByTabId?.[row.tabId]?.titlesByLeafId?.[row.leafId]
            const paneLabel =
              customTitle ??
              `${translate('auto.components.terminal.rail.TerminalRail.pane', 'Pane')} ${row.position}`
            return (
              <TerminalPreviewHoverTrigger
                key={`pane-${row.leafId}`}
                tabId={row.tabId}
                leafId={row.leafId}
                title={paneLabel}
              >
                <TerminalRailPaneRow
                  label={paneLabel}
                  agentState={agentState}
                  isActive={activeRow === row}
                  onSelect={() => activateTabAndFocusPane(row.tabId, row.leafId)}
                  onContextMenu={(event) => event.preventDefault()}
                />
              </TerminalPreviewHoverTrigger>
            )
          })}
      </div>
    </div>
  )
}
