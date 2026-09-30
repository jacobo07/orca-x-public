import { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { captureBacklogItem, type BacklogMutationOutcome } from './backlog-mutation-client'

type CaptureStatus = 'idle' | 'submitting' | 'confirmed' | 'failed'
type CaptureFailure = Exclude<BacklogMutationOutcome['status'], 'confirmed'>

const SLOW_SUBMIT_MS = 200

function failureCopy(failure: CaptureFailure): string {
  switch (failure) {
    case 'storage-failed':
      return translate(
        'backlog.capture.failed.storageFailed',
        'Not captured. The ledger could not write this item. Your text is kept here; try again.'
      )
    case 'unreadable':
      return translate(
        'backlog.capture.failed.unreadable',
        'Not captured. The ledger on this host cannot be read right now. Your text is kept here; try again after reloading the backlog.'
      )
    case 'capability-unsupported':
      return translate(
        'backlog.capture.failed.capability',
        'Not captured. This host does not provide a Backlog.'
      )
    case 'unknown':
      return translate(
        'backlog.capture.failed.unknown',
        'We could not confirm this was saved. Check the list before capturing again.'
      )
    case 'unreachable':
      return translate(
        'backlog.capture.failed.unreachable',
        'Not captured. This host could not be reached. Your text is kept here; try again.'
      )
    default:
      return translate(
        'backlog.capture.failed.other',
        'Not captured. Your text is kept here; try again.'
      )
  }
}

/**
 * Confirmed-only capture (D-16): nothing is shown as saved until the ledger answered published.
 * A lost reply (`unknown`) keeps the text and asks the page to refetch; capture is never re-sent.
 */
export function BacklogCaptureDialog({
  open,
  onOpenChange,
  onConfirmed,
  onUncertain
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirmed: () => void
  onUncertain: () => void
}): React.JSX.Element {
  const environmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId ?? null)
  const [text, setText] = useState('')
  const [status, setStatus] = useState<CaptureStatus>('idle')
  const [failure, setFailure] = useState<CaptureFailure | null>(null)
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    if (status !== 'submitting') {
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), SLOW_SUBMIT_MS)
    return () => clearTimeout(timer)
  }, [status])

  const submitting = status === 'submitting'
  const canSubmit = text.trim() !== '' && !submitting

  const submit = async (): Promise<void> => {
    if (!canSubmit) {
      return
    }
    setStatus('submitting')
    setFailure(null)
    const outcome = await captureBacklogItem(
      { activeRuntimeEnvironmentId: environmentId },
      { text, kind: 'idea' }
    )
    if (outcome.status === 'confirmed') {
      setStatus('confirmed')
      onConfirmed()
      return
    }
    setStatus('failed')
    setFailure(outcome.status)
    if (outcome.status === 'unknown') {
      onUncertain()
    }
  }

  const handleOpenChange = (next: boolean): void => {
    if (!next && status === 'confirmed') {
      setText('')
      setStatus('idle')
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-backlog-capture-dialog=""
        data-backlog-capture-status={status}
        data-backlog-capture-failure={failure ?? undefined}
        className="gap-4 sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-medium leading-6">
            {translate('backlog.capture.title', 'Capture to backlog')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'backlog.capture.description',
              'Write it the way you think it. Project, kind and priority can change later.'
            )}
          </DialogDescription>
        </DialogHeader>
        {status === 'confirmed' ? (
          <p className="flex items-center gap-2 text-sm text-foreground">
            <Check className="size-4" aria-hidden />
            {translate('backlog.capture.confirmed', 'Captured to {{target}}', {
              target: translate('backlog.group.unassigned', 'Unassigned')
            })}
          </p>
        ) : (
          <Textarea
            autoFocus
            value={text}
            disabled={submitting}
            onChange={(event) => setText(event.target.value)}
            aria-label={translate('backlog.capture.textLabel', 'Item text')}
            aria-describedby={failure ? 'backlog-capture-failure' : undefined}
            data-backlog-capture-field="text"
            className="max-h-80 min-h-32"
          />
        )}
        {status === 'failed' && failure ? (
          <div
            id="backlog-capture-failure"
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-[12px] text-destructive"
          >
            {failureCopy(failure)}
          </div>
        ) : null}
        <DialogFooter>
          {status === 'confirmed' ? (
            <Button
              variant="ghost"
              data-backlog-capture-close=""
              onClick={() => handleOpenChange(false)}
            >
              {translate('backlog.capture.closeConfirmed', 'Close capture')}
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                data-backlog-capture-close=""
                onClick={() => handleOpenChange(false)}
              >
                {translate('backlog.capture.cancel', 'Close without capturing')}
              </Button>
              <Button
                className="w-36"
                disabled={!canSubmit}
                data-backlog-capture-submit=""
                onClick={() => void submit()}
              >
                {submitting && slow ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    {translate('backlog.capture.submitting', 'Capturing…')}
                  </>
                ) : (
                  translate('backlog.capture.submit', 'Capture item')
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
