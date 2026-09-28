import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import type { WorkspaceRowModel } from './resume-center-model'
import {
  continueResumeAll,
  hasPausedResumeAll,
  planResumeAll,
  runResumeAll
} from './resume-all-queue'
import { describeResumeAllStop, useWakeState } from './resume-center-wake-copy'
import { ClaimValue } from './ClaimValue'

/**
 * Resume all is an intent, paced by admission: one wake at a time, stopping at the first host-wide
 * refusal. Continue asks again from where it stopped, over the plan the user started, never a new one.
 */
export function ResumeCenterResumeAll({
  rows
}: {
  rows: readonly WorkspaceRowModel[]
}): React.JSX.Element {
  const state = useWakeState().resumeAll
  return (
    <div className="flex flex-col items-end gap-1" data-testid="resume-center-resume-all">
      <div className="flex gap-2">
        {state.status === 'stopped' && hasPausedResumeAll() ? (
          <Button
            size="sm"
            data-testid="resume-center-resume-all-continue"
            onClick={() => void continueResumeAll()}
          >
            {translate('resumeCenter.resumeAll.continue', 'Continue')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          data-testid="resume-center-resume-all-start"
          disabled={state.status === 'running'}
          onClick={() => void runResumeAll(planResumeAll(rows), 0)}
        >
          {translate('resumeCenter.resumeAll.start', 'Resume all')}
        </Button>
      </div>
      <p
        className="text-[11px] text-muted-foreground"
        data-testid="resume-center-resume-all-status"
        data-status={state.status}
      >
        {state.status === 'running' ? (
          <>
            {translate('resumeCenter.resumeAll.running', 'Resuming one at a time:')}{' '}
            <ClaimValue testId="resume-center-resume-all-done">{state.done}</ClaimValue>
            {' / '}
            <ClaimValue testId="resume-center-resume-all-total">{state.total}</ClaimValue>
          </>
        ) : state.status === 'stopped' ? (
          <>
            {translate('resumeCenter.resumeAll.stopped', 'Paused. Started:')}{' '}
            <ClaimValue testId="resume-center-resume-all-started">{state.started}</ClaimValue>
            {' · '}
            {translate('resumeCenter.resumeAll.remaining', 'still asleep:')}{' '}
            <ClaimValue testId="resume-center-resume-all-remaining">{state.remaining}</ClaimValue>
            {'. '}
            {describeResumeAllStop(state)}
          </>
        ) : state.status === 'finished' ? (
          <>
            {translate('resumeCenter.resumeAll.finished', 'Done. Started:')}{' '}
            <ClaimValue testId="resume-center-resume-all-started">{state.started}</ClaimValue>
            {' · '}
            {translate('resumeCenter.resumeAll.leftAsleep', 'left asleep:')}{' '}
            <ClaimValue testId="resume-center-resume-all-left-asleep">
              {state.leftAsleep}
            </ClaimValue>
          </>
        ) : null}
      </p>
    </div>
  )
}
