import { canShowRightSidebarForView } from './right-sidebar-visibility'
import type { SidePanelDock, TopLevelView } from '../../../shared/ui-chrome-types'

/**
 * Which surface owns the left region.
 *
 * Docked left, the file panel and the project sidebar are two navigation surfaces in one spatial
 * role. Rendering both leaves the workspace a minority of the window, so the panel takes the region
 * while it is open and the project sidebar yields.
 *
 * Derived, never written. Closing the panel restores whatever the user had chosen for the project
 * sidebar, because that preference was never overwritten to express the exclusivity — a switch is a
 * presentation change, not a reset of the thing you switched away from.
 *
 * Docked right the two sit on opposite edges serving distinct roles, so neither yields.
 */

export function projectSidebarYieldsToPanel({
  sidePanelDock,
  rightSidebarOpen,
  activeView,
  hasActiveProject
}: {
  sidePanelDock: SidePanelDock
  rightSidebarOpen: boolean
  activeView: TopLevelView
  hasActiveProject: boolean
}): boolean {
  return (
    sidePanelDock === 'left' &&
    rightSidebarOpen &&
    canShowRightSidebarForView(activeView, hasActiveProject)
  )
}

export type ProjectSidebarRevealState = {
  sidebarOpen: boolean
  sidePanelDock: SidePanelDock
  rightSidebarOpen: boolean
  activeView: TopLevelView
  activeWorktreeId: string | null
  setSidebarOpen: (open: boolean) => void
  toggleRightSidebar: () => void
}

/** Shows the project sidebar; returns whether anything changed. Docked left, opening it is not enough while the panel holds the region. */
export function revealProjectSidebar(state: ProjectSidebarRevealState): boolean {
  // Why view-aware: on views that unmount the panel, closing it would only discard the saved preference.
  const panelHoldsRegion = projectSidebarYieldsToPanel({
    sidePanelDock: state.sidePanelDock,
    rightSidebarOpen: state.rightSidebarOpen,
    activeView: state.activeView,
    hasActiveProject: state.activeWorktreeId !== null
  })
  if (state.sidebarOpen && !panelHoldsRegion) {
    return false
  }
  state.setSidebarOpen(true)
  if (panelHoldsRegion) {
    state.toggleRightSidebar()
  }
  return true
}

export function resolveEffectiveSidebarOpen({
  sidebarOpen,
  sidePanelDock,
  rightSidebarOpen,
  activeView,
  hasActiveProject
}: {
  sidebarOpen: boolean
  sidePanelDock: SidePanelDock
  rightSidebarOpen: boolean
  activeView: TopLevelView
  hasActiveProject: boolean
}): boolean {
  return (
    sidebarOpen &&
    !projectSidebarYieldsToPanel({
      sidePanelDock,
      rightSidebarOpen,
      activeView,
      hasActiveProject
    })
  )
}
