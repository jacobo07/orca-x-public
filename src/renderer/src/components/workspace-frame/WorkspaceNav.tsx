import {
  ClipboardList,
  FolderGit2,
  History,
  MessagesSquare,
  Server,
  UsersRound,
  type LucideIcon
} from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import {
  currentWorkspaceDestination,
  WORKSPACE_DESTINATIONS,
  type WorkspaceDestination
} from '@/lib/workspace-destinations'

const ICONS: Record<WorkspaceDestination, LucideIcon> = {
  resume: History,
  agents: UsersRound,
  threads: MessagesSquare,
  projects: FolderGit2,
  backlog: ClipboardList,
  workstation: Server
}

export function workspaceDestinationLabel(destination: WorkspaceDestination): string {
  switch (destination) {
    case 'resume':
      return translate('resumeCenter.title', 'Resume Center')
    case 'agents':
      return translate('workspace.tab.agents', 'Agents')
    case 'threads':
      return translate('workspace.tab.threads', 'Threads')
    case 'projects':
      return translate('workspace.tab.projects', 'Projects')
    case 'backlog':
      return translate('backlog.rail.label', 'Backlog')
    case 'workstation':
      return translate('workspaceNav.workstation', 'Workstation')
  }
}

/**
 * Workspace's own navigation — subordinate to GlobalNavSidebar, never a copy of it. `list` sits at
 * the top of the right column; `strip` is the same entries across the header when the frame is
 * too narrow for a column, so the destinations never disappear.
 */
export function WorkspaceNav({ variant }: { variant: 'list' | 'strip' }): React.JSX.Element {
  const activeView = useAppStore((s) => s.activeView)
  const rosterTab = useAppStore((s) => s.workspaceRosterTab)
  const openDestination = useAppStore((s) => s.openWorkspaceDestination)
  const current = currentWorkspaceDestination(activeView, rosterTab)

  return (
    <nav
      aria-label={translate('workspaceNav.label', 'Workspace')}
      data-workspace-nav={variant}
      className={cn(
        variant === 'list' ? 'flex flex-col gap-0.5' : 'flex min-w-0 items-center gap-0.5 overflow-x-auto'
      )}
    >
      {WORKSPACE_DESTINATIONS.map((destination) => {
        const Icon = ICONS[destination]
        const active = destination === current
        const label = workspaceDestinationLabel(destination)
        return (
          <button
            key={destination}
            type="button"
            data-workspace-nav-item={destination}
            aria-current={active ? 'page' : undefined}
            onClick={() => openDestination(destination)}
            className={cn(
              'flex shrink-0 items-center gap-2.5 rounded-md text-[13px] transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              variant === 'list' ? 'h-8 w-full px-2.5' : 'h-7 px-2',
              active
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
