import React from 'react'
import { Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { launchProjectInWorkspacePanel } from '@/lib/launch-project-in-workspace-panel'
import { PROJECT_LAUNCH_COMMAND } from '@/lib/project-launch-command'
import type { Repo } from '../../../../../../shared/repo-types'
import { REPO_HEADER_ACTION_BUTTON_CLASS } from '../../repo-header-action-button-class'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

/**
 * Runs the project's launch command in a terminal rooted at that project, from the sidebar row.
 *
 * Hidden rather than disabled for remote projects: the action is not merely unavailable there, it
 * is meaningless, and a permanently greyed control invites clicking to find out why.
 */
export function RepoHeaderLaunchButton({
  repo,
  label
}: {
  repo: Repo
  label: string
}): React.JSX.Element | null {
  if (repo.connectionId) {
    return null
  }
  const actionLabel = translate(
    'auto.components.sidebar.repoHeaderLaunchButton.label',
    'Run {{command}} in {{project}}',
    { command: PROJECT_LAUNCH_COMMAND, project: label }
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={REPO_HEADER_ACTION_BUTTON_CLASS}
          data-repo-header-action=""
          aria-label={actionLabel}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onPointerDown={handleRepoHeaderActionPointerDown}
          onClick={(event) => {
            // Why both: preventDefault stops the row's button semantics, stopPropagation keeps the
            // click from reaching the header's collapse toggle underneath.
            event.preventDefault()
            event.stopPropagation()
            const outcome = launchProjectInWorkspacePanel(repo)
            if (outcome === 'workspace-disabled') {
              toast.error(
                translate(
                  'auto.components.sidebar.repoHeaderLaunchButton.workspaceDisabled',
                  'Turn the floating workspace on in Settings to run project commands.'
                )
              )
              return
            }
            if (outcome === 'unsupported-project') {
              toast.error(
                translate(
                  'auto.components.sidebar.repoHeaderLaunchButton.unsupported',
                  'This project has no local folder to run {{command}} in.',
                  { command: PROJECT_LAUNCH_COMMAND }
                )
              )
            }
          }}
        >
          <Play className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {actionLabel}
      </TooltipContent>
    </Tooltip>
  )
}
