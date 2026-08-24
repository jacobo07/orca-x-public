import { Suspense, useMemo } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { useDroppable } from '@dnd-kit/core'
import { Ellipsis, X } from 'lucide-react'
import { useAppStore } from '../../store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import TabBar from '../tab-bar/TabBar'
import TerminalRail from '../terminal-rail/TerminalRail'
import { TerminalPanelToolbar } from '../terminal-rail/TerminalPanelToolbar'
import { requestActiveTerminalPaneSplit } from '../tab-bar/request-active-terminal-pane-split'

import { TabBarQuickCommandsButton } from '../tab-bar/TabBarQuickCommandsButton'
import { useTabGroupWorkspaceModel } from './useTabGroupWorkspaceModel'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { buildTabGroupCloseCommands } from './tab-group-close-commands'
import { resolveGroupTabFromVisibleId } from './tab-group-visible-id'
import { getTabPaneBodyDroppableId, type HoveredTabInsertion } from './useTabDragSplit'
import { tabGroupBodyAnchorName } from './tab-group-body-anchor'
import { translate } from '@/i18n/i18n'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))

export default function TabGroupPanel({
  groupId,
  worktreeId,
  isVisible,
  isFocused,
  hasSplitGroups,
  touchesRightEdge,
  touchesLeftEdge,
  touchesBottomEdge = false,
  suppressLeftBorder = false,
  suppressRightBorder = false,
  suppressBottomBorder = false,
  reserveClosedExplorerToggleSpace,
  reserveCollapsedSidebarHeaderSpace,
  isTabDragActive = false,
  hoveredTabInsertion = null
}: {
  groupId: string
  worktreeId: string
  isVisible: boolean
  isFocused: boolean
  hasSplitGroups: boolean
  touchesRightEdge: boolean
  touchesLeftEdge: boolean
  touchesBottomEdge?: boolean
  suppressLeftBorder?: boolean
  suppressRightBorder?: boolean
  suppressBottomBorder?: boolean
  reserveClosedExplorerToggleSpace: boolean
  reserveCollapsedSidebarHeaderSpace: boolean
  isTabDragActive?: boolean
  hoveredTabInsertion?: HoveredTabInsertion | null
}): React.JSX.Element {
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const sidePanelDock = useAppStore((state) => state.sidePanelDock)
  const terminalRailCollapsed = useAppStore((state) => state.terminalRailCollapsed)
  const toggleTerminalRailCollapsed = useAppStore((state) => state.toggleTerminalRailCollapsed)

  const model = useTabGroupWorkspaceModel({ groupId, worktreeId })
  const { activeTab, browserItems, commands, editorItems, tabBarOrder, terminalTabs } = model
  const { setNodeRef: setBodyDropRef } = useDroppable({
    id: getTabPaneBodyDroppableId(groupId),
    data: {
      kind: 'pane-body',
      groupId,
      worktreeId
    },
    disabled: !isTabDragActive
  })
  // Why: per-group anchor-name lets the worktree-level overlay position panes via CSS anchor positioning, so moving a tab between groups re-targets the anchor instead of remounting xterm (loses alt-screen TUI state) or reloading `<webview>`.
  const bodyAnchorName = tabGroupBodyAnchorName(groupId)
  // Why: memoize so a fresh style object each render doesn't break downstream memoization keyed on referential equality.
  const bodyAnchorStyle = useMemo(
    () => ({ anchorName: bodyAnchorName }) as React.CSSProperties,
    [bodyAnchorName]
  )

  // One resolution of visible-id -> unified item, shared by the tab strip and the rail.
  const closeCommands = buildTabGroupCloseCommands(model.groupTabs, commands)

  const tabBar = (
    <TabBar
      tabs={terminalTabs}
      activeTabId={activeTab?.contentType === 'terminal' ? activeTab.entityId : null}
      groupId={groupId}
      worktreeId={worktreeId}
      expandedPaneByTabId={model.expandedPaneByTabId}
      onActivate={commands.activateTerminal}
      onClose={closeCommands.onClose}
      onCloseOthers={closeCommands.onCloseOthers}
      onCloseToRight={closeCommands.onCloseToRight}
      onCloseToLeft={closeCommands.onCloseToLeft}
      onNewTerminalTab={commands.newTerminalTab}
      onNewTerminalWithShell={commands.newTerminalWithShell}
      onNewBrowserTab={commands.newBrowserTab}
      onNewSimulatorTab={commands.newSimulatorTab}
      onOpenEntry={commands.openEntry}
      onNewFileTab={commands.newFileTab}
      onSetCustomTitle={commands.setTabCustomTitle}
      onSetTabColor={commands.setTabColor}
      onTogglePaneExpand={commands.toggleTerminalPaneExpand}
      editorFiles={editorItems}
      browserTabs={browserItems}
      activeFileId={
        activeTab?.contentType === 'terminal' ||
        activeTab?.contentType === 'browser' ||
        activeTab?.contentType === 'simulator'
          ? null
          : activeTab?.id
      }
      activeBrowserTabId={activeTab?.contentType === 'browser' ? activeTab.entityId : null}
      activeSimulatorTabId={activeTab?.contentType === 'simulator' ? activeTab.id : null}
      activeTabType={
        activeTab?.contentType === 'terminal'
          ? 'terminal'
          : activeTab?.contentType === 'browser'
            ? 'browser'
            : activeTab?.contentType === 'simulator'
              ? 'simulator'
              : 'editor'
      }
      onActivateFile={commands.activateEditor}
      onCloseFile={commands.closeItem}
      onActivateBrowserTab={commands.activateBrowser}
      onCloseBrowserTab={(browserTabId) => {
        const item = model.groupTabs.find(
          (candidate) => candidate.entityId === browserTabId && candidate.contentType === 'browser'
        )
        if (item) {
          commands.closeItem(item.id)
        }
      }}
      onDuplicateBrowserTab={commands.duplicateBrowserTab}
      onCloseAllFiles={commands.closeAllEditorTabsInGroup}
      onMakePreviewFilePermanent={(_fileId, tabId) => {
        if (!tabId) {
          return
        }
        const item = model.groupTabs.find((candidate) => candidate.id === tabId)
        if (!item) {
          return
        }
        commands.makePreviewFilePermanent(item.entityId, item.id)
      }}
      onPinFile={(_fileId, tabId) => {
        if (!tabId) {
          return
        }
        const item = model.groupTabs.find((candidate) => candidate.id === tabId)
        if (!item) {
          return
        }
        commands.pinFile(item.entityId, item.id)
      }}
      tabBarOrder={tabBarOrder}
      hoveredTabInsertion={hoveredTabInsertion}
    />
  )

  const menuButtonClassName =
    'my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
  // Why: focused-only so quick commands and Close split pane stay with the active pane and unfocused strips stay compact.
  const focusedActionChromeClassName = `flex shrink-0 items-center gap-0.5 overflow-hidden transition-[opacity] duration-150 ${
    isFocused ? 'ml-1.5 pointer-events-auto opacity-100' : 'pointer-events-none opacity-0 w-0'
  }`
  return (
    <div
      // Why: vertical borders stay `border-border` so the focus highlight (--accent ~#f5f5f5 in light) doesn't paint a near-white strip by the resize handle; only the bottom border changes on focus.
      // Why: unfocused split groups dim subtly so the focused one reads as selected; only when hasSplitGroups since a lone group has nothing to contrast against.
      className={`group/tab-group relative flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${
        hasSplitGroups
          ? // Why: skip border-l/border-r on edge-touching groups; the split-layout wrapper and right sidebar already paint borders at those seams (double line otherwise).
            ` ${
              touchesLeftEdge || suppressLeftBorder ? '' : 'border-l'
            } ${touchesRightEdge || suppressRightBorder ? '' : 'border-r'} ${
              touchesBottomEdge || suppressBottomBorder ? '' : 'border-b'
            } border-border ${
              isFocused && !touchesBottomEdge && !suppressBottomBorder ? 'border-b-accent' : ''
            } ${isFocused ? '' : 'opacity-95'}`
          : ''
      }`}
      onPointerDown={commands.focusGroup}
      // Why: keyboard/AT focus can enter a split group without a pointer event, so sync group focus to DOM focus for global shortcuts.
      onFocusCapture={commands.focusGroup}
    >
      {/* Why: each split group needs its own tab row because multiple groups can show at once but the titlebar has only one shared center slot. */}
      {/* Why: macOS hiddenInset titleBarStyle makes -webkit-app-region: drag the only way to move the window from this tab row. */}
      <div
        className="h-[32px] shrink-0 border-b border-border bg-card"
        data-tab-group-strip-id={groupId}
        data-terminal-focus-release-surface="true"
        data-worktree-id={worktreeId}
      >
        <div className="flex h-full items-stretch pr-1.5">
          {/* Why: Electron drag hit-test respects no-drag only on DOM descendants, not z-index siblings, so this no-drag spacer keeps the collapsed left-sidebar's floating toggle clickable. */}
          {reserveCollapsedSidebarHeaderSpace && !sidebarOpen ? (
            <div
              className="shrink-0"
              style={
                {
                  width: 'var(--collapsed-sidebar-header-width)',
                  WebkitAppRegion: 'no-drag'
                } as React.CSSProperties
              }
            />
          ) : null}
          {/* Why: mirrors the right-edge reservation below. A left-docked file panel puts its
              reopen toggle at the content edge, which is exactly where the first tab starts — with
              nothing reserved, the only control that brings the panel back is painted on top of
              tab one, where it is invisible and takes the tab's clicks. */}
          {reserveCollapsedSidebarHeaderSpace && sidePanelDock === 'left' && !rightSidebarOpen ? (
            <div
              className="shrink-0"
              style={
                {
                  // The same 40px the right-edge reservation gives this toggle.
                  width: '40px',
                  WebkitAppRegion: 'no-drag'
                } as React.CSSProperties
              }
            />
          ) : null}
          <div className="min-w-0 flex-1 h-full">{tabBar}</div>
          <div
            className="ml-1.5 flex shrink-0 items-center gap-0.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {/* Why here and not in the rail: this is the terminal panel's toolbar, so it belongs in
                the panel's header beside the tab row — and it has to outlive collapsing the rail,
                which is the only thing that can bring the rail back. Inside the cluster so it sits
                before the window-controls reservation rather than under the window buttons.

                The rule ahead of it separates two identical glyphs: the tab row ends in a "New tab"
                plus and this toolbar opens with a "new terminal" plus. Different scopes, but set
                flush together they read as one control drawn twice. */}
            {activeTab?.contentType === 'terminal' ? (
              <div className="mx-1 h-4 w-px shrink-0 self-center bg-border" aria-hidden />
            ) : null}
            {activeTab?.contentType === 'terminal' ? (
              <TerminalPanelToolbar
                worktreeId={worktreeId}
                groupId={groupId}
                isFocused={isFocused}
                railCollapsed={terminalRailCollapsed}
                canActOnTerminal={Boolean(activeTab.entityId)}
                onToggleRail={toggleTerminalRailCollapsed}
                onNewTerminalTab={commands.newTerminalTab}
                onNewTerminalWithShell={commands.newTerminalWithShell}
                onSplitActiveTerminal={(direction) => {
                  requestActiveTerminalPaneSplit({ tabId: activeTab.entityId, direction })
                }}
                onCloseActiveTerminal={() => {
                  const item = resolveGroupTabFromVisibleId(model.groupTabs, activeTab.entityId)
                  if (item?.contentType === 'terminal') {
                    commands.closeItem(item.id)
                    return
                  }
                  closeTerminalTab(activeTab.entityId)
                }}
              />
            ) : null}
            <div className={focusedActionChromeClassName}>
              {isFocused ? (
                <TabBarQuickCommandsButton worktreeId={worktreeId} groupId={groupId} />
              ) : null}
              {isFocused && hasSplitGroups ? (
                <Tooltip>
                  <DropdownMenu modal={false}>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={translate(
                            'auto.components.tab.group.TabGroupPanel.9acaf92093',
                            'Pane Actions'
                          )}
                          onClick={(event) => {
                            event.stopPropagation()
                          }}
                          className={menuButtonClassName}
                        >
                          <Ellipsis className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => {
                          commands.closeGroup()
                        }}
                      >
                        <X className="size-4" />
                        {translate(
                          'auto.components.tab.group.TabGroupPanel.closePaneColumn',
                          'Close split pane'
                        )}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate(
                      'auto.components.tab.group.TabGroupPanel.9acaf92093',
                      'Pane Actions'
                    )}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
          {/* Why: Electron drag hit-test respects no-drag only on DOM descendants, not z-index siblings, so this no-drag spacer keeps the floating chrome cluster + window controls clickable. */}
          {/* The cluster's width is measured because it carries the project's name, and its offset
              from this strip's right edge is the window-controls width it is positioned against.
              Both terms unconditionally: under-reserving paints the project name over these
              buttons, over-reserving only leaves a gap. Not a trade worth making. */}
          {reserveClosedExplorerToggleSpace ? (
            <div
              className="shrink-0"
              style={
                {
                  width:
                    'calc(var(--workspace-project-chrome-width, 0px) + var(--window-controls-width, 0px))',
                  WebkitAppRegion: 'no-drag'
                } as React.CSSProperties
              }
            />
          ) : null}
        </div>
      </div>

      <div
        ref={setBodyDropRef}
        data-tab-group-body-id={groupId}
        data-worktree-id={worktreeId}
        className="relative flex min-h-0 flex-1 overflow-hidden"
      >
        {/* Why: the anchor moves onto this inner box rather than the body so the rail *takes* width
            from the terminal instead of covering it. Panes are positioned to the anchor, so a rail
            painted over the body would leave the PTY sized for a surface it no longer owns. */}
        <div className="relative min-w-0 flex-1" style={bodyAnchorStyle}>
        {/* Why: empty anchor so the agent-sessions tour reads as a terminal-area tip, not toolbar chrome. */}
        {isFocused ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-1/4 h-px"
            data-contextual-tour-target="workspace-agent-terminal-tip"
          />
        ) : null}
        {activeTab &&
          activeTab.contentType !== 'terminal' &&
          activeTab.contentType !== 'browser' &&
          activeTab.contentType !== 'simulator' && (
            <div className="absolute inset-0 flex min-h-0 min-w-0">
              {/* Why: split groups render editor content in a plain relative pane body, not the legacy Terminal.tsx flex column. */}
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {translate(
                      'auto.components.tab.group.TabGroupPanel.814fb04c43',
                      'Loading editor...'
                    )}
                  </div>
                }
              >
                <EditorPanel
                  activeFileId={activeTab.entityId}
                  activeViewStateId={activeTab.id}
                  isVisible={isVisible}
                  isCmdSaveOwner={isFocused}
                />
              </Suspense>
            </div>
          )}

          {/* Why: terminal/browser/simulator panes render at the worktree level (overlay layers); per-group rendering remounted xterm/webview/simulator on split moves. */}
        </div>
        {activeTab?.contentType === 'terminal' ? (
          <TerminalRail
            tabs={terminalTabs}
            activeTabId={activeTab.entityId}
            // Why the same commands the tab strip gets: close semantics resolve a visible id to a
            // unified item, and two surfaces resolving that independently is how they drift.
            tabActions={{
              groupId,
              groupTabs: model.groupTabs,
              onActivate: commands.activateTerminal,
              ...closeCommands
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
