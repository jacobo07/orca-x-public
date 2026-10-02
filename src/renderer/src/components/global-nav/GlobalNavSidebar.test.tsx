// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  canBrowseTasks: true,
  closeConversationsPage: vi.fn(),
  setActiveView: vi.fn(),
  openWorkspaceHome: vi.fn(),
  openWorkspaceDestination: vi.fn(),
  openTaskPage: vi.fn(),
  openActivityPage: vi.fn(),
  openSettingsPage: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('@/hooks/useVisibleTaskProviders', () => ({
  useVisibleTaskProviders: () => ({ canBrowseTasks: mocks.canBrowseTasks })
}))

// The regular destinations have their own suite; here only their presence matters.
vi.mock('@/components/activity-rail/WorkspaceActivityRailSection', () => ({
  WorkspaceActivityRailSection: () => <div data-workspace-activity-rail="" />
}))

import { GlobalNavSidebar } from './GlobalNavSidebar'

let container: HTMLDivElement
let root: Root

function render(activeView: string, settings: Record<string, unknown> = {}): void {
  mocks.state = {
    activeView,
    settings,
    globalNavCollapsed: false,
    toggleGlobalNavCollapsed: vi.fn(),
    isFullScreen: false,
    updateSettings: vi.fn(),
    orcaProfileAuthStatus: null,
    setActiveView: mocks.setActiveView,
    openSettingsPage: mocks.openSettingsPage,
    closeConversationsPage: mocks.closeConversationsPage,
    openWorkspaceHome: mocks.openWorkspaceHome,
    openWorkspaceDestination: mocks.openWorkspaceDestination,
    openTaskPage: mocks.openTaskPage,
    openActivityPage: mocks.openActivityPage
  }
  act(() => root.render(<GlobalNavSidebar />))
}

function nav(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-global-nav]')!
}

function item(id: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-global-nav-item="${id}"]`)
}

function items(): string[] {
  return [...container.querySelectorAll('[data-global-nav-item]')].map(
    (node) => node.getAttribute('data-global-nav-item') ?? ''
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.canBrowseTasks = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('GlobalNavSidebar on Resume Center', () => {
  it('shows the Resume Center destinations, in the reference order, with Cognitive Workspace current', () => {
    render('resumeCenter')

    expect(nav().getAttribute('data-global-nav-variant')).toBe('resume-center')
    expect(items()).toEqual([
      'home',
      'cognitive-workspace',
      'projects',
      'agents',
      'tasks',
      'knowledge',
      'runtime',
      'audit',
      'settings'
    ])
    expect(container.querySelector('[data-workspace-activity-rail]')).toBeNull()
    expect(container.querySelectorAll('[data-global-nav-item][aria-current="page"]')).toHaveLength(
      1
    )
    expect(item('cognitive-workspace')?.getAttribute('aria-current')).toBe('page')
  })

  it('Back leaves Workspace for the view it was entered from', () => {
    render('resumeCenter')
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-global-nav-control="back"]')?.click()
    )
    expect(mocks.closeConversationsPage).toHaveBeenCalledTimes(1)
  })

  it('each live entry opens its page', () => {
    render('resumeCenter', { experimentalActivity: true })

    act(() => item('home')?.click())
    expect(mocks.setActiveView).toHaveBeenCalledWith('terminal')
    act(() => item('cognitive-workspace')?.click())
    expect(mocks.openWorkspaceHome).toHaveBeenCalledTimes(1)
    act(() => item('projects')?.click())
    expect(mocks.openWorkspaceDestination).toHaveBeenCalledWith('projects')
    act(() => item('agents')?.click())
    expect(mocks.openWorkspaceDestination).toHaveBeenCalledWith('agents')
    act(() => item('tasks')?.click())
    expect(mocks.openTaskPage).toHaveBeenCalledTimes(1)
    act(() => item('runtime')?.click())
    expect(mocks.openActivityPage).toHaveBeenCalledTimes(1)
    act(() => item('settings')?.click())
    expect(mocks.openSettingsPage).toHaveBeenCalledTimes(1)
  })

  it('Knowledge and Audit say they are not available yet and do nothing', () => {
    render('resumeCenter')
    for (const id of ['knowledge', 'audit']) {
      const entry = item(id)
      expect(entry?.getAttribute('aria-disabled'), id).toBe('true')
      expect(entry?.getAttribute('aria-label'), id).toContain('Not available yet')
      expect(entry?.textContent, id).toContain('Not available yet')
    }
  })

  it('keeps the gating its targets have elsewhere: Tasks needs a provider, Runtime its flag', () => {
    mocks.canBrowseTasks = false
    render('resumeCenter')
    act(() => item('tasks')?.click())
    act(() => item('runtime')?.click())
    expect(item('tasks')?.getAttribute('aria-disabled')).toBe('true')
    expect(item('runtime')?.getAttribute('aria-disabled')).toBe('true')
    expect(item('runtime')?.getAttribute('aria-label')).toContain('Experimental')
    expect(mocks.openTaskPage).not.toHaveBeenCalled()
    expect(mocks.openActivityPage).not.toHaveBeenCalled()
  })
})

describe('GlobalNavSidebar everywhere else', () => {
  it.each(['terminal', 'conversations', 'backlog', 'tasks', 'settings'])(
    'on %s keeps the regular destinations and no Back',
    (view) => {
      render(view)
      expect(nav().getAttribute('data-global-nav-variant')).toBe('global')
      expect(container.querySelector('[data-workspace-activity-rail]')).not.toBeNull()
      expect(container.querySelector('[data-global-nav-control="back"]')).toBeNull()
      expect(item('cognitive-workspace')).toBeNull()
    }
  )
})
