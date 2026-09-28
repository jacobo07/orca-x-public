import type { TopLevelView } from '../../../shared/ui-chrome-types'

// Full-page surfaces that own the left region themselves. Workspace draws its own roster there; the
// worktree list beside it made the agent surface read as an Explorer with a panel pasted in.
const VIEWS_OWNING_LEFT_REGION = new Set<TopLevelView>([
  'settings',
  'activity',
  'space',
  'conversations'
])

/** Whether the worktree sidebar is mounted for this view. Unmounted, not hidden, where it is false. */
export function showsWorktreeSidebarForView(activeView: TopLevelView): boolean {
  return !VIEWS_OWNING_LEFT_REGION.has(activeView)
}
