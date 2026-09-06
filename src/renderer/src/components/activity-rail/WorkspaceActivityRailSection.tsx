import React from 'react'
import { AppWindow, Bell, BookOpen, CalendarClock, Files, List, Smartphone } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
  tasks: List,
  automations: CalendarClock,
  agents: Bell,
  artifacts: Files,
  skills: BookOpen,
  mobile: Smartphone
}

function activityLabel(activity: WorkspaceActivityId): string {
  switch (activity) {
    case 'workspace':
      return translate('auto.components.sidebar.SidebarNav.workspace', 'Workspace')
    case 'tasks':
      return translate('auto.components.sidebar.SidebarNav.fee535205b', 'Tasks')
    case 'automations':
      return translate('auto.components.sidebar.SidebarNav.f323383e9a', 'Automations')
    case 'agents':
      return translate('auto.components.sidebar.SidebarNav.9c95e1ce91', 'Agents')
    case 'artifacts':
      return translate('auto.components.sidebar.SidebarNav.artifacts', 'Artifacts')
    case 'skills':
      return translate('auto.components.sidebar.SidebarNav.skills', 'Skills')
    case 'mobile':
      return translate('auto.components.sidebar.SidebarNav.1b5c41caee', 'Orca Mobile')
  }
}

function WorkspaceActivityRailButton({
  activity,
  active,
  onSelect
}: {
  activity: WorkspaceActivityId
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  const Icon = ACTIVITY_ICONS[activity]
  const label = activityLabel(activity)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // Why a data hook: the accessible name is translated, so selecting by it passes in one
          // locale and silently stops matching in every other.
          data-workspace-activity={activity}
          aria-current={active ? 'page' : undefined}
          aria-label={label}
          className={cn(
            'relative flex h-10 w-10 shrink-0 items-center justify-center transition-colors',
            RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME,
            active ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground'
          )}
          onClick={onSelect}
        >
          <Icon size={18} />
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

export function WorkspaceActivityRailSection(): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const activeView = useAppStore((s) => s.activeView)
  const openWorkspacePage = useAppStore((s) => s.openWorkspacePage)
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  const openActivityPage = useAppStore((s) => s.openActivityPage)
  const openArtifactsPage = useAppStore((s) => s.openArtifactsPage)
  const openSkillsPage = useAppStore((s) => s.openSkillsPage)
  const openMobilePage = useAppStore((s) => s.openMobilePage)

  const visible = React.useMemo(() => getVisibleWorkspaceActivities(settings), [settings])

  const select = React.useCallback(
    (activity: WorkspaceActivityId) => {
      switch (activity) {
        case 'workspace':
          return openWorkspacePage()
        case 'tasks':
          return openTaskPage()
        case 'automations':
          return openAutomationsPage()
        case 'agents':
          return openActivityPage()
        case 'artifacts':
          return openArtifactsPage()
        case 'skills':
          return openSkillsPage()
        case 'mobile':
          return openMobilePage()
      }
    },
    [
      openActivityPage,
      openArtifactsPage,
      openAutomationsPage,
      openMobilePage,
      openSkillsPage,
      openTaskPage,
      openWorkspacePage
    ]
  )

  if (visible.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col items-center" data-workspace-activity-rail="">
      {visible.map((activity) => (
        <WorkspaceActivityRailButton
          key={activity}
          activity={activity}
          active={activeView === activeViewForWorkspaceActivity(activity)}
          onSelect={() => select(activity)}
        />
      ))}
      {/* Scope seam: application surfaces above, contextual selectors below. */}
      <div className="my-1 h-px w-5 shrink-0 bg-border" aria-hidden="true" />
    </div>
  )
}
