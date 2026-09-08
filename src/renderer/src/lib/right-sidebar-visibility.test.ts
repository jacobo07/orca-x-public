import { describe, expect, it } from 'vitest'
import {
  canShowRightSidebarForView,
  isProjectScopedApplicationView,
  rightSidebarShowsPullRequestData
} from './right-sidebar-visibility'
import type { AppState } from '@/store/types'

function makeState(
  overrides: Partial<Parameters<typeof rightSidebarShowsPullRequestData>[0]> = {}
): Parameters<typeof rightSidebarShowsPullRequestData>[0] {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000000',
        addedAt: 1,
        kind: 'git'
      }
    ],
    rightSidebarOpen: true,
    rightSidebarTab: 'checks',
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    ...overrides
  } as Parameters<typeof rightSidebarShowsPullRequestData>[0]
}

const PROJECT_SCOPED_APP_VIEWS = [
  'tasks',
  'activity',
  'automations',
  'skills',
  'artifacts',
  'mobile'
] as const

describe('right sidebar visibility helpers', () => {
  it('suppresses right sidebar controls on projectless full-page views', () => {
    for (const view of ['workspace', 'settings', 'space']) {
      expect(canShowRightSidebarForView(view as AppState['activeView'], true)).toBe(false)
    }
  })

  // The panel is Explorer, Source Control and Agents. An application surface opened from a
  // project-bound window must not take the route back to them with it.
  it('keeps the panel reachable on application surfaces while a project is open', () => {
    for (const view of PROJECT_SCOPED_APP_VIEWS) {
      expect(canShowRightSidebarForView(view as AppState['activeView'], true)).toBe(true)
    }
  })

  it('still suppresses application surfaces reached with no project open', () => {
    for (const view of PROJECT_SCOPED_APP_VIEWS) {
      expect(canShowRightSidebarForView(view as AppState['activeView'], false)).toBe(false)
    }
  })

  // Selecting a panel tab from one of these is a request to go back to work, so the content area
  // returns to the workspace rather than leaving a file tree beside a page you cannot act from.
  it('names the application surfaces a panel tab should return from', () => {
    for (const view of PROJECT_SCOPED_APP_VIEWS) {
      expect(isProjectScopedApplicationView(view as AppState['activeView'])).toBe(true)
    }
  })

  it('does not treat the workspace or full-page globals as returnable surfaces', () => {
    for (const view of ['terminal', 'workspace', 'settings', 'space']) {
      expect(isProjectScopedApplicationView(view as AppState['activeView'])).toBe(false)
    }
  })

  it('allows right sidebar controls on workspace views', () => {
    expect(canShowRightSidebarForView('terminal', true)).toBe(true)
  })

  // Why both project states: activeWorktreeId briefly goes null through wake, and unmounting the
  // panel there would destroy exactly the state this change exists to preserve.
  it('keeps the workspace view panel mounted while the active project is momentarily absent', () => {
    expect(canShowRightSidebarForView('terminal', false)).toBe(true)
  })

  it('does not treat hidden full-page sidebars as visible PR panels', () => {
    expect(rightSidebarShowsPullRequestData(makeState({ activeView: 'settings' }))).toBe(false)
  })

  // Why this flipped: on an application surface the panel is now mounted beside the surface, so an
  // open checks tab really is on screen and stale PR data there would be a visible lie.
  it('treats an open panel on a project-bound application surface as visible PR data', () => {
    expect(rightSidebarShowsPullRequestData(makeState({ activeView: 'tasks' }))).toBe(true)
  })

  it('does not poll PR data for an application surface reached with no project open', () => {
    expect(
      rightSidebarShowsPullRequestData(makeState({ activeView: 'tasks', activeWorktreeId: null }))
    ).toBe(false)
  })

  it('does not treat hidden folder-repo fallbacks as visible PR panels', () => {
    expect(
      rightSidebarShowsPullRequestData(
        makeState({
          repos: [
            {
              id: 'repo-1',
              path: '/repo',
              displayName: 'Repo',
              badgeColor: '#000000',
              addedAt: 1,
              kind: 'folder'
            }
          ]
        })
      )
    ).toBe(false)
  })

  it('detects visible PR panels in workspace views', () => {
    expect(
      rightSidebarShowsPullRequestData(
        makeState({
          rightSidebarTab: 'source-control'
        })
      )
    ).toBe(true)
  })
})
