import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { resolveLeftSidebarStyleVariables } from '@/lib/left-sidebar-appearance'
import { resolveEffectiveSidebarOpen } from '@/lib/left-navigation-surface'
import { resolveLeftTitlebarChromeLayout } from '@/lib/titlebar-left-chrome'
import { shouldShowWorktreeCreationSurface } from '@/lib/worktree-creation-surface'
import { useAppStore } from '../store'
import { selectActiveTerminalChromeState } from '../store/active-terminal-chrome-selector'
import { useSystemPrefersDark } from '../components/terminal-pane/use-system-prefers-dark'
import {
  hasRequestedBackgroundTerminalWorktreeMount,
  subscribeBackgroundTerminalWorktreeMountRequests
} from '../components/terminal/background-terminal-worktree-mount'

export type AppChromeLayout = ReturnType<typeof useAppChromeLayout>

/**
 * Derives the App shell's layout decisions — which titlebar variant mounts, whether the
 * workspace owns the tab strip, and which surfaces stay mounted — from store state.
 */
export function useAppChromeLayout() {
  const activeView = useAppStore((s) => s.activeView)
  const storedSidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarExplorerView = useAppStore((s) => s.rightSidebarExplorerView)
  const sidePanelDock = useAppStore((s) => s.sidePanelDock)
  const floatingWorkspaceDock = useAppStore((s) => s.floatingWorkspaceDock)
  const floatingWorkspaceBottomHeight = useAppStore((s) => s.floatingWorkspaceBottomHeight)
  const isFullScreen = useAppStore((s) => s.isFullScreen)
  const settings = useAppStore((s) => s.settings)
  const activePendingCreationId = useAppStore((s) => s.activePendingCreationId)
  // Why: the creation surface owns the tab strip from the first pending frame; gating on the delayed loader flag swapped the tab bar mid-create.
  const activePendingCreationExists = useAppStore(
    (s) =>
      s.activePendingCreationId !== null &&
      s.pendingWorktreeCreations[s.activePendingCreationId] !== undefined
  )
  const {
    activeWorktreeId,
    tabCount,
    effectiveActiveTabId,
    activeTabCanExpand,
    effectiveActiveTabExpanded
  } = useAppStore(useShallow(selectActiveTerminalChromeState))
  const backgroundTerminalMountRequested = useSyncExternalStore(
    subscribeBackgroundTerminalWorktreeMountRequests,
    hasRequestedBackgroundTerminalWorktreeMount,
    hasRequestedBackgroundTerminalWorktreeMount
  )

  // Docked left the panel and the project sidebar are alternatives, so one yields rather than both
  // stacking. Derived, so closing the panel restores the user's own sidebar choice untouched.
  const sidebarOpen = resolveEffectiveSidebarOpen({
    sidebarOpen: storedSidebarOpen,
    sidePanelDock,
    rightSidebarOpen,
    activeView
  })

  const systemPrefersDark = useSystemPrefersDark()
  const leftSidebarStyle = useMemo(
    () => resolveLeftSidebarStyleVariables(settings, systemPrefersDark),
    [settings, systemPrefersDark]
  ) as React.CSSProperties | undefined

  const canMountTerminalWorkbenchNow = activeWorktreeId !== null || backgroundTerminalMountRequested
  // Why a latch in state, not a ref: the write has to be visible to the next render, and a
  // render-phase ref write would also survive a render React discards. Setting state during
  // render is the supported way to derive it, and the `||` below keeps this render correct.
  const [hasMountedTerminalWorkbench, setHasMountedTerminalWorkbench] = useState(false)
  if (canMountTerminalWorkbenchNow && !hasMountedTerminalWorkbench) {
    setHasMountedTerminalWorkbench(true)
  }
  // Why: skip the terminal bundle on the landing path, but once mounted keep hidden panes alive through sleep/shutdown when activeWorktreeId briefly goes null.
  const shouldMountTerminalWorkbench = canMountTerminalWorkbenchNow || hasMountedTerminalWorkbench
  // Why: visible worktree creation owns its faux tab strip start to finish; keep the previous workspace mounted for retention without real chrome.
  const creationLayoutActive = shouldShowWorktreeCreationSurface({
    activeView,
    activePendingCreationId,
    hasActivePendingCreation: activePendingCreationExists
  })
  const workspaceChromeActive =
    activeView === 'terminal' && activeWorktreeId !== null && !creationLayoutActive
  const hasTabBar = tabCount >= 2
  // Activity/Space are full-page navigation surfaces (like Settings), so the worktree sidebar is hidden there.
  const showSidebar =
    activeView !== 'settings' && activeView !== 'activity' && activeView !== 'space'
  // Tasks/Landing show the full titlebar only when the sidebar is collapsed; open, they mirror workspace view (creation suppresses it).
  const stackedSidebarOpen =
    !workspaceChromeActive && !creationLayoutActive && showSidebar && sidebarOpen
  // Visible creation keeps only the top-left window chrome; tabs and right-sidebar chrome stay gated by workspaceChromeActive.
  const leftTitlebarChromeLayout = resolveLeftTitlebarChromeLayout({
    workspaceChromeActive,
    stackedSidebarOpen,
    creationLayoutActive,
    sidebarOpen
  })

  // Why: useLayoutEffect fires before paint, so dispatching SYNC_FIT_PANES_EVENT reflows the terminal in the same frame as the width change — no wrongly-sized transient.
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent(SYNC_FIT_PANES_EVENT))
  }, [sidebarOpen, rightSidebarOpen])

  // Why measured rather than a constant: the cluster is as wide as the project's name, and the tab
  // strip has to reserve exactly that. Reserving too little draws the name over the strip's own
  // trailing buttons, which then take clicks meant for the name and vice versa.
  const workspaceProjectChromeRef = useRef<HTMLDivElement | null>(null)
  const [workspaceProjectChromeWidth, setWorkspaceProjectChromeWidth] = useState(0)
  useLayoutEffect(() => {
    const chrome = workspaceProjectChromeRef.current
    if (!chrome) {
      setWorkspaceProjectChromeWidth(0)
      return
    }
    const updateWidth = (): void => {
      setWorkspaceProjectChromeWidth(chrome.getBoundingClientRect().width)
    }
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(chrome)
    return () => observer.disconnect()
  }, [workspaceChromeActive])

  const titlebarLeftControlsRef = useRef<HTMLDivElement | null>(null)
  const [collapsedSidebarHeaderWidth, setCollapsedSidebarHeaderWidth] = useState(0)
  useLayoutEffect(() => {
    const controls = titlebarLeftControlsRef.current
    if (!controls) {
      return
    }

    const updateWidth = (): void => {
      setCollapsedSidebarHeaderWidth(controls.getBoundingClientRect().width)
    }

    updateWidth()
    const observer = new ResizeObserver(() => {
      updateWidth()
    })
    observer.observe(controls)
    return () => observer.disconnect()
  }, [
    isFullScreen,
    settings?.showTitlebarAppName,
    showSidebar,
    leftTitlebarChromeLayout.isFloating,
    sidebarOpen
  ])

  // Why max(0, …): the header is allowed to exceed the column it sits above — six localized menu
  // labels do not fit a 280px project sidebar — and the top-left tab group reserves exactly the part
  // that overhangs, so the menu is never drawn on tab one. Collapsed, the column is 0 wide, which
  // makes the previous "reserve the whole header" case the same measurement rather than a second one.
  const titlebarLeftOverhangWidth = Math.max(
    0,
    collapsedSidebarHeaderWidth - (sidebarOpen ? sidebarWidth : 0)
  )

  return {
    activeView,
    activeWorktreeId,
    titlebarLeftOverhangWidth,
    activePendingCreationId,
    activeTabCanExpand,
    effectiveActiveTabId,
    collapsedSidebarHeaderWidth,
    creationLayoutActive,
    isFullScreen,
    leftSidebarStyle,
    leftTitlebarChromeLayout,
    rightSidebarExplorerView,
    rightSidebarOpen,
    rightSidebarTab,
    shouldMountTerminalWorkbench,
    showSidebar,
    sidePanelDock,
    floatingWorkspaceDock,
    floatingWorkspaceBottomHeight,
    // Full-page navigation surfaces own the whole content area, so suppress right-sidebar controls.
    showRightSidebarControls: !creationLayoutActive && canShowRightSidebarForView(activeView),
    showTitlebarAppName: settings?.showTitlebarAppName !== false,
    showTitlebarExpandButton: workspaceChromeActive && !hasTabBar && effectiveActiveTabExpanded,
    sidebarOpen,
    stackedSidebarOpen,
    // Why: the workbench stays mounted while hidden, so visibility tracks the same condition separately.
    terminalWorkbenchVisible: workspaceChromeActive,
    titlebarLeftControlsRef,
    workspaceChromeActive,
    workspaceProjectChromeRef,
    workspaceProjectChromeWidth
  }
}
