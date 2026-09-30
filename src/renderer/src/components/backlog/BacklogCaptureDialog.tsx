import { useEffect, useId, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { resolveDefaultProjectId } from '@/components/agents/default-agent-project'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { BACKLOG_TEXT_MAX } from '../../../../shared/backlog-rpc-limits'
import type { BacklogItemKind, BacklogPriority } from '../../../../shared/backlog-types'
import {
  captureBacklogItem,
  type BacklogCaptureRequest,
  type BacklogMutationOutcome
} from './backlog-mutation-client'
import { BacklogProjectPicker } from './BacklogProjectPicker'
import {
  BacklogChoiceSelect,
  KIND_OPTIONS,
  PRIORITY_OPTIONS,
  backlogCharactersLeft,
  isBacklogSubmitChord
} from './BacklogRowEditForm'

type CaptureStatus = 'idle' | 'submitting' | 'confirmed' | 'failed'
type CaptureFailure = Exclude<BacklogMutationOutcome['status'], 'confirmed'>

const SLOW_SUBMIT_MS = 200
// D-18: a client bound only; the host's zod bound stays the authority.
const COUNTER_FROM = BACKLOG_TEXT_MAX - BACKLOG_TEXT_MAX / 10

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
    case 'refused':
    case 'forbidden':
    case 'stale':
    case 'absent':
    case 'schema-too-new':
      return translate(
        'backlog.capture.failed.other',
        'Not captured. Your text is kept here; try again.'
      )
  }
}

function FieldLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-xs font-medium">{children}</p>
}

/**
 * Confirmed-only capture (D-16): nothing is shown as saved until the ledger answered published.
 * A lost reply (`unknown`) keeps the text and asks the page to refetch; capture is never re-sent.
 */
