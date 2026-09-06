// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * The rail's behavioural contract, replacing the sidebar-row tests the migration removed.
 *
 * These cover what compaction into a 40px icon most easily loses: reaching a surface at all,
 * hiding one, the per-provider Tasks actions, and the two informational badges.
 */

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  openTaskPage: vi.fn(),
  openAutomationsPage: vi.fn(),
  openActivityPage: vi.fn(),
  openMobilePage: vi.fn(),
  openArtifactsPage: vi.fn(),
  openSkillsPage: vi.fn(),
  openWorkspacePage: vi.fn(),
  updateSettings: vi.fn(),
  dismissMobileOnboardingBadge: vi.fn(),
  unreadCount: 0,
  mobileBadgeVisible: false,
  canBrowseTasks: true,
  visibleTaskProviders: ['github', 'linear'] as string[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('@/hooks/useVisibleTaskProviders', () => ({
  useVisibleTaskProviders: () => ({
    canBrowseTasks: mocks.canBrowseTasks,
    visibleTaskProviders: mocks.visibleTaskProviders,
    prefetchTasks: vi.fn()
  })
}))

vi.mock('@/components/activity/useActivityUnreadCount', () => ({
  useActivityUnreadCount: () => mocks.unreadCount
}))

vi.mock('@/components/sidebar/mobile-sidebar-onboarding-badge', () => ({
  useMobileSidebarOnboardingBadge: () => ({
    visible: mocks.mobileBadgeVisible,
    hasPairedDevice: false,
    dismiss: mocks.dismissMobileOnboardingBadge
  })
}))

// Rendered inline so menu items are assertable without driving a real right-click.
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: ReactNode
    onSelect?: () => void
  }) => (
    <button type="button" onClick={onSelect} {...rest}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />
}))

import { WorkspaceActivityRailSection } from './WorkspaceActivityRailSection'

let container: HTMLDivElement
let root: Root

function renderRail(settings: Record<string, unknown> = {}): void {
  mocks.state = {
    settings,
    activeView: 'terminal',
    updateSettings: mocks.updateSettings,
    openTaskPage: mocks.openTaskPage,
    openAutomationsPage: mocks.openAutomationsPage,
    openActivityPage: mocks.openActivityPage,
    openMobilePage: mocks.openMobilePage,
    openArtifactsPage: mocks.openArtifactsPage,
    openSkillsPage: mocks.openSkillsPage,
    openWorkspacePage: mocks.openWorkspacePage
  }
  act(() => {
    root.render(
      <TooltipProvider>
        <WorkspaceActivityRailSection />
      </TooltipProvider>
    )
  })
}

function activity(id: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-workspace-activity="${id}"]`)
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
  mocks.unreadCount = 0
  mocks.mobileBadgeVisible = false
  mocks.canBrowseTasks = true
  mocks.visibleTaskProviders = ['github', 'linear']
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('WorkspaceActivityRailSection', () => {
  it('renders the default activities and omits the opt-in ones', () => {
    renderRail()

    expect(activity('workspace')).not.toBeNull()
    expect(activity('automations')).not.toBeNull()
    expect(activity('mobile')).not.toBeNull()
    expect(container.querySelector('[data-workspace-activity-tasks]')).not.toBeNull()
    expect(activity('artifacts')).toBeNull()
    expect(activity('skills')).toBeNull()
  })

  it('opens the surface an activity names', () => {
    renderRail()

    act(() => activity('automations')?.click())
    expect(mocks.openAutomationsPage).toHaveBeenCalledTimes(1)

    act(() => activity('workspace')?.click())
    expect(mocks.openWorkspacePage).toHaveBeenCalledTimes(1)
  })

  it('retires the Mobile "New" marker by opening the surface, as the row did', () => {
    mocks.mobileBadgeVisible = true
    renderRail()

    act(() => activity('mobile')?.click())

    expect(mocks.dismissMobileOnboardingBadge).toHaveBeenCalledTimes(1)
    expect(mocks.openMobilePage).toHaveBeenCalledTimes(1)
  })

  it('keeps every activity hideable, writing the same setting the row wrote', () => {
    renderRail()

    const hideButtons = [...container.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('Hide from sidebar')
    )
    expect(hideButtons.length).toBeGreaterThan(0)
    act(() => hideButtons[0]?.click())

    expect(mocks.updateSettings).toHaveBeenCalledTimes(1)
    // Whichever activity came first, hiding writes a false flag rather than anything else.
    expect(Object.values(mocks.updateSettings.mock.calls[0][0])).toEqual([false])
  })

  it('keeps the per-provider Tasks actions the row revealed on hover', () => {
    renderRail()

    const github = container.querySelector<HTMLButtonElement>('[data-task-provider="github"]')
    const linear = container.querySelector<HTMLButtonElement>('[data-task-provider="linear"]')
    expect(github).not.toBeNull()
    expect(linear).not.toBeNull()

    act(() => github?.click())
    expect(mocks.openTaskPage).toHaveBeenCalledWith({ taskSource: 'github' })
  })

  it('drops the provider actions but keeps Tasks hideable when nothing can serve tasks', () => {
    mocks.canBrowseTasks = false
    renderRail()

    expect(container.querySelector('[data-task-provider="github"]')).toBeNull()
    expect(activity('tasks')?.getAttribute('aria-disabled')).toBe('true')

    // The sidebar kept hide reachable while left click stayed inert; so does the rail.
    const hideButtons = [...container.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('Hide from sidebar')
    )
    expect(hideButtons.length).toBeGreaterThan(0)

    act(() => activity('tasks')?.click())
    expect(mocks.openTaskPage).not.toHaveBeenCalled()
  })

  it('carries the unread count into the accessible name, not colour alone', () => {
    mocks.unreadCount = 3
    renderRail({ experimentalActivity: true })

    const agents = activity('agents')
    expect(agents?.textContent).toContain('3')
    expect(agents?.getAttribute('aria-label')).toContain('3')
  })

  it('renders nothing when every activity is hidden', () => {
    renderRail({
      showWorkspaceButton: false,
      showTasksButton: false,
      showAutomationsButton: false,
      showMobileButton: false
    })

    expect(container.querySelector('[data-workspace-activity-rail]')).toBeNull()
  })
})
