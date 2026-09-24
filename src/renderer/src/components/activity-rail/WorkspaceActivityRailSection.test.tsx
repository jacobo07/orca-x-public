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
  openConversationsPage: vi.fn(),
  openAgentsPage: vi.fn(),
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
import { AgentWorkspaceRailEntry } from './AgentWorkspaceRailEntry'
import { WORKSPACE_ACTIVITY_ORDER, type WorkspaceActivityId } from './workspace-activity-items'

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
    openConversationsPage: mocks.openConversationsPage,
    openAgentsPage: mocks.openAgentsPage,
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

  /**
   * Every visible entry, not a sample of two.
   *
   * `conversations` shipped visible with no branch in the rail's `select`, so it rendered, took
   * focus and dispatched nothing — a dead control, indistinguishable from a working one until
   * somebody clicked it in the real app. The two entries this file happened to cover were both
   * wired, so nothing went red. Driving the whole visible set is what makes the next one fail here
   * instead of in a product-reality run.
   */
  it('leaves no visible activity that dispatches nothing', () => {
    renderRail({
      showConversationsButton: true,
      showAgentsButton: true,
      showArtifactsButton: true,
      showSkillsButton: true,
      experimentalActivity: true
    })

    // A Record, not an array: the array this replaced listed seven of the eight ordered activities
    // — `tasks` was simply never added — so the gate written to catch the next dead control was
    // itself blind to one. Keying by WorkspaceActivityId makes a missing entry a TYPECHECK failure,
    // which is the only form of this gate that a new activity cannot be added around.
    const dispatched: Record<WorkspaceActivityId, ReturnType<typeof vi.fn>> = {
      'agent-workspace': mocks.openConversationsPage,
      workspace: mocks.openWorkspacePage,
      conversations: mocks.openConversationsPage,
      agents: mocks.openAgentsPage,
      tasks: mocks.openTaskPage,
      automations: mocks.openAutomationsPage,
      activity: mocks.openActivityPage,
      artifacts: mocks.openArtifactsPage,
      skills: mocks.openSkillsPage,
      mobile: mocks.openMobilePage
    }

    // Driven in the canonical order, and every ordered id must appear — so an id added to the union
    // but left out of WORKSPACE_ACTIVITY_ORDER cannot hide from this loop either.
    expect(Object.keys(dispatched).sort()).toEqual([...WORKSPACE_ACTIVITY_ORDER].sort())

    for (const id of WORKSPACE_ACTIVITY_ORDER) {
      const open = dispatched[id]
      const button = activity(id)
      // A missing button would make the click a no-op and the assertion below vacuous.
      expect(button, `${id} is not rendered`).not.toBeNull()
      // Two ids can share a page (the renamed entry and the one it replaces), so count per click.
      open.mockClear()
      act(() => button?.click())
      expect(open, `clicking ${id} dispatched nothing`).toHaveBeenCalledTimes(1)
    }
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

    const feed = activity('activity')
    expect(feed?.textContent).toContain('3')
    expect(feed?.getAttribute('aria-label')).toContain('3')
  })

  it('renders nothing when every activity is hidden', () => {
    renderRail({
      showAgentWorkspaceButton: false,
      showWorkspaceButton: false,
      showTasksButton: false,
      showAutomationsButton: false,
      showMobileButton: false
    })

    expect(container.querySelector('[data-workspace-activity-rail]')).toBeNull()
  })

  it('leads with Workspace and calls the launcher Terminals', () => {
    renderRail()

    const first = container.querySelector('[data-workspace-activity]')
    expect(first?.getAttribute('data-workspace-activity')).toBe('agent-workspace')
    expect(activity('agent-workspace')?.getAttribute('aria-label')).toBe('Workspace')
    expect(activity('workspace')?.getAttribute('aria-label')).toBe('Terminals')

    act(() => activity('agent-workspace')?.click())
    expect(mocks.openConversationsPage).toHaveBeenCalledTimes(1)
  })

  it('leaves Workspace out when the caller draws it below Explorer', () => {
    // Control: the same render without the flag does include it.
    renderRail()
    expect(activity('agent-workspace')).not.toBeNull()

    act(() => {
      root.render(
        <TooltipProvider>
          <WorkspaceActivityRailSection omitAgentWorkspace />
        </TooltipProvider>
      )
    })
    expect(activity('agent-workspace')).toBeNull()
    expect(activity('workspace')).not.toBeNull()
  })

  it('hides Workspace through its own key, not the Chats one', () => {
    renderRail()
    const entry = activity('agent-workspace')?.closest('div')
    const hide = [...(entry?.parentElement?.querySelectorAll('button') ?? [])].find((button) =>
      button.textContent?.includes('Hide from sidebar')
    )
    expect(hide).toBeDefined()
    act(() => hide?.click())

    expect(mocks.updateSettings).toHaveBeenCalledWith({ showAgentWorkspaceButton: false })
  })
})

describe('AgentWorkspaceRailEntry', () => {
  function renderEntry(settings: Record<string, unknown>, activeView = 'terminal'): void {
    mocks.state = {
      settings,
      activeView,
      updateSettings: mocks.updateSettings,
      openConversationsPage: mocks.openConversationsPage
    }
    act(() => {
      root.render(
        <TooltipProvider>
          <AgentWorkspaceRailEntry />
        </TooltipProvider>
      )
    })
  }

  it('opens the agent Workspace and marks itself current on that page', () => {
    renderEntry({}, 'conversations')

    expect(activity('agent-workspace')?.getAttribute('aria-current')).toBe('page')
    act(() => activity('agent-workspace')?.click())
    expect(mocks.openConversationsPage).toHaveBeenCalledTimes(1)
  })

  it('is absent once hidden, and offers the hide that got it there', () => {
    renderEntry({ showAgentWorkspaceButton: false })
    expect(activity('agent-workspace')).toBeNull()

    renderEntry({})
    const hide = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Hide from sidebar')
    )
    act(() => hide?.click())
    expect(mocks.updateSettings).toHaveBeenCalledWith({ showAgentWorkspaceButton: false })
  })
})