export function BacklogCaptureDialog({
  open,
  onOpenChange,
  onConfirmed,
  onUncertain,
  returnFocusTo
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirmed: () => void
  onUncertain: () => void
  /** Where focus lands on close, even when the dialog was opened by a key from the page body. */
  returnFocusTo?: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const environmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId ?? null)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const projects = useAppStore((s) => s.projects)
  const readyId = useId()
  const [text, setText] = useState('')
  // null follows the active repo's project; a choice sticks until a confirmed capture is closed.
  const [projectChoice, setProjectChoice] = useState<string[] | null>(null)
  const [kind, setKind] = useState<BacklogItemKind>('idea')
  const [priority, setPriority] = useState<BacklogPriority>('normal')
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<CaptureStatus>('idle')
  const [failure, setFailure] = useState<CaptureFailure | null>(null)
  const [slow, setSlow] = useState(false)

  const defaultProject = resolveDefaultProjectId(activeRepoId, projects)
  const projectIds = projectChoice ?? (defaultProject ? [defaultProject] : [])

  useEffect(() => {
    if (status !== 'submitting') {
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), SLOW_SUBMIT_MS)
    return () => clearTimeout(timer)
  }, [status])

  const submitting = status === 'submitting'
  const overLimit = text.length > BACKLOG_TEXT_MAX
  const canSubmit = text.trim() !== '' && !overLimit && !submitting
  const isMac = navigator.userAgent.includes('Mac')
  const names = projectIds.map(
    (id) =>
      projects.find((project) => project.id === id)?.displayName ??
      translate('backlog.group.unknown', 'Unknown project')
  )

  const submit = async (): Promise<void> => {
    if (!canSubmit) {
      return
    }
    setStatus('submitting')
    setFailure(null)
    const request: BacklogCaptureRequest = { text, kind, priority }
    if (projectIds.length > 0) {
      request.projectRefs = projectIds.map((projectId) => ({
        projectId,
        mapping: 'explicit',
        evidence: ''
      }))
    }
    if (ready) {
      request.initialState = 'ready'
    }
    const outcome = await captureBacklogItem({ activeRuntimeEnvironmentId: environmentId }, request)
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

  const captureAnother = (): void => {
    setProjectChoice(projectIds)
    setText('')
    setStatus('idle')
    // The text field remounts with autoFocus, which refocuses it.
    setFailure(null)
  }

  const handleOpenChange = (next: boolean): void => {
    if (!next && status === 'confirmed') {
      setText('')
      setStatus('idle')
      setProjectChoice(null)
      setKind('idea')
      setPriority('normal')
      setReady(false)
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
        onKeyDown={(event) => {
          if (status !== 'confirmed' && isBacklogSubmitChord(event)) {
            event.preventDefault()
            void submit()
          }
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocusTo?.current) {
            event.preventDefault()
            returnFocusTo.current.focus()
          }
        }}
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
          <p role="status" className="flex items-center gap-2 text-sm text-foreground">
            <Check className="size-4" aria-hidden />
            {translate('backlog.capture.confirmed', 'Captured to {{target}}', {
              target:
                names.length > 0
                  ? names.join(', ')
                  : translate('backlog.group.unassigned', 'Unassigned')
            })}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Textarea
                autoFocus
                value={text}
                disabled={submitting}
                onChange={(event) => setText(event.target.value)}
                aria-label={translate('backlog.capture.textLabel', 'Item text')}
                aria-invalid={overLimit}
                aria-describedby={failure ? 'backlog-capture-failure' : undefined}
                data-backlog-capture-field="text"
                className="max-h-80 min-h-32"
              />
              {overLimit ? (
                <p className="text-right text-xs text-destructive">
                  {translate(
                    'backlog.capture.overLimit',
                    'Text is over the 20,000-character limit'
                  )}
                </p>
              ) : text.length >= COUNTER_FROM ? (
                <p
                  data-backlog-capture-counter=""
                  className="text-right text-xs text-muted-foreground"
                >
                  {backlogCharactersLeft(BACKLOG_TEXT_MAX - text.length)}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <FieldLabel>{translate('backlog.capture.projectLabel', 'Project')}</FieldLabel>
              <BacklogProjectPicker
                selected={projectIds}
                onChange={setProjectChoice}
                handle={{ 'data-backlog-capture-field': 'project' }}
                disabled={submitting}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <FieldLabel>{translate('backlog.detail.kind', 'Kind')}</FieldLabel>
                <BacklogChoiceSelect
                  handle={{ 'data-backlog-capture-field': 'kind' }}
                  value={kind}
                  label={translate('backlog.detail.kind', 'Kind')}
                  options={KIND_OPTIONS()}
                  onValueChange={setKind}
                  disabled={submitting}
                />
              </div>
              <div className="space-y-2">
                <FieldLabel>{translate('backlog.detail.priority', 'Priority')}</FieldLabel>
                <BacklogChoiceSelect
                  handle={{ 'data-backlog-capture-field': 'priority' }}
                  value={priority}
                  label={translate('backlog.detail.priority', 'Priority')}
                  options={PRIORITY_OPTIONS()}
                  onValueChange={setPriority}
                  disabled={submitting}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id={readyId}
                checked={ready}
                onCheckedChange={setReady}
                disabled={submitting}
                data-backlog-capture-field="ready"
              />
              <Label htmlFor={readyId} className="text-xs">
                {translate('backlog.capture.ready', 'Mark as ready')}
              </Label>
            </div>
          </div>
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
            <>
              <Button
                variant="ghost"
                data-backlog-capture-close=""
                onClick={() => handleOpenChange(false)}
              >
                {translate('backlog.capture.closeConfirmed', 'Close capture')}
              </Button>
              <Button autoFocus data-backlog-capture-another="" onClick={captureAnother}>
                {translate('backlog.capture.another', 'Capture another item')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                data-backlog-capture-close=""
                onClick={() => handleOpenChange(false)}
              >
                {translate('backlog.capture.cancel', 'Close without capturing')}
              </Button>
              <span data-backlog-capture-shortcut="" className="flex items-center">
                <ShortcutKeyCombo keys={[isMac ? '⌘' : 'Ctrl', 'Enter']} />
              </span>
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
