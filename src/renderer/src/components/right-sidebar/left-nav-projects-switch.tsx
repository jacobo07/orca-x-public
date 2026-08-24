import { FolderGit2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME } from './right-sidebar-titlebar-drag-regions'

/**
 * Switches the left region between project navigation and the file panel.
 *
 * Docked left, the Explorer panel and the project sidebar are two navigation surfaces stacked in
 * one spatial role, and the window ends up mostly navigation. This makes them alternatives: the
 * activity bar already switches between the panel's own views, so it is where switching away from
 * the panel entirely belongs too.
 *
 * Deliberately not an activity-bar tab. A tab selects what the panel shows; this selects whether
 * the panel is the left surface at all, which is a different question and types differently.
 *
 * Only meaningful docked left. Docked right the two sit on opposite edges serving distinct spatial
 * roles, so there is no duplication to resolve and this does not render.
 */

export function isProjectsTheLeftSurface(sidebarOpen: boolean, rightSidebarOpen: boolean): boolean {
  return sidebarOpen && !rightSidebarOpen
}

export function LeftNavProjectsSwitch(): React.JSX.Element {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)

  const active = isProjectsTheLeftSurface(sidebarOpen, rightSidebarOpen)
  const label = translate('components.right.sidebar.leftNavProjectsSwitch.projects', 'Projects')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-left-nav-switch="projects"
          aria-pressed={active}
          aria-label={label}
          className={cn(
            'relative flex h-10 w-10 shrink-0 items-center justify-center transition-colors',
            RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME,
            active ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground'
          )}
          onClick={() => {
            // Show projects: the sidebar has to be open and the panel has to give up the space.
            setSidebarOpen(true)
            if (rightSidebarOpen) {
              toggleRightSidebar()
            }
          }}
        >
          <FolderGit2 size={18} />
          {active ? (
            <div className="absolute top-[25%] right-0 bottom-[25%] w-[2px] rounded-l bg-foreground" />
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
