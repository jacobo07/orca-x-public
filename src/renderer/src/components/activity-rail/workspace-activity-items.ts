import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TopLevelView } from '../../../../shared/ui-chrome-types'

/**
 * Which application-level surfaces the activity rail offers, and in what order.
 *
 * These are product surfaces, not project content: they answer "which part of Orca am I in",
 * where the contextual sidebar answers "what is in it". Keeping the two apart is why they live in
 * their own section of the rail rather than becoming panel tabs — a panel tab selects what the
 * panel shows, which types differently (see right-sidebar/left-nav-projects-switch.tsx).
 *
 * Visibility gates are lifted verbatim from the sidebar rows this replaces, so moving a surface
 * into the rail cannot silently switch it on for anyone.
 */

export type WorkspaceActivityId =
  | 'workspace'
  | 'conversations'
  | 'tasks'
  | 'automations'
  | 'activity'
  | 'artifacts'
  | 'skills'
  | 'mobile'

/**
 * Ordered by how a session actually starts and proceeds: open a project, work the queue that
 * feeds it, then the scheduled work behind it. The opt-in surfaces follow, and the companion
 * device — reached once during setup, rarely after — is last. Deliberately not the historical
 * sidebar order, which grew by append.
 *
 * Conversations sit SECOND, next to the workspace they think about, and not first: "entry point
 * first" is a product decision this file's own test pins, and the reference information
 * architecture that leads with a chat entry is a navigation decision for that wave to make
 * deliberately, not something a new surface should take by arriving.
 */
export const WORKSPACE_ACTIVITY_ORDER: readonly WorkspaceActivityId[] = [
  'workspace',
  'conversations',
  'tasks',
  'automations',
  'activity',
  'artifacts',
  'skills',
  'mobile'
]

export type WorkspaceActivitySettings = Partial<
  Pick<
    GlobalSettings,
    | 'showWorkspaceButton'
    | 'showTasksButton'
    | 'showAutomationsButton'
    | 'showMobileButton'
    | 'showArtifactsButton'
    | 'showSkillsButton'
    | 'showConversationsButton'
    | 'experimentalActivity'
  >
> | null | undefined

const ACTIVE_VIEW_BY_ACTIVITY: Record<WorkspaceActivityId, TopLevelView> = {
  conversations: 'conversations',
  workspace: 'workspace',
  tasks: 'tasks',
  automations: 'automations',
  // Renamed from `agents` in W-C3. The view id was ALREADY 'activity': this rail entry was the only
  // thing still calling a paneKey-keyed feed of RUNNING panes by the name of the durable actor it
  // observes. That is why the rename needs no migration — the route identity never moved, and the
  // persisted `activeView: 'activity'` a profile may hold still resolves to the same page.
  activity: 'activity',
  artifacts: 'artifacts',
  skills: 'skills',
  mobile: 'mobile'
}

export function activeViewForWorkspaceActivity(activity: WorkspaceActivityId): TopLevelView {
  return ACTIVE_VIEW_BY_ACTIVITY[activity]
}

function isVisible(activity: WorkspaceActivityId, settings: WorkspaceActivitySettings): boolean {
  switch (activity) {
    // Default-on: only an explicit false hides them, so a profile that never set the key keeps them.
    case 'workspace':
      return settings?.showWorkspaceButton !== false
    case 'tasks':
      return settings?.showTasksButton !== false
    case 'automations':
      return settings?.showAutomationsButton !== false
    case 'mobile':
      return settings?.showMobileButton !== false
    // Opt-in: only an explicit true shows them.
    case 'artifacts':
      return settings?.showArtifactsButton === true
    case 'skills':
      return settings?.showSkillsButton === true
    case 'conversations':
      return settings?.showConversationsButton === true
    case 'activity':
      return settings?.experimentalActivity === true
  }
}

export function getVisibleWorkspaceActivities(
  settings: WorkspaceActivitySettings
): WorkspaceActivityId[] {
  return WORKSPACE_ACTIVITY_ORDER.filter((activity) => isVisible(activity, settings))
}
