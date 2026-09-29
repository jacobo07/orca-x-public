import { translate } from '@/i18n/i18n'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { WorkspaceRowModel } from '../resume-center/resume-center-model'
import { MissionBriefPanel } from './MissionBriefPanel'

/** The full layout of the brief the Resume Center aside shows; both read one store entry. */
export function MissionBriefDialog({
  row,
  projectName,
  open,
  onOpenChange
}: {
  row: WorkspaceRowModel
  projectName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="mission-brief-dialog"
        className="max-h-[90vh] overflow-y-auto scrollbar-sleek p-0 sm:max-w-[1180px]"
      >
        <DialogTitle className="sr-only">
          {translate('missionBrief.title', 'Mission Brief')}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {translate('missionBrief.dialog.description', 'Mission records of {{name}}', {
            name: projectName
          })}
        </DialogDescription>
        {open ? (
          <MissionBriefPanel
            hostId={row.hostId}
            workspaceKey={row.key}
            projectName={projectName}
            row={row}
            variant="full"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
