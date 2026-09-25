import React, { useMemo, useState } from 'react'
import { PanelLeft, PanelRight } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { getTopActivityBarLayout } from './activity-bar-overflow'
import { ActivityBarButton } from './activity-bar-buttons'
import { getActiveChecksStatus } from './active-checks-status'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import {
  RIGHT_SIDEBAR_MIN_WIDTH,
  clampRightSidebarPanelWidth,
  computeMaxRightSidebarPanelWidth
} from './right-sidebar-width'
import { resolveSidePanelDockGeometry } from './side-panel-dock-geometry'
import { translate } from '@/i18n/i18n'
import { RightSidebarPanelContent } from './right-sidebar-panel-content'
import { useMeasuredWidth } from './right-sidebar-measured-width'
import {
  isPairedWebClientWindow,
  shouldRenderDesktopWindowChrome
} from '@/lib/desktop-window-chrome'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { ActivityBarPositionMenu } from './activity-bar-position-menu'
import { WorkspaceActivityRailSection } from '@/components/activity-rail/WorkspaceActivityRailSection'
import { AgentWorkspaceRailEntry } from '@/components/activity-rail/AgentWorkspaceRailEntry'
import { LeftNavProjectsSwitch } from './left-nav-projects-switch'
import { RightSidebarTopActivityBar } from './right-sidebar-top-activity-bar'
import { useRightSidebarActivityItems } from './use-right-sidebar-activity-items'
import { useRightSidebarTabRouting } from './use-right-sidebar-tab-routing'
import { useWindowWidth } from './use-window-width'

const ACTIVITY_BAR_SIDE_WIDTH = 40

