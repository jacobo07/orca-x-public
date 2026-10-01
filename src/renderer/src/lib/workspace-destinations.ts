import type { TopLevelView } from '../../../shared/ui-chrome-types'

/**
 * Workspace's internal destinations (docs/reference/workspace-convergence.md §2.3–2.4).
 *
 * A destination is a view plus, for the conversation surface, which roster list it shows. Agents,
 * Threads and Projects are one page (one conversation stack) with three lists, so they share a view
 * and differ only by `WorkspaceRosterTab`.
 */
export type WorkspaceRosterTab = 'agents' | 'threads' | 'projects'

export type WorkspaceDestination =
  | 'resume'
  | 'agents'
  | 'threads'
  | 'projects'
  | 'backlog'
  | 'workstation'

/**
 * Resume first: Workspace opens on it (the home), then the destinations in reading order. An entry
 * is listed only once its page renders — a destination with no page is a dead control.
 */
export const WORKSPACE_DESTINATIONS: readonly WorkspaceDestination[] = [
  'resume',
  'agents',
  'threads',
  'projects',
  'backlog'
]

export const WORKSPACE_HOME: WorkspaceDestination = 'resume'

export const WORKSPACE_VIEWS: ReadonlySet<TopLevelView> = new Set<TopLevelView>([
  'resumeCenter',
  'conversations',
  'backlog',
  'workstation'
])

export function isWorkspaceView(view: TopLevelView): boolean {
  return WORKSPACE_VIEWS.has(view)
}

export function viewForWorkspaceDestination(destination: WorkspaceDestination): TopLevelView {
  switch (destination) {
    case 'resume':
      return 'resumeCenter'
    case 'agents':
    case 'threads':
    case 'projects':
      return 'conversations'
    case 'backlog':
      return 'backlog'
    case 'workstation':
      return 'workstation'
  }
}

export function rosterTabForWorkspaceDestination(
  destination: WorkspaceDestination
): WorkspaceRosterTab | null {
  return destination === 'agents' || destination === 'threads' || destination === 'projects'
    ? destination
    : null
}

/** The destination the user is on, or null outside Workspace. */
export function currentWorkspaceDestination(
  view: TopLevelView,
  rosterTab: WorkspaceRosterTab
): WorkspaceDestination | null {
  switch (view) {
    case 'resumeCenter':
      return 'resume'
    case 'conversations':
      return rosterTab
    case 'backlog':
      return 'backlog'
    case 'workstation':
      return 'workstation'
    default:
      return null
  }
}
