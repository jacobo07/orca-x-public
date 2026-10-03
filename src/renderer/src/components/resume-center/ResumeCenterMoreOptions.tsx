import { ExternalLink, History, MoreHorizontal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { openOpenInAppsSettings, WorktreeOpenInMenuItems } from '../sidebar/WorktreeOpenInMenu'
import type { WorkingSetsModalData } from '../working-set/WorkingSetsDialog'
import type { DeskWorkspaceIdentity } from '../../../../shared/desk-continuity-projection'
import { resumeCenterOpenInTarget } from './resume-center-open-in'
import { workingSetOwnerKey } from './resume-center-restore'

/** r01's "More options": the selected workspace's Snapshots and Open in, the two options with effects. */
export function ResumeCenterMoreOptions({
  row,
  name
}: {
  row: { key: string; hostId: string; identity: DeskWorkspaceIdentity } | null
  name: string
}): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const snapshotsAvailable = row !== null && row.identity.kind !== 'missing'
  const openInTarget = row ? resumeCenterOpenInTarget(row) : null
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={!row}>
        <Button
          variant="outline"
          data-testid="resume-center-more-options"
          className="h-auto max-w-64 items-start gap-2.5 px-4 py-2 text-left"
        >
          <MoreHorizontal className="mt-0.5 size-4" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="text-[13px] font-medium">
              {translate('resumeCenter.moreOptions.title', 'More options')}
            </span>
            <span className="truncate text-[11px] font-normal text-muted-foreground">
              {row
                ? translate('resumeCenter.moreOptions.hint', '{{name}}: snapshots, open in', {
                    name
                  })
                : translate('resumeCenter.restoreLayout.none', 'Select a workspace')}
            </span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      {row ? (
        <DropdownMenuContent align="end" className="w-60" data-testid="resume-center-more-menu">
          <DropdownMenuItem
            data-testid="resume-center-more-snapshots"
            disabled={!snapshotsAvailable}
            onSelect={() => {
              const data: WorkingSetsModalData = {
                ownerKey: workingSetOwnerKey(row.key),
                displayName: name
              }
              openModal('working-sets', data)
            }}
          >
            <History className="size-3.5" aria-hidden />
            {translate('resumeCenter.snapshots.title', 'Snapshots')}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              data-testid="resume-center-more-open-in"
              disabled={!openInTarget}
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {translate('resumeCenter.openIn.title', 'Open in')}
            </DropdownMenuSubTrigger>
            {openInTarget ? (
              <DropdownMenuSubContent
                className="w-52"
                data-testid="resume-center-more-open-in-menu"
              >
                <WorktreeOpenInMenuItems
                  worktreePath={openInTarget.worktreePath}
                  connectionId={openInTarget.connectionId}
                />
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={openOpenInAppsSettings}>
                  {translate(
                    'auto.components.sidebar.WorktreeOpenInMenu.1417fd8380',
                    'Customize apps...'
                  )}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            ) : null}
          </DropdownMenuSub>
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  )
}
