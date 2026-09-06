// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import { i18n } from '../../i18n/i18n'

/**
 * What the sidebar still owns after the application surfaces moved to the activity rail: setup,
 * the dashboard pop-out, and search. The migrated entries are covered by
 * components/activity-rail/WorkspaceActivityRailSection.test.tsx, and their visibility rules by
 * workspace-activity-items.test.ts.
 */

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  openModal: vi.fn(),
  updateSettings: vi.fn(),
  agentBucketCounts: { attention: 0, working: 0, done: 0, idle: 0 },
  getAgentBucketCounts: vi.fn(),
  setSetupGuideSidebarDismissed: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('@/store/selectors', () => ({
  useRepoMap: () =>
    new Map(
      ((mocks.state.repos as Repo[] | undefined) ?? []).map((repo) => [repo.id, repo] as const)
    )
}))

vi.mock('@/components/dashboard/useAgentBucketCounts', () => ({
  useAgentBucketCounts: () => {
    mocks.getAgentBucketCounts()
    return mocks.agentBucketCounts
  }
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyComboDetails: () => [{ keys: ['⌘', 'J'], doubleTap: false }]
}))

vi.mock('../setup-guide/use-setup-guide-progress', () => ({
  useSetupGuideProgress: () => ({
    ready: true,
    coreDoneCount: 0,
    coreTotal: 1,
    stepDone: {}
  })
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu">{children}</div>
  ),
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
  ContextMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  )
}))

import SidebarNav, {
  getSetupGuideSidebarEntryReady,
  shouldShowAgentDashboardButton,
  shouldShowSetupGuideEntry
} from './SidebarNav'

function gitRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/repo-1',
    displayName: 'repo-1',
    badgeColor: 'gray',
    addedAt: 1,
    kind: 'git'
  }
}

function setSidebarState({
  settings = getDefaultSettings('/tmp'),
  repos = [gitRepo()]
}: {
  settings?: GlobalSettings
  repos?: Repo[]
} = {}): void {
  mocks.state = {
    settings,
    repos,
    activeView: 'worktrees',
    openModal: mocks.openModal,
    updateSettings: mocks.updateSettings,
    persistedUIReady: true,
    activeModal: null,
    setupGuideSidebarDismissed: true,
    setSetupGuideSidebarDismissed: mocks.setSetupGuideSidebarDismissed
  }
}

const mountedRoots: Root[] = []

async function renderSidebarNav(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <SidebarNav />
      </TooltipProvider>
    )
  })
  return container
}

function queryButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === text
    ) ?? null
  )
}

describe('SidebarNav', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await i18n.changeLanguage('en')
    mocks.agentBucketCounts = { attention: 0, working: 0, done: 0, idle: 0 }
    setSidebarState()
  })

  it('no longer renders the entries that moved to the activity rail', async () => {
    const container = await renderSidebarNav()

    // Guards the migration itself: leaving these here would be duplicate chrome for one action.
    for (const label of ['Tasks', 'Automations', 'Workspace', 'Orca Mobile', 'Agents']) {
      expect(queryButtonByText(container, label)).toBeNull()
    }
  })

  it('shows the Agent Dashboard entry only when its experiment is enabled', () => {
    expect(shouldShowAgentDashboardButton(null)).toBe(false)
    expect(shouldShowAgentDashboardButton({ experimentalAgentDashboardPopout: false })).toBe(false)
    expect(shouldShowAgentDashboardButton({ experimentalAgentDashboardPopout: true })).toBe(true)
  })

  it('keeps the Agent Dashboard row unmounted by default', async () => {
    const container = await renderSidebarNav()

    expect(queryButtonByText(container, 'Agent Dashboard')).toBeNull()
    expect(mocks.getAgentBucketCounts).not.toHaveBeenCalled()
  })

  it('mounts the Agent Dashboard row after opt-in', async () => {
    setSidebarState({
      settings: {
        ...getDefaultSettings('/tmp'),
        experimentalAgentDashboardPopout: true
      }
    })
    const container = await renderSidebarNav()

    await waitFor(() => expect(queryButtonByText(container, 'Agent Dashboard')).not.toBeNull())
    expect(mocks.getAgentBucketCounts).toHaveBeenCalledTimes(1)
  })

  it('uses a question glyph only for the Needs You count', async () => {
    mocks.agentBucketCounts = { attention: 2, working: 3, done: 1, idle: 4 }
    setSidebarState({
      settings: {
        ...getDefaultSettings('/tmp'),
        experimentalAgentDashboardPopout: true,
        experimentalAgentDashboardShowIdle: true
      }
    })
    const container = await renderSidebarNav()

    await waitFor(() =>
      expect(container.querySelector('[aria-label="Needs You: 2"]')).not.toBeNull()
    )
    const attention = container.querySelector('[aria-label="Needs You: 2"]')
    const working = container.querySelector('[aria-label="Working: 3"]')
    const done = container.querySelector('[aria-label="Done: 1"]')
    const idle = container.querySelector('[aria-label="Idle: 4"]')
    expect(attention?.querySelector('.lucide-message-circle-question-mark')).not.toBeNull()
    expect(working?.querySelector('.rounded-full')).not.toBeNull()
    expect(done?.querySelector('.rounded-full')).not.toBeNull()
    expect(idle?.querySelector('.rounded-full')).not.toBeNull()
    expect(working?.querySelector('svg')).toBeNull()
    expect(done?.querySelector('svg')).toBeNull()
    expect(idle?.querySelector('svg')).toBeNull()
  })

  it('hides the worktree palette shortcut until the search field is hovered or focused', async () => {
    const container = await renderSidebarNav()

    const searchButton = container.querySelector(
      'button[aria-label="Search worktrees and browser tabs"]'
    )
    expect(searchButton).not.toBeNull()

    const shortcuts = searchButton?.querySelector('span.hidden')
    expect(shortcuts?.className).toContain('hidden')
    expect(shortcuts?.className).toContain('group-hover:inline-flex')
    expect(shortcuts?.className).toContain('group-focus-within:inline-flex')
    expect(shortcuts?.textContent).toContain('⌘')
    expect(shortcuts?.textContent).toContain('J')
    expect(searchButton?.querySelector('kbd')).toBeNull()
  })

  it('shows the setup guide entry only after readiness, before completion, and before explicit hide', () => {
    expect(
      shouldShowSetupGuideEntry({ ready: false, setupComplete: false, dismissed: false })
    ).toBe(false)
    expect(shouldShowSetupGuideEntry({ ready: true, setupComplete: false, dismissed: false })).toBe(
      true
    )
    expect(shouldShowSetupGuideEntry({ ready: true, setupComplete: true, dismissed: false })).toBe(
      false
    )
    expect(shouldShowSetupGuideEntry({ ready: true, setupComplete: false, dismissed: true })).toBe(
      false
    )
  })

  it('requires both persisted UI and setup progress readiness before showing setup guide entry', () => {
    expect(getSetupGuideSidebarEntryReady(false, true)).toBe(false)
    expect(getSetupGuideSidebarEntryReady(true, false)).toBe(false)
    expect(getSetupGuideSidebarEntryReady(true, true)).toBe(true)
  })
})
