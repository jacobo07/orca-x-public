import { useState } from 'react'
import { ArrowRightLeft, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { continueWorkingSetFromProduct } from '@/lib/project-working-set-product-restore'
import { cn } from '@/lib/utils'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import type { WorkingSetScopeKey } from '../../../../shared/project-working-set-store-types'
import { continueResultView, type ContinueResultView } from './working-set-continue-view'
import type { ContinueOffer } from './working-set-continue-targets'

type ShownResult = { forWorkingSetId: string; view: ContinueResultView }

/**
 * Continues the selected snapshot on another host's setup of the same project. It restores into
 * the other host's workspace and leaves this one, and this dialog, as they are; the per-pane list
 * is the planner's answer worded, not recomputed here.
 */
export function WorkingSetContinueAction({
  scope,
  offer,
  workingSetId,
  launchProfiles
}: {
  scope: WorkingSetScopeKey
  offer: ContinueOffer | null
  workingSetId: string | null
  /** undefined while resolving; null when the host could not be asked. */
  launchProfiles: readonly { id: string }[] | null | undefined
}): React.JSX.Element | null {
  const [targetSetupId, setTargetSetupId] = useState('')
  const [running, setRunning] = useState(false)
  const [shown, setShown] = useState<ShownResult | null>(null)
  const mountedRef = useMountedRef()

  if (offer === null) {
    return null
  }

  const canContinue =
    !running && workingSetId !== null && targetSetupId !== '' && launchProfiles !== undefined
  // Why keyed by the snapshot: a result for one snapshot must not read as the answer for another.
  const view = shown !== null && shown.forWorkingSetId === workingSetId ? shown.view : null

  const run = async (): Promise<void> => {
    if (workingSetId === null || launchProfiles === undefined) {
      return
    }
    setRunning(true)
    setShown(null)
    const result = await continueWorkingSetFromProduct({
      scope,
      workingSetId,
      launchProfiles,
      target: {
        projectId: offer.projectId,
        sourceLocation: offer.sourceLocation,
        sourceSetupId: offer.sourceSetupId,
        targetSetupId,
        setups: offer.setups
      }
    })
    if (!mountedRef.current) {
      return
    }
    setRunning(false)
    setShown({ forWorkingSetId: workingSetId, view: continueResultView(result) })
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="working-set-continue-section">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">
          {translate('workingSet.continue.targetLabel', 'Continue on')}
        </span>
        <Select value={targetSetupId} onValueChange={setTargetSetupId} disabled={running}>
          <SelectTrigger
            size="sm"
            className="min-w-0 flex-1"
            data-testid="working-set-continue-target"
          >
            <SelectValue
              placeholder={translate('workingSet.continue.targetPlaceholder', 'Choose a host')}
            />
          </SelectTrigger>
          <SelectContent>
            {offer.targets.map((setup) => (
              <SelectItem key={setup.id} value={setup.id}>
                {`${getExecutionHostLabel(setup.hostId)} · ${setup.displayName}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          data-testid="working-set-continue"
          disabled={!canContinue}
          onClick={() => void run()}
        >
          {running ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ArrowRightLeft className="size-3.5" />
          )}
          {running
            ? translate('workingSet.continue.running', 'Continuing…')
            : translate('workingSet.continue.action', 'Continue here')}
        </Button>
      </div>
      {view ? (
        <div
          role="status"
          data-testid="working-set-continue-result"
          data-continue-status={view.status}
          data-continue-tone={view.tone}
          className="flex min-w-0 flex-col gap-1 text-xs"
        >
          <p className={view.tone === 'problem' ? 'text-destructive' : 'text-muted-foreground'}>
            {view.sentence}
          </p>
          {view.panes.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {view.panes.map((pane) => (
                <li
                  key={pane.key}
                  data-testid="working-set-continue-pane"
                  data-pane-key={pane.key}
                  data-pane-disposition={pane.disposition}
                  data-pane-reason={pane.reason}
                  className={cn(
                    'flex min-w-0 flex-col',
                    pane.disposition === 'unavailable' ? 'text-destructive' : 'text-foreground'
                  )}
                >
                  <span className="truncate">
                    {pane.label}
                    {' · '}
                    {pane.dispositionText}
                  </span>
                  <span className="truncate text-muted-foreground">{pane.reasonText}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
