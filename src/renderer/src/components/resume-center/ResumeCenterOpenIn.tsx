import { ExternalLink } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { openOpenInAppsSettings, WorktreeOpenInMenuItems } from '../sidebar/WorktreeOpenInMenu'
import type { DeskWorkspaceIdentity } from '../../../../shared/desk-continuity-projection'
import { resumeCenterOpenInTarget } from './resume-center-open-in'

/** The sidebar's "Open in" for the selected workspace: Workspace views never mount the sidebar. */
export function ResumeCenterOpenIn({
  row,
  name
}: {
  row: { hostId: string; identity: DeskWorkspaceIdentity } | null
  name: string
}): React.JSX.Element {
  const target = row ? resumeCenterOpenInTarget(row) : null
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={!target}>
        <Button
          variant="outline"
          data-testid="resume-center-open-in"
          className="h-auto max-w-64 items-start gap-2.5 px-4 py-2 text-left"
        >
          <ExternalLink className="mt-0.5 size-4" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="text-[13px] font-medium">
              {translate('resumeCenter.openIn.title', 'Open in')}
            </span>
            <span className="truncate text-[11px] font-normal text-muted-foreground">
              {!row
                ? translate('resumeCenter.restoreLayout.none', 'Select a workspace')
                : target
                  ? translate('resumeCenter.openIn.hint', '{{name}}, in another app', { name })
                  : translate(
                      'resumeCenter.openIn.unavailable',
                      'Not available for this workspace'
                    )}
            </span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      {target ? (
        <DropdownMenuContent align="end" className="w-52" data-testid="resume-center-open-in-menu">
          <WorktreeOpenInMenuItems
            worktreePath={target.worktreePath}
            connectionId={target.connectionId}
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openOpenInAppsSettings}>
            {translate(
              'auto.components.sidebar.WorktreeOpenInMenu.1417fd8380',
              'Customize apps...'
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  )
}
