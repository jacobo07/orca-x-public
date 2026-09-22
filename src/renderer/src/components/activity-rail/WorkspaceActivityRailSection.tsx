import React from 'react'
import {
  AppWindow,
  Bell,
  BookOpen,
  CalendarClock,
  EyeOff,
  Files,
  Github,
  Gitlab,
  List,
  MessageSquare,
  Smartphone
} from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME } from '@/components/right-sidebar/right-sidebar-titlebar-drag-regions'
import {
  activeViewForWorkspaceActivity,
  getVisibleWorkspaceActivities,
  type WorkspaceActivityId
} from './workspace-activity-items'

/**
 * The application-level section of the far-left activity rail.
 *
 * These entries select which part of Orca you are in. They sit above the contextual selectors
 * (Projects, and the panel's own tabs) because that is the scope order: application surface first,
 * then what fills it. They were previously full-width text rows inside the project sidebar, which
 * made a global mode switch look like a sidebar item.
 *
 * Icons and translate keys are reused from those rows verbatim, so no locale key moves and no
 * surface silently changes name.
 */

const ACTIVITY_ICONS: Record<
  WorkspaceActivityId,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  workspace: AppWindow,
  conversations: MessageSquare,
  tasks: List,
  automations: CalendarClock,
  activity: Bell,
  artifacts: Files,
  skills: BookOpen,
  mobile: Smartphone
}

function activityLabel(activity: WorkspaceActivityId): string {
  switch (activity) {
    case 'conversations':
      return translate('conversations.railLabel', 'Chats')
    case 'workspace':
      return translate('auto.components.sidebar.SidebarNav.workspace', 'Workspace')
    case 'tasks':
      return translate('auto.components.sidebar.SidebarNav.fee535205b', 'Tasks')
    case 'automations':
      return translate('auto.components.sidebar.SidebarNav.f323383e9a', 'Automations')
    // A new key, not the old `...9c95e1ce91`. That key's catalogue entries are the NOUN — "Agentes",
    // "에이전트", "智能体" — and the noun belongs to the durable actor, not to a feed of running panes.
    // It travels to the persistent Agents entry in W-C3C; this surface gets a name of its own.
    case 'activity':
      return translate('activity.railLabel', 'Activity')
    case 'artifacts':
      return translate('auto.components.sidebar.SidebarNav.artifacts', 'Artifacts')
    case 'skills':
      return translate('auto.components.sidebar.SidebarNav.skills', 'Skills')
    case 'mobile':
      return translate('auto.components.sidebar.SidebarNav.1b5c41caee', 'Orca Mobile')
  }
}

/**
 * The rows carried two informational badges — an unread count on Agents and a "New" marker on
 * Orca Mobile. A rail entry has no room for a word, so the count keeps its number and the marker
 * becomes a dot; both stay in the accessible name so the information is not pointer-only.
 */
type ActivityBadge = { count: number } | { dot: true } | null

function WorkspaceActivityRailButton({
  activity,
  active,
  onSelect,
  disabled = false,
  onPrefetch,
  badge = null,
  badgeLabel
}: {
  activity: WorkspaceActivityId
  active: boolean
  onSelect: () => void
  disabled?: boolean
  onPrefetch?: () => void
  badge?: ActivityBadge
  /** Appended to the accessible name so a badge is not conveyed by colour and position alone. */
  badgeLabel?: string
}): React.JSX.Element {
  const Icon = ACTIVITY_ICONS[activity]
  const baseLabel = activityLabel(activity)
  const label = badge && badgeLabel ? `${baseLabel} — ${badgeLabel}` : baseLabel

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // Why a data hook: the accessible name is translated, so selecting by it passes in one
          // locale and silently stops matching in every other.
          data-workspace-activity={activity}
          aria-current={active ? 'page' : undefined}
          aria-disabled={disabled || undefined}
          aria-label={label}
          className={cn(
            'relative flex h-10 w-10 shrink-0 items-center justify-center transition-colors',
            RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME,
            active ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground',
            disabled && 'cursor-not-allowed opacity-50 hover:text-muted-foreground/60'
          )}
          onPointerEnter={onPrefetch}
          onFocus={onPrefetch}
          onClick={() => {
            if (disabled) {
              return
            }
            onSelect()
          }}
        >
          <Icon size={18} />
          {badge && 'count' in badge ? (
            <span
              aria-hidden="true"
              className="absolute top-1 right-0.5 min-w-[14px] rounded-full bg-primary px-1 text-[9px] leading-[14px] font-semibold text-primary-foreground"
            >
              {badge.count}
            </span>
          ) : null}
          {badge && 'dot' in badge ? (
            <span
              aria-hidden="true"
              className="absolute top-[7px] right-[7px] size-[7px] rounded-full bg-primary ring-1 ring-sidebar"
            />
          ) : null}
          {active ? (
            <div className="absolute top-[25%] right-0 bottom-[25%] w-[2px] rounded-l bg-foreground" />
          ) : null}
        </button>
      </TooltipTrigger>
      {/* Docked against the window's left edge, so the tooltip opens inward. */}
      <TooltipContent side="right" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

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

/**
 * The settings flag each activity's "Hide from sidebar" writes, or null where hiding is not
 * offered. Carried over so the rows' right-click hide survives their removal — an activity you
 * cannot hide is a capability lost, not a simplification.
 */
const HIDE_SETTING_BY_ACTIVITY: Record<WorkspaceActivityId, keyof GlobalSettings | null> = {
  workspace: 'showWorkspaceButton',
  // Hideable like the other opt-in surfaces: something you turned on, you can turn off from the
  // rail itself rather than having to find the setting again.
  conversations: 'showConversationsButton',
  tasks: 'showTasksButton',
  automations: 'showAutomationsButton',
  mobile: 'showMobileButton',
  artifacts: 'showArtifactsButton',
  skills: 'showSkillsButton',
  // Activity is an experiment toggle rather than a sidebar preference; it never offered hiding.
  activity: null
}

function HideActivityMenu({ onHide }: { onHide: () => void }): React.JSX.Element {
  return (
    <ContextMenuContent>
      <ContextMenuItem onSelect={onHide}>
        <EyeOff className="size-3.5" />
        {translate('auto.components.sidebar.SidebarNav.d599269755', 'Hide from sidebar')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Wraps an activity in its hide menu, or renders it plainly when hiding is not offered. */
function ActivityRailItemWithHide({
  activity,
  onHide,
  children
}: {
  activity: WorkspaceActivityId
  onHide: () => void
  children: React.ReactNode
}): React.JSX.Element {
  if (HIDE_SETTING_BY_ACTIVITY[activity] === null) {
    return <>{children}</>
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>{children}</div>
      </ContextMenuTrigger>
      <HideActivityMenu onHide={onHide} />
    </ContextMenu>
  )
}

export function WorkspaceActivityRailSection(): React.JSX.Element | null {
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

  const visible = React.useMemo(() => getVisibleWorkspaceActivities(settings), [settings])
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
        case 'workspace':
          return openWorkspacePage()
        case 'conversations':
          return openConversationsPage()
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
