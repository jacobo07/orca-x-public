import type { AppState } from '@/store/types'
import { isFolderRepo } from '../../../shared/repo-kind'

type ActiveView = AppState['activeView']

// Views that own the whole window regardless of project context: the launcher has no project to
// describe, and Settings/Space are global surfaces rather than places you work on a project from.
// Workspace draws its own context column; an Explorer beside it was the defect. The shell relocates
// the activity rail next to these views, so the route out survives the panel.
const RIGHT_SIDEBAR_SUPPRESSED_VIEWS = new Set<ActiveView>([
  'workspace',
  'settings',
  'space',
  'conversations'
])

// Application surfaces reached *from* a project-bound window. These used to sit in the set above,
// which unmounted the panel — and the panel is Explorer, Source Control and Agents, so opening
// Automations took the route back to your own work with it. The suppression was keyed on the view
// while the reason for it was "no project is open"; those are different predicates, and only the
// second one is true here. Keyed on project presence, the panel survives the trip and returns in
// the state it was left in, because it never unmounts.
const PROJECT_SCOPED_APPLICATION_VIEWS = new Set<ActiveView>([
  'tasks',
  'activity',
  'automations',
  'skills',
  'artifacts',
  'mobile'
])

/**
 * Whether this view is an application surface reached from inside a project.
 *
 * These borrow the content area from the workspace rather than replacing the window, so a panel tab
 * selected here is a request to go back to work — Explorer describes files you cannot act on while
 * Automations owns the surface in front of them.
 */
export function isProjectScopedApplicationView(activeView: ActiveView): boolean {
  return PROJECT_SCOPED_APPLICATION_VIEWS.has(activeView)
}

/**
 * Whether the side panel belongs on screen for this view.
 *
 * `hasActiveProject` is required rather than optional on purpose: it makes the compiler enumerate
 * every call site, so a caller that cannot answer the question has to say so instead of silently
 * inheriting the old view-only answer.
 *
 * Neither set is exhaustively typed, so a new view defaults to showing the panel — the safe side,
 * since the failure it causes is a panel where none was wanted rather than a user stranded.
 */
export function canShowRightSidebarForView(
  activeView: ActiveView,
  hasActiveProject: boolean
): boolean {
  if (RIGHT_SIDEBAR_SUPPRESSED_VIEWS.has(activeView)) {
    return false
  }
  // Why the workspace view is exempt from the project check: activeWorktreeId briefly goes null
  // through sleep/shutdown, and unmounting there would destroy the panel state on wake.
  if (PROJECT_SCOPED_APPLICATION_VIEWS.has(activeView)) {
    return hasActiveProject
  }
  return true
}

export function rightSidebarShowsPullRequestData(
  state: Pick<
    AppState,
    | 'activeView'
    | 'activeWorktreeId'
    | 'repos'
    | 'rightSidebarOpen'
    | 'rightSidebarTab'
    | 'worktreesByRepo'
  >
): boolean {
  if (
    !canShowRightSidebarForView(state.activeView, Boolean(state.activeWorktreeId)) ||
    !state.rightSidebarOpen ||
    (state.rightSidebarTab !== 'checks' && state.rightSidebarTab !== 'source-control')
  ) {
    return false
  }

  const activeWorktree = Object.values(state.worktreesByRepo)
    .flat()
    .find((worktree) => worktree.id === state.activeWorktreeId)
  const activeRepo = activeWorktree
    ? state.repos.find((repo) => repo.id === activeWorktree.repoId)
    : null
  if (!activeRepo || isFolderRepo(activeRepo)) {
    return false
  }

  return true
}
