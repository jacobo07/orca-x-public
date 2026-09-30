import { XIcon } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@/components/ui/dialog'
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
      {/* Why a bare frame: the brief card is the surface, and the default close would sit on its
          read time; the close moves above the card and the scroll into an inner box. */}
      <DialogContent
        data-testid="mission-brief-dialog"
        showCloseButton={false}
        className="gap-0 overflow-visible border-0 bg-transparent p-0 shadow-none backdrop-blur-none sm:max-w-[964px] dark:bg-transparent dark:shadow-none"
      >
        <DialogTitle className="sr-only">
          {translate('missionBrief.title', 'Mission Brief')}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {translate('missionBrief.dialog.description', 'Mission records of {{name}}', {
            name: projectName
          })}
        </DialogDescription>
        <DialogClose
          className="absolute -top-9 right-0 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={translate('auto.components.ui.dialog.f26c4baeda', 'Close')}
        >
          <XIcon className="size-4" aria-hidden />
        </DialogClose>
        {/* Why minus 2.5rem: keeps room above the centred card for the close on short windows. */}
        <div className="max-h-[calc(85vh-2.5rem)] overflow-y-auto scrollbar-sleek">
          {open ? (
            <MissionBriefPanel
              hostId={row.hostId}
              workspaceKey={row.key}
              projectName={projectName}
              row={row}
              variant="full"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
