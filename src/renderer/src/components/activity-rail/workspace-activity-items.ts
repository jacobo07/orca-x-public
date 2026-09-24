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
  | 'conversations'
  | 'agents'
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
 *
 * Agents sit THIRD, immediately after the chats. They are the two halves of one idea — a chat is
 * with nobody in particular, an agent is somebody you keep — and putting the durable half beside
 * the transient one is the only ordering claim W-C3 makes. Nothing else moved: the rest of the
 * rail is exactly where it was, because reordering the whole IA is a decision of its own and
 * arriving is not a licence to take it.
 */
export const WORKSPACE_ACTIVITY_ORDER: readonly WorkspaceActivityId[] = [
  // The agent Workspace leads (Owner, 2026-09-24). Where the side panel is open it is drawn directly
  // below Explorer instead, so this slot only applies where the panel's icons are not on screen.
  'agent-workspace',
  'workspace',
  'conversations',
  'agents',
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
        | 'showTasksButton'
        | 'showAutomationsButton'
        | 'showMobileButton'
        | 'showArtifactsButton'
        | 'showSkillsButton'
        | 'showConversationsButton'
        | 'showAgentsButton'
        | 'experimentalActivity'
      >
    >
  | null
  | undefined

const ACTIVE_VIEW_BY_ACTIVITY: Record<WorkspaceActivityId, TopLevelView> = {
  // The page the Chats entry opened: the entry was renamed and moved, the route id was not.
  'agent-workspace': 'conversations',
  conversations: 'conversations',
  agents: 'agents',
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
    // A NEW key, not `showConversationsButton`: that one defaulted to false and may be persisted as
    // false by profiles that never chose it, which would hide the canonical entry from them.
    case 'agent-workspace':
      return settings?.showAgentWorkspaceButton !== false
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
    // Its own key, not `experimentalActivity`. The two surfaces shared a noun until W-C3 and never
    // shared a meaning: one is a roster of durable actors, the other an inbox of running panes.
    // Reusing the flag would have made turning the feed off silently take the roster with it.
    case 'agents':
      return settings?.showAgentsButton === true
    case 'activity':
      return settings?.experimentalActivity === true
  }
}

export function getVisibleWorkspaceActivities(
  settings: WorkspaceActivitySettings
): WorkspaceActivityId[] {
  return WORKSPACE_ACTIVITY_ORDER.filter((activity) => isVisible(activity, settings))
}
