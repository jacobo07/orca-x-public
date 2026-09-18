import { useMemo, useRef } from 'react'
import { Trash, Undo2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiscardAllArea } from './discard-all-sequence'
import {
  getDiscardAreaConfirmationCopy,
  getDiscardEntryConfirmationCopy
} from './discard-confirmation'
import { translate } from '@/i18n/i18n'

export type PendingDiscardConfirmation =
  | { kind: 'entry'; entry: GitStatusEntry }
  /**
   * Rows rather than paths, because this is the record of what the user was looking at when they asked.
   * Looking the rows back up at confirm time would read the store as it is THEN -- and if a file moved
   * while the dialog was open, that is the newer state, which the user never saw. Authorization is
   * anchored where the click was.
   */
  | { kind: 'area'; area: DiscardAllArea; entries: readonly GitStatusEntry[] }

export function focusDiscardDialogConfirmButton(
  event: Event,
  confirmButton: HTMLButtonElement | null
): void {
  if (!confirmButton) {
    return
  }
  // Why: Radix otherwise focuses Cancel first, making Enter dismiss this destructive confirm.
  event.preventDefault()
  confirmButton.focus()
}

export function SourceControlDiscardDialog({
  pendingDiscard,
  onCancel,
  onConfirm
}: {
  pendingDiscard: PendingDiscardConfirmation | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const pendingDiscardCopy = useMemo(() => {
    if (!pendingDiscard) {
      return null
    }
    if (pendingDiscard.kind === 'entry') {
      return getDiscardEntryConfirmationCopy(pendingDiscard.entry)
    }
    return getDiscardAreaConfirmationCopy(pendingDiscard.area, pendingDiscard.entries.length)
  }, [pendingDiscard])
  const PendingDiscardIcon = pendingDiscardCopy?.confirmLabel.startsWith('Delete') ? Trash : Undo2

  return (
    <Dialog
      open={pendingDiscard !== null}
      onOpenChange={(open) => {
        if (!open) {
          onCancel()
        }
      }}
    >
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) =>
          focusDiscardDialogConfirmButton(event, confirmButtonRef.current)
        }
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {pendingDiscardCopy?.title ??
              translate(
                'auto.components.right.sidebar.source.control.discard.dialog.1551c14668',
                'Discard changes?'
              )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {pendingDiscardCopy?.description ??
              translate(
                'auto.components.right.sidebar.source.control.discard.dialog.0d2d88cba5',
                'This cannot be undone.'
              )}
          </DialogDescription>
        </DialogHeader>
        {pendingDiscard?.kind === 'area' ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
            {pendingDiscard.entries.length}{' '}
            {pendingDiscard.entries.length === 1
              ? translate(
                  'auto.components.right.sidebar.source.control.discard.dialog.e7611dca35',
                  'file'
                )
              : translate(
                  'auto.components.right.sidebar.source.control.discard.dialog.42f89dd030',
                  'files'
                )}
          </div>
        ) : pendingDiscard?.kind === 'entry' ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all font-medium text-foreground">{pendingDiscard.entry.path}</div>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {translate(
              'auto.components.right.sidebar.source.control.discard.dialog.3bc61dc989',
              'Cancel'
            )}
          </Button>
          <Button
            ref={confirmButtonRef}
            // Why a testid on this one: its label is translated AND varies by row kind, and the dialog's
            // last button is the content's close X rather than this. A test reaching for either found
            // cancel, which leaves the file intact -- indistinguishable from a refusal working.
            data-testid="source-control-discard-confirm"
            type="button"
            variant="destructive"
            autoFocus
            onClick={onConfirm}
          >
            <PendingDiscardIcon className="size-4" />
            {pendingDiscardCopy?.confirmLabel ??
              translate(
                'auto.components.right.sidebar.source.control.discard.dialog.15efa778e3',
                'Discard'
              )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
