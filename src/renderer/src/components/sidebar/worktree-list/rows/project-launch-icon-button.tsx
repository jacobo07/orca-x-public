import React from 'react'
import { Play } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { launchProjectInWorkspacePanel } from '@/lib/launch-project-in-workspace-panel'
import { PROJECT_LAUNCH_COMMAND } from '@/lib/project-launch-command'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

/**
 * Wraps a sidebar row's leading icon so hovering the row turns it into a run button.
 *
 * Why the icon slot rather than another action on the right: this is the row's most-used control
 * and it belongs at the edge the eye starts from, but a permanent extra column would shift every
 * project name across to make room for a button that is idle most of the time. Swapping in place
 * costs no layout.
 *
 * Rows with nothing to launch render the icon untouched, so a project that cannot run never grows
 * an affordance that would fail on click.
 */
export function ProjectLaunchIconSlot({
  launchPath,
  connectionId,
  label,
  className,
  children
}: {
  launchPath: string | null | undefined
  connectionId?: string | null
  label: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const canLaunch = Boolean(launchPath?.trim()) && !connectionId
  if (!canLaunch) {
    return <div className={className}>{children}</div>
  }
  const actionLabel = translate(
    'auto.components.sidebar.projectLaunchIconButton.label',
    'Run {{command}} in {{project}}',
    { command: PROJECT_LAUNCH_COMMAND, project: label }
  )
  return (
    <div className={cn('relative', className)}>
      {/* Hidden from pointers while the button is up so the swap cannot leave a dead hover zone. */}
      <span className="flex items-center justify-center transition-opacity group-hover:opacity-0">
        {children}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-repo-header-action=""
            aria-label={actionLabel}
            className="absolute inset-0 hidden items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:text-foreground group-hover:flex"
            onKeyDown={stopRepoHeaderKeyboardToggle}
            onPointerDown={handleRepoHeaderActionPointerDown}
            onClick={(event) => {
              // Why both: preventDefault drops the row's own button semantics, stopPropagation
              // keeps the click from reaching the collapse toggle underneath.
              event.preventDefault()
              event.stopPropagation()
              const outcome = launchProjectInWorkspacePanel({
                path: launchPath,
                connectionId
              })
              if (outcome === 'workspace-disabled') {
                toast.error(
                  translate(
                    'auto.components.sidebar.projectLaunchIconButton.workspaceDisabled',
                    'Turn the floating workspace on in Settings to run project commands.'
                  )
                )
                return
              }
              if (outcome === 'unsupported-project') {
                toast.error(
                  translate(
                    'auto.components.sidebar.projectLaunchIconButton.unsupported',
                    'This project has no local folder to run {{command}} in.',
                    { command: PROJECT_LAUNCH_COMMAND }
                  )
                )
              }
            }}
          >
            <Play className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {actionLabel}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
