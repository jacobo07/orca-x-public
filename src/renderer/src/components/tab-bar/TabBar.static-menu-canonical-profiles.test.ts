import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expandNode, findDropdownMenuItemByText } from './tab-bar-dropdown-menu-item-probe'
import {
  stubBrowserTab,
  stubDropdownMenu,
  stubEditorFileTab,
  stubEditorLabels,
  stubFocusTerminalTabSurface,
  stubHeadlessReact,
  stubQuickLaunchButton,
  stubShallowSelector,
  stubShellIcons,
  stubSortableContext,
  stubSortableTab,
  stubStatusDisplay,
  stubTabInsertion,
  stubTabStripDragScroll
} from './tab-bar-windows-shell-launch-render-stubs'
import {
  appStoreSnapshot,
  resetAppStoreSnapshot,
  useAppStoreExport
} from './tab-bar-windows-shell-launch-test-harness'

vi.mock('react', async () => await stubHeadlessReact())
vi.mock('zustand/react/shallow', () => stubShallowSelector())
vi.mock('lucide-react', async () => (await import('./lucide-icon-stub-fixture')).stubEveryIcon())
vi.mock('@dnd-kit/sortable', () => stubSortableContext())
vi.mock('./tab-strip-drag-scroll', () => stubTabStripDragScroll())
vi.mock('../../store', () => ({ useAppStore: useAppStoreExport }))
vi.mock('../right-sidebar/status-display', () => stubStatusDisplay())
vi.mock('../tab-group/tab-insertion', () => stubTabInsertion())
vi.mock('@/components/editor/editor-labels', () => stubEditorLabels())
vi.mock('./SortableTab', () => stubSortableTab())
vi.mock('./EditorFileTab', () => stubEditorFileTab())
vi.mock('./BrowserTab', () => stubBrowserTab())
vi.mock('./QuickLaunchButton', () => stubQuickLaunchButton())
vi.mock('./shell-icons', () => stubShellIcons())
vi.mock('@/lib/focus-terminal-tab-surface', () => stubFocusTerminalTabSurface())
vi.mock('@/components/ui/dropdown-menu', () => stubDropdownMenu())

/**
 * The "+" menu has two branches: the one you get after typing, and the one you get before typing.
 * Only the first was migrated to the canonical profile set, so a user-declared profile existed,
 * launched correctly, and was invisible in the menu most people actually open.
 */
describe('TabBar static create menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    resetAppStoreSnapshot()
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const renderTabBar = async (): Promise<unknown> => {
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(false),
          listDistros: vi.fn().mockResolvedValue([])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(true) },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) },
        fs: { pathExists: vi.fn().mockResolvedValue(true) }
      }
    })
    const capabilities = await import('@/lib/windows-terminal-capabilities')
    await capabilities.loadWindowsTerminalCapabilities()

    const tabBarModule = await import('./TabBar')
    const candidate = tabBarModule.default ?? tabBarModule
    const TabBar =
      typeof candidate === 'function'
        ? candidate
        : typeof (candidate as { type?: unknown }).type === 'function'
          ? (candidate as { type: (props: Record<string, unknown>) => unknown }).type
          : null
    expect(TabBar).not.toBeNull()

    return TabBar!({
      tabs: [],
      activeTabId: null,
      worktreeId: 'wt-1',
      expandedPaneByTabId: {},
      onActivate: () => {},
      onClose: () => {},
      onCloseOthers: () => {},
      onCloseToRight: () => {},
      onCloseToLeft: () => {},
      onNewTerminalTab: () => {},
      onNewTerminalWithShell: () => {},
      onNewBrowserTab: () => {},
      onSetCustomTitle: () => {},
      onSetTabColor: () => {},
      onTogglePaneExpand: () => {}
    })
  }

  it('offers a user-declared profile without the user having to search for it', async () => {
    appStoreSnapshot.terminalLaunchProfiles = [
      { id: 'kclaude', label: 'kClaude', command: 'kclaude' }
    ]

    const element = await renderTabBar()

    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: kClaude')).not.toBeNull()
  }, 30_000)

  it('still offers the detected shells alongside it', async () => {
    appStoreSnapshot.terminalLaunchProfiles = [
      { id: 'kclaude', label: 'kClaude', command: 'kclaude' }
    ]

    const element = await renderTabBar()

    expect(
      findDropdownMenuItemByText(expandNode(element), 'New Terminal: PowerShell')
    ).not.toBeNull()
  }, 30_000)
})
