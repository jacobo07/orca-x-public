// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppShortcutState } from './app-command-handlers'
import { TOGGLE_WORKSPACE_BOARD_EVENT } from '../components/sidebar/useWorkspaceBoardPanel'

const store = {
  activeView: 'terminal' as 'terminal' | 'workspace',
  activeWorktreeId: 'wt-1' as string | null,
  sidebarOpen: true,
  sidePanelDock: 'left' as 'left' | 'right',
  rightSidebarOpen: true,
  showSleepingWorkspaces: false,
  setSidebarOpen: vi.fn(),
  toggleRightSidebar: vi.fn(),
  setShowSleepingWorkspaces: vi.fn()
}

vi.mock('../store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/scroll-to-current-workspace-status', () => ({
  requestScrollToCurrentWorkspaceRevealAndRename: vi.fn()
}))

const { createAppCommandHandlers } = await import('./app-command-handlers')

function shortcutState(): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    actions: {} as AppShortcutState['actions'],
    creationLayoutActive: false,
    floatingTerminalEnabled: false,
    floatingTerminalOpen: false,
    floatingVisibleTabCount: 0,
    keybindings: {} as AppShortcutState['keybindings'],
    openFloatingWorkspaceMaximized: vi.fn(),
    pluginCommands: [] as unknown as AppShortcutState['pluginCommands'],
    setFloatingTerminalOpen: vi.fn(),
    terminalShortcutPolicy: undefined,
    workspaceChromeActive: true
  }
}

const REVEALING_COMMANDS = [
  'sidebar.sleepingWorkspaces.toggle',
  'workspace.rename',
  'workspace.openBoard'
] as const

describe('commands that show the project sidebar', () => {
  beforeEach(() => {
    store.activeView = 'terminal'
    store.activeWorktreeId = 'wt-1'
    store.sidebarOpen = true
    store.sidePanelDock = 'left'
    store.rightSidebarOpen = true
    store.showSleepingWorkspaces = false
    vi.clearAllMocks()
  })

  it.each(REVEALING_COMMANDS)(
    '%s closes a left-docked panel, which otherwise keeps the sidebar yielded',
    (actionId) => {
      const claimed = createAppCommandHandlers(shortcutState()).get(actionId)!()

      expect(claimed).toBe(true)
      expect(store.setSidebarOpen).toHaveBeenCalledWith(true)
      expect(store.toggleRightSidebar).toHaveBeenCalledTimes(1)
    }
  )

  it.each(REVEALING_COMMANDS)(
    '%s keeps the panel preference on a view that does not mount the panel',
    (actionId) => {
      store.activeView = 'workspace'

      createAppCommandHandlers(shortcutState()).get(actionId)!()

      expect(store.toggleRightSidebar).not.toHaveBeenCalled()
    }
  )

  it('opens a closed sidebar without touching a closed panel', () => {
    store.sidebarOpen = false
    store.rightSidebarOpen = false

    createAppCommandHandlers(shortcutState()).get('workspace.rename')!()

    expect(store.setSidebarOpen).toHaveBeenCalledWith(true)
    expect(store.toggleRightSidebar).not.toHaveBeenCalled()
  })

  it('leaves a right-docked panel open and still toggles the board', () => {
    store.sidePanelDock = 'right'
    const dispatched = vi.spyOn(window, 'dispatchEvent')

    createAppCommandHandlers(shortcutState()).get('workspace.openBoard')!()

    expect(store.toggleRightSidebar).not.toHaveBeenCalled()
    expect(dispatched).toHaveBeenCalledWith(
      expect.objectContaining({ type: TOGGLE_WORKSPACE_BOARD_EVENT })
    )
    dispatched.mockRestore()
  })

  it('does not touch the panel when hiding sleeping workspaces', () => {
    store.showSleepingWorkspaces = true

    createAppCommandHandlers(shortcutState()).get('sidebar.sleepingWorkspaces.toggle')!()

    expect(store.setShowSleepingWorkspaces).toHaveBeenCalledWith(false)
    expect(store.toggleRightSidebar).not.toHaveBeenCalled()
  })
})
