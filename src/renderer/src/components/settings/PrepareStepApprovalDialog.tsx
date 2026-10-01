import React, { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { PrepareStepLabel } from '../../../../shared/environment-prepare-plan'

export type PrepareStepApprovalDialogProps = {
  open: boolean
  repoName: string
  hostLabel: string
  step: { requirementId: string; bytes: string; labels: PrepareStepLabel[] }
  // Records the approval; the dialog reports success only after this resolves.
  onApprove: () => Promise<void>
  onApproved: () => void
  onCancel: () => void
}

function labelText(label: PrepareStepLabel): string {
  return label === 'asks-for-elevation'
    ? translate(
        'auto.components.settings.PrepareStepApprovalDialog.asksForElevation',
        'This step asks for elevated privileges.'
      )
    : translate(
        'auto.components.settings.PrepareStepApprovalDialog.scriptNotCovered',
        "This step runs a script from the repository. The script's own contents are not covered by this approval."
      )
}

export function PrepareStepApprovalDialog({
  open,
  repoName,
  hostLabel,
  step,
  onApprove,
  onApproved,
  onCancel
}: PrepareStepApprovalDialogProps): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  const confirm = useCallback(async () => {
    setPending(true)
    setFailed(false)
    try {
      await onApprove()
    } catch {
      // Why: the cause stays in logs; the person is told the product consequence, never the raw text.
      setFailed(true)
      setPending(false)
      return
    }
    setPending(false)
    onApproved()
  }, [onApprove, onApproved])

  return (
    // Why: closing or Escape is a "no", and is ignored while the approval is being recorded.
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !pending && onCancel()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-[520px]"
        data-prepare-approval-dialog=""
        data-requirement-id={step.requirementId}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.settings.PrepareStepApprovalDialog.title',
              'Run this setup step?'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.settings.PrepareStepApprovalDialog.description',
              'Orca will run the text below in a terminal on {{value0}} for {{value1}}. Approving records this exact text for this host only.',
              { value0: hostLabel, value1: repoName }
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <pre
            data-prepare-approval-bytes=""
            className="scrollbar-sleek max-h-48 overflow-auto rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-all select-text"
          >
            {step.bytes}
          </pre>
          {step.labels.map((label) => (
            <div
              key={label}
              data-prepare-step-label={label}
              className="text-[11px] text-muted-foreground"
            >
              {labelText(label)}
            </div>
          ))}
          {pending ? (
            <div data-prepare-approval-pending="" className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.PrepareStepApprovalDialog.pending',
                'Recording the approval…'
              )}
            </div>
          ) : null}
          {failed ? (
            <div
              data-prepare-approval-error=""
              role="alert"
              className="text-[11px] text-destructive"
            >
              {translate(
                'auto.components.settings.PrepareStepApprovalDialog.failed',
                'Orca could not record the approval, so nothing was run. Try again.'
              )}
            </div>
          ) : null}
        </div>
        <DialogFooter className="mt-1">
          {/* Why autoFocus here and not on Approve: a stray Enter must never approve a command. */}
          <Button
            variant="outline"
            size="sm"
            autoFocus
            data-prepare-cancel=""
            onClick={onCancel}
            disabled={pending}
          >
            {translate('auto.components.settings.PrepareStepApprovalDialog.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            data-prepare-approve=""
            onClick={() => void confirm()}
            disabled={pending}
          >
            {translate(
              'auto.components.settings.PrepareStepApprovalDialog.approve',
              'Approve and run'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
