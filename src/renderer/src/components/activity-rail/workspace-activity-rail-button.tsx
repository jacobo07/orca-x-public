import React from 'react'
import {
  AppWindow,
  Bell,
  BookOpen,
  CalendarClock,
  ClipboardList,
  EyeOff,
  Files,
  List,
  Smartphone,
  SquareTerminal
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME } from '@/components/right-sidebar/right-sidebar-titlebar-drag-regions'
import type { WorkspaceActivityId } from './workspace-activity-items'

/**
 * One rail entry — icon, name, badge and hide menu — shared by the rail section and the Workspace
 * entry drawn below Explorer, so the two cannot drift apart.
 *
 * Icons and translate keys are reused from the sidebar rows verbatim, so no locale key moves and no
 * surface silently changes name.
 */

const ACTIVITY_ICONS: Record<
  WorkspaceActivityId,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  'agent-workspace': AppWindow,
  // The launcher opens projects into terminals; it gave its window icon and its name to the agent
  // Workspace (Owner, 2026-09-24).
  workspace: SquareTerminal,
  backlog: ClipboardList,
  tasks: List,
  automations: CalendarClock,
  activity: Bell,
  artifacts: Files,
  skills: BookOpen,
  mobile: Smartphone
}

function activityLabel(activity: WorkspaceActivityId): string {
  switch (activity) {
    // The "Workspace" key and its translations now name the agent surface; the launcher it named
    // opens projects into terminals and is called that.
    case 'agent-workspace':
      return translate('auto.components.sidebar.SidebarNav.workspace', 'Workspace')
    case 'workspace':
      return translate('activityRail.terminals', 'Terminals')
    case 'backlog':
      return translate('backlog.rail.label', 'Backlog')
    case 'tasks':
      return translate('auto.components.sidebar.SidebarNav.fee535205b', 'Tasks')
    case 'automations':
      return translate('auto.components.sidebar.SidebarNav.f323383e9a', 'Automations')
    // A new key, not the old `...9c95e1ce91`. That key's catalogue entries are the NOUN — "Agentes",
    // "에이전트", "智能体" — and the noun belongs to the durable actor, not to a feed of running panes.
    // Durable agents now live in Workspace's roster; this surface keeps a name of its own.
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
export type ActivityBadge = { count: number } | { dot: true } | null

export function WorkspaceActivityRailButton({
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

/**
 * The settings flag each activity's "Hide from sidebar" writes, or null where hiding is not
 * offered. Carried over so the rows' right-click hide survives their removal — an activity you
 * cannot hide is a capability lost, not a simplification.
 */
export const HIDE_SETTING_BY_ACTIVITY: Record<WorkspaceActivityId, keyof GlobalSettings | null> = {
  'agent-workspace': 'showAgentWorkspaceButton',
  workspace: 'showWorkspaceButton',
  backlog: 'showBacklogButton',
  tasks: 'showTasksButton',
  automations: 'showAutomationsButton',
  mobile: 'showMobileButton',
  artifacts: 'showArtifactsButton',
  skills: 'showSkillsButton',
  // Activity is an experiment toggle rather than a sidebar preference; it never offered hiding.
  activity: null
}

export function HideActivityMenu({ onHide }: { onHide: () => void }): React.JSX.Element {
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
export function ActivityRailItemWithHide({
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
