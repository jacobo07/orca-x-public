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
  | 'agent-workspace'
  | 'workspace'
  | 'backlog'
  | 'tasks'
  | 'automations'
  | 'activity'
  | 'artifacts'
  | 'skills'
  | 'mobile'

/**
 * Workspace — agents, their threads and projects — leads (Owner, 2026-09-24): it absorbed the
 * opt-in Chats and Agents entries, which are gone. Where the side panel is open it is drawn
 * directly below Explorer instead, so its slot here applies only where the panel's icons are not
 * on screen.
 *
 * Then as before: open a project into terminals, the Backlog of unfinished intent that sits above
 * Tasks, work the queue that feeds it, the scheduled work behind it, the opt-in surfaces, and the
 * companion device — reached once during setup — last.
 */
export const WORKSPACE_ACTIVITY_ORDER: readonly WorkspaceActivityId[] = [
  'agent-workspace',
  'workspace',
  'backlog',
  'tasks',
  'automations',
  'activity',
  'artifacts',
  'skills',
  'mobile'
]

export type WorkspaceActivitySettings =
  | Partial<
      Pick<
        GlobalSettings,
        | 'showAgentWorkspaceButton'
        | 'showWorkspaceButton'
        | 'showBacklogButton'
        | 'showTasksButton'
        | 'showAutomationsButton'
        | 'showMobileButton'
        | 'showArtifactsButton'
        | 'showSkillsButton'
        | 'experimentalActivity'
      >
    >
  | null
  | undefined

const ACTIVE_VIEW_BY_ACTIVITY: Record<WorkspaceActivityId, TopLevelView> = {
  // The page the Chats entry opened: the entry was renamed and moved, the route id was not.
  'agent-workspace': 'conversations',
  workspace: 'workspace',
  backlog: 'backlog',
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
    // A NEW key, not `showConversationsButton`: that one defaulted to false and may be persisted as
    // false by profiles that never chose it, which would hide the canonical entry from them.
    case 'agent-workspace':
      return settings?.showAgentWorkspaceButton !== false
    case 'workspace':
      return settings?.showWorkspaceButton !== false
    case 'backlog':
      return settings?.showBacklogButton !== false
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
    case 'activity':
      return settings?.experimentalActivity === true
  }
}

export function getVisibleWorkspaceActivities(
  settings: WorkspaceActivitySettings
): WorkspaceActivityId[] {
  return WORKSPACE_ACTIVITY_ORDER.filter((activity) => isVisible(activity, settings))
}
