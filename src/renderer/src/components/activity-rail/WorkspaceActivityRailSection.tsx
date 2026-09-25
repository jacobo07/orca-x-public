import React from 'react'
import { EyeOff, Github, Gitlab } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { useVisibleTaskProviders } from '@/hooks/useVisibleTaskProviders'
import { useActivityUnreadCount } from '@/components/activity/useActivityUnreadCount'
import { useMobileSidebarOnboardingBadge } from '@/components/sidebar/mobile-sidebar-onboarding-badge'
import type { TaskProvider } from '../../../../shared/task-providers'
import {
  activeViewForWorkspaceActivity,
  getVisibleWorkspaceActivities,
  type WorkspaceActivityId
} from './workspace-activity-items'
import {
  ActivityRailItemWithHide,
  HIDE_SETTING_BY_ACTIVITY,
  WorkspaceActivityRailButton,
  type ActivityBadge
} from './workspace-activity-rail-button'

/**
 * The application-level section of the far-left activity rail.
 *
 * These entries select which part of Orca you are in. They sit above the contextual selectors
 * (Projects, and the panel's own tabs) because that is the scope order: application surface first,
 * then what fills it. They were previously full-width text rows inside the project sidebar, which
 * made a global mode switch look like a sidebar item.
 */

const TASK_PROVIDER_ICONS: Record<
  TaskProvider,
  React.ComponentType<{ className?: string; size?: number }>
> = {
  github: Github,
  gitlab: Gitlab,
  linear: LinearIcon,
  jira: JiraIcon
}

function taskProviderLabel(provider: TaskProvider): string {
  switch (provider) {
    case 'github':
      return translate('auto.components.sidebar.SidebarNav.0ccba862b8', 'Open GitHub tasks')
    case 'gitlab':
      return translate('auto.components.sidebar.SidebarNav.196c1b5362', 'Open GitLab tasks')
    case 'linear':
      return translate('auto.components.sidebar.SidebarNav.c39ab10000', 'Open Linear tasks')
    case 'jira':
      return translate('auto.components.sidebar.SidebarNav.e7ad3c540d', 'Open Jira tasks')
  }
}

/**
 * Tasks, plus the per-provider shortcuts the sidebar row revealed on hover.
 *
 * A 40px icon cannot carry four inline affordances, so they move to this item's context menu. That
 * is a gain rather than a compromise: hover reached them with a pointer only, while a context menu
 * is also reachable from the keyboard on a focused item.
 */
