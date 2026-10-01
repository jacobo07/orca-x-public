import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TopLevelView } from '../../../../shared/ui-chrome-types'
import { isWorkspaceView } from '@/lib/workspace-destinations'

/**
 * The view a page's Back returns to, or terminals when the recorded one is no longer offered.
 * Activity is the one view a setting can withdraw after it was recorded.
 */
export function resolvePageReturnTarget<V extends TopLevelView>(
  recorded: V,
  settings: Pick<GlobalSettings, 'experimentalActivity'> | null | undefined
): V | 'terminal' {
  return recorded === 'activity' && settings?.experimentalActivity !== true ? 'terminal' : recorded
}

/** Moves between Workspace destinations keep the outer target, so Back always leaves Workspace. */
export function workspaceReturnTarget(state: {
  activeView: TopLevelView
  previousViewBeforeConversations: Exclude<TopLevelView, 'conversations'>
}): Exclude<TopLevelView, 'conversations'> {
  return isWorkspaceView(state.activeView) || state.activeView === 'conversations'
    ? state.previousViewBeforeConversations
    : state.activeView
}