function RightSidebarInner(): React.JSX.Element {
  const sidePanelDock = useAppStore((s) => s.sidePanelDock)
  const geometry = resolveSidePanelDockGeometry(sidePanelDock)
  const hasDesktopWindowChrome =
    geometry.appliesWindowControlsInset &&
    shouldRenderDesktopWindowChrome({
      platform: getRendererAppPlatform(),
      isWebClient: isPairedWebClientWindow()
    })
  const rightSidebarShortcut = useShortcutLabel('sidebar.right.toggle')
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth)
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const checksStatus = useAppStore((s) => (s.rightSidebarOpen ? getActiveChecksStatus(s) : null))
  const activityBarPosition = useAppStore((s) => s.activityBarPosition)
  const setActivityBarPosition = useAppStore((s) => s.setActivityBarPosition)
  const [topActivityStripWidth, setTopActivityStripWidth] = useState<number | null>(null)
  const {
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys
  } = useRightSidebarActivityItems({ rightSidebarOpen })
  const { effectiveTab, selectActivityTab } = useRightSidebarTabRouting({
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys
  })

  const activityBarSideWidth = activityBarPosition === 'side' ? ACTIVITY_BAR_SIDE_WIDTH : 0
  const windowWidth = useWindowWidth()
  const maxWidth = computeMaxRightSidebarPanelWidth(windowWidth, activityBarSideWidth)
  const renderedRightSidebarWidth = clampRightSidebarPanelWidth(
    rightSidebarWidth,
    windowWidth,
    activityBarSideWidth
  )
  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: rightSidebarOpen,
    width: renderedRightSidebarWidth,
    minWidth: RIGHT_SIDEBAR_MIN_WIDTH,
    maxWidth,
    deltaSign: geometry.resizeDeltaSign,
    renderedExtraWidth: activityBarSideWidth,
    // Why the strip survives closing docked left: it is the window's own left edge there, and it
    // now carries the switch back to project navigation. A strip that vanishes with the panel takes
    // the only way back with it. Docked right the panel still collapses to nothing, as before.
    closedWidth: geometry.activityBarLeads ? activityBarSideWidth : 0,
    setWidth: setRightSidebarWidth
  })
  const topActivityStripRef = useMeasuredWidth(setTopActivityStripWidth)

  const panelContent = rightSidebarOpen ? (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden scrollbar-sleek-parent">
      {/* Why: sidebar panels no longer use key={activeWorktreeId} because
          the full unmount/remount cycle on every worktree switch triggered
          an IPC storm (watchWorktree + readDir + git:branchCompare + …)
          that froze the app for seconds on Windows.  Each panel now reacts
          to activeWorktreeId changes via store subscriptions and reset
          effects, keeping the component instance alive across switches. */}
      {/* Why: live agent activity now renders inline inside each workspace
          card (WorktreeCardAgents, toggled by the 'inline-agents' card
          property) rather than in a bottom-docked dashboard panel that
          competed with file Explorer/Search for vertical space. The right
          sidebar is back to tab-only content. */}
      <RightSidebarPanelContent effectiveTab={effectiveTab} rightSidebarOpen={rightSidebarOpen} />
    </div>
  ) : null

  const topActivityLayout = useMemo(
    () => getTopActivityBarLayout(visibleItems, topActivityStripWidth, effectiveTab),
    [visibleItems, topActivityStripWidth, effectiveTab]
  )

  // Only omit Workspace from the section when the strip really has an Explorer to place it under.
  const workspaceBelowExplorer =
    geometry.activityBarLeads && visibleItems.some((item) => item.id === 'explorer')
  const sideActivityBarIcons = visibleItems.map((item) => (
    <React.Fragment key={item.id}>
      <ActivityBarButton
        item={item}
        active={effectiveTab === item.id}
        onClick={() => selectActivityTab(item.id)}
        layout="side"
        statusIndicator={item.id === 'checks' ? checksStatus : null}
      />
      {/* Workspace sits directly below Explorer (Owner, 2026-09-24), and only on the leading strip,
          where application navigation already lives. */}
      {item.id === 'explorer' && workspaceBelowExplorer ? <AgentWorkspaceRailEntry /> : null}
    </React.Fragment>
  ))

  const closeButton = rightSidebarOpen ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="sidebar-toggle mr-1"
          onClick={toggleRightSidebar}
          aria-label={translate(
            'auto.components.right.sidebar.index.e8e2e4ce74',
            'Toggle right sidebar'
          )}
        >
          {geometry.activityBarLeads ? <PanelLeft size={16} /> : <PanelRight size={16} />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {translate(
          'auto.components.right.sidebar.index.9fffaf17c1',
          'Toggle right sidebar ({{value0}})',
          { value0: rightSidebarShortcut }
        )}
      </TooltipContent>
    </Tooltip>
  ) : null

  const sideActivityBar = activityBarPosition === 'side' && (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'flex flex-col items-center w-10 min-w-[40px] bg-sidebar border-border',
            geometry.activityBarBorderClass,
            geometry.appliesWindowControlsInset && 'side-activity-bar-windows-inset'
          )}
        >
          <TooltipProvider delayDuration={400}>
            {/* Why only when leading: docked left this strip is the window's own edge, which is
                where application-level navigation belongs. Docked right it is a panel gutter, and
                putting product surfaces there would say the wrong thing about their scope. */}
            {geometry.activityBarLeads ? (
              <WorkspaceActivityRailSection omitAgentWorkspace={workspaceBelowExplorer} />
            ) : null}
            {geometry.activityBarLeads ? <LeftNavProjectsSwitch /> : null}
            {sideActivityBarIcons}
          </TooltipProvider>
        </div>
      </ContextMenuTrigger>
      <ActivityBarPositionMenu
        currentPosition={activityBarPosition}
        onChangePosition={setActivityBarPosition}
      />
    </ContextMenu>
  )

  return (
    <div
      ref={containerRef}
      data-side-panel=""
      className={cn(
        'relative flex-shrink-0 flex flex-row',
        // Why: overflow-visible is needed when open so the resize handle
        // on the inward edge remains interactive.  When closed (width 0),
        // switch to overflow-hidden so the activity bar icons and panel
        // content don't leak past the 0-width boundary (the component
        // stays mounted for performance — see App.tsx).
        rightSidebarOpen ? 'overflow-visible' : 'overflow-hidden'
      )}
    >
      {/* Why: the icon strip always hugs the window edge, so it leads the panel when docked left. */}
      {geometry.activityBarLeads ? sideActivityBar : null}

      {/* Panel content area */}
      <div
        data-side-panel-content=""
        className="flex flex-col flex-1 min-w-0 bg-sidebar overflow-hidden"
        style={
          rightSidebarOpen
            ? { [geometry.panelBorderSide]: '1px solid var(--sidebar-border)' }
            : undefined
        }
      >
        {activityBarPosition === 'top' ? (
          <RightSidebarTopActivityBar
            hasDesktopWindowChrome={hasDesktopWindowChrome}
            topActivityStripRef={topActivityStripRef}
            topActivityLayout={topActivityLayout}
            effectiveTab={effectiveTab}
            onSelectTab={selectActivityTab}
            checksStatus={checksStatus}
            closeButton={closeButton}
            activityBarPosition={activityBarPosition}
            onChangeActivityBarPosition={setActivityBarPosition}
            applyWindowControlsInset={geometry.appliesWindowControlsInset}
          />
        ) : (
          /* ── Side layout: static title header ── */
          /* Why: the 40px side activity bar absorbs the rightmost 40px of the
             138px window-controls overlay when custom desktop chrome is active,
             but the remaining 98px still overlaps the panel header.
             right-sidebar-header-side-inset applies exactly that remainder
             (138-40=98px) as padding-right so the close button clears the
             minimize button without the full 138px gap. */
          <div
            className={cn(
              'flex items-center justify-between h-[36px] min-h-[36px] px-3 border-b border-border right-sidebar-header-drag',
              geometry.appliesWindowControlsInset && 'right-sidebar-header-side-inset'
            )}
          >
            <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
              {visibleItems.find((item) => item.id === effectiveTab)?.title ?? ''}
            </span>
            <TooltipProvider delayDuration={400}>
              <div className="flex items-center">{closeButton}</div>
            </TooltipProvider>
          </div>
        )}

        {panelContent}

        {/* Resize handle on the inward-facing edge */}
        <div
          className={cn(
            'absolute top-0 w-1 h-full cursor-col-resize hover:bg-ring/20 active:bg-ring/30 transition-colors z-10',
            geometry.resizeHandleEdgeClass
          )}
          onMouseDown={onResizeStart}
        />
      </div>

      {geometry.activityBarLeads ? null : sideActivityBar}
    </div>
  )
}

const RightSidebar = React.memo(RightSidebarInner)
export default RightSidebar