function TasksActivityRailButton({
  active,
  onSelect,
  onSelectProvider,
  onHide
}: {
  active: boolean
  onSelect: () => void
  onSelectProvider: (provider: TaskProvider) => void
  onHide: () => void
}): React.JSX.Element {
  const { canBrowseTasks, visibleTaskProviders, prefetchTasks } = useVisibleTaskProviders()
  // Why providers are gated but hide is not: with no git repo there is nothing to open, but the
  // row could always be hidden — the sidebar kept its hide menu reachable while left click was
  // inert, and that behaviour has a test.
  const showProviders = canBrowseTasks && visibleTaskProviders.length > 0

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-workspace-activity-tasks="">
          <WorkspaceActivityRailButton
            activity="tasks"
            active={active}
            onSelect={onSelect}
            disabled={!canBrowseTasks}
            onPrefetch={prefetchTasks}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {showProviders
          ? visibleTaskProviders.map((provider) => {
              const ProviderIcon = TASK_PROVIDER_ICONS[provider]
              return (
                <ContextMenuItem
                  key={provider}
                  data-task-provider={provider}
                  onSelect={() => onSelectProvider(provider)}
                >
                  <ProviderIcon className="size-3.5" />
                  <span>{taskProviderLabel(provider)}</span>
                </ContextMenuItem>
              )
            })
          : null}
        {showProviders ? <ContextMenuSeparator /> : null}
        <ContextMenuItem onSelect={onHide}>
          <EyeOff className="size-3.5" />
          {translate('auto.components.sidebar.SidebarNav.d599269755', 'Hide from sidebar')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** `omitAgentWorkspace`: the caller draws that entry itself (below Explorer in the panel strip). */
export function WorkspaceActivityRailSection({
  omitAgentWorkspace = false
}: {
  omitAgentWorkspace?: boolean
} = {}): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const activeView = useAppStore((s) => s.activeView)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openWorkspacePage = useAppStore((s) => s.openWorkspacePage)
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  const openActivityPage = useAppStore((s) => s.openActivityPage)
  const openArtifactsPage = useAppStore((s) => s.openArtifactsPage)
  const openSkillsPage = useAppStore((s) => s.openSkillsPage)
  const openMobilePage = useAppStore((s) => s.openMobilePage)
  const openConversationsPage = useAppStore((s) => s.openConversationsPage)

  const visible = React.useMemo(
    () =>
      getVisibleWorkspaceActivities(settings).filter(
        (activity) => !(omitAgentWorkspace && activity === 'agent-workspace')
      ),
    [settings, omitAgentWorkspace]
  )
  const showsActivity = visible.includes('activity')
  const showsMobile = visible.includes('mobile')
  const activityUnreadCount = useActivityUnreadCount(showsActivity, 'sidebar-badge')
  const mobileOnboardingBadge = useMobileSidebarOnboardingBadge(showsMobile)

  const badgeFor = React.useCallback(
    (activity: WorkspaceActivityId): ActivityBadge => {
      if (activity === 'activity' && activityUnreadCount > 0) {
        return { count: activityUnreadCount }
      }
      if (activity === 'mobile' && mobileOnboardingBadge.visible) {
        return { dot: true }
      }
      return null
    },
    [activityUnreadCount, mobileOnboardingBadge.visible]
  )

  const select = React.useCallback(
    (activity: WorkspaceActivityId): void => {
      switch (activity) {
        case 'agent-workspace':
          return openConversationsPage()
        case 'workspace':
          return openWorkspacePage()
        case 'tasks':
          return openTaskPage()
        case 'automations':
          return openAutomationsPage()
        case 'activity':
          return openActivityPage()
        case 'artifacts':
          return openArtifactsPage()
        case 'skills':
          return openSkillsPage()
        case 'mobile':
          // Opening the surface retires the "New" marker, exactly as the row did.
          mobileOnboardingBadge.dismiss()
          return openMobilePage()
        default: {
          // A rail entry that dispatches nothing is a dead control, and it looks identical to a
          // working one: it renders, it takes focus, and it does nothing. `conversations` shipped
          // exactly that way — visible, with no case here — and only a run that clicked it in the
          // real app noticed. This makes the next omission a compile error instead.
          const unhandled: never = activity
          return unhandled
        }
      }
    },
    [
      mobileOnboardingBadge,
      openActivityPage,
      openArtifactsPage,
      openAutomationsPage,
      openConversationsPage,
      openMobilePage,
      openSkillsPage,
      openTaskPage,
      openWorkspacePage
    ]
  )

  const hideActivity = React.useCallback(
    (activity: WorkspaceActivityId) => {
      const key = HIDE_SETTING_BY_ACTIVITY[activity]
      if (!key) {
        return
      }
      void updateSettings({ [key]: false })
    },
    [updateSettings]
  )

  if (visible.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col items-center" data-workspace-activity-rail="">
      {visible.map((activity) => {
        const active = activeView === activeViewForWorkspaceActivity(activity)
        // Tasks is the one activity with secondary actions, so it renders its own variant rather
        // than teaching the generic button about providers it will never have.
        return activity === 'tasks' ? (
          <TasksActivityRailButton
            key={activity}
            active={active}
            onSelect={() => openTaskPage()}
            onSelectProvider={(taskSource) => openTaskPage({ taskSource })}
            onHide={() => hideActivity('tasks')}
          />
        ) : (
          <ActivityRailItemWithHide
            key={activity}
            activity={activity}
            onHide={() => hideActivity(activity)}
          >
            <WorkspaceActivityRailButton
              activity={activity}
              active={active}
              onSelect={() => select(activity)}
              badge={badgeFor(activity)}
              badgeLabel={
                activity === 'mobile'
                  ? translate('auto.components.sidebar.SidebarNav.c86d83b5c3', 'New')
                  : String(activityUnreadCount)
              }
            />
          </ActivityRailItemWithHide>
        )
      })}
      {/* Scope seam: application surfaces above, contextual selectors below. */}
      <div className="my-1 h-px w-5 shrink-0 bg-border" aria-hidden="true" />
    </div>
  )
}
