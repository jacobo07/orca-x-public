import type { TopLevelView } from '../../../shared/ui-chrome-types'
import { isWorkspaceView } from './workspace-destinations'

// Full-page surfaces that own the left region themselves. Every Workspace destination draws its own
// columns inside WorkspaceFrame; the worktree list beside them made Workspace read as an Explorer
// with a panel pasted in. Global navigation is GlobalNavSidebar, not this list.
const VIEWS_OWNING_LEFT_REGION = new Set<TopLevelView>(['settings', 'activity', 'space'])

/** Whether the worktree sidebar is mounted for this view. Unmounted, not hidden, where it is false. */
export function showsWorktreeSidebarForView(activeView: TopLevelView): boolean {
  return !VIEWS_OWNING_LEFT_REGION.has(activeView) && !isWorkspaceView(activeView)
}
