import { describe, expect, it } from 'vitest'
import type { TopLevelView } from '../../../shared/ui-chrome-types'
import { showsWorktreeSidebarForView } from './worktree-sidebar-visibility'

describe('worktree sidebar ownership of the left region', () => {
  it('yields the left region to Workspace, which draws its own roster there', () => {
    expect(showsWorktreeSidebarForView('conversations')).toBe(false)
  })

  it('keeps yielding it to the other full-page surfaces', () => {
    for (const view of ['settings', 'activity', 'space'] as const) {
      expect(showsWorktreeSidebarForView(view)).toBe(false)
    }
  })

  // The views that work on a project keep the list that navigates between its worktrees.
  it('keeps the worktree sidebar where work happens', () => {
    for (const view of ['terminal', 'tasks', 'automations', 'workspace'] as TopLevelView[]) {
      expect(showsWorktreeSidebarForView(view)).toBe(true)
    }
  })
})
