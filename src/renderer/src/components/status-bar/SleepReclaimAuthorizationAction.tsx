import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { SleepAuthorizationPlan } from '@/lib/agent-sleep-authorization-plan'
import type { AgentSleepAuthorization, AgentSleepResult } from '@/lib/agent-hibernation-coordinator'
import type { ObserveReclaimAfterSleep } from '@/lib/agent-sleep-observed-reclaim'
import type { ObservedReclaim } from '@/lib/agent-sleep-reclaim-projection'
import { translate } from '@/i18n/i18n'
import { SleepReclaimObservedReclaim } from './SleepReclaimObservedReclaim'

export type SleepAuthorizedPanes = (
  authorizations: AgentSleepAuthorization[]
) => Promise<AgentSleepResult[]>

/** What one explicit sleep did, and — separately — what a later sweep proved about it. */
export type SleepActionOutcome = {
  results: AgentSleepResult[]
  /** null when no observer is wired; 'pending' while the follow-up sweep runs. */
  reclaim: ObservedReclaim | 'pending' | null
}

/**
 * The explicit "sleep these now" control. It forwards what the user was shown —
 * never a live re-read — and reports what the coordinator actually did. Memory
 * is reported only from the observer's post-effect result, never from the
 * estimate above.
 */
export function SleepReclaimAuthorizationAction({
  plan,
  onSleep,
  onObserve,
  outcome,
  onOutcome
}: {
  plan: SleepAuthorizationPlan
  onSleep: SleepAuthorizedPanes
  onObserve?: ObserveReclaimAfterSleep
  /** Owned by the section, so it survives this control unmounting mid-sleep. */
  outcome: SleepActionOutcome | null
  onOutcome: (outcome: SleepActionOutcome) => void
}): React.JSX.Element | null {
  const [pending, setPending] = useState(false)

  const authorizations = plan.reclaimable.flatMap((subject) =>
    subject.authorization ? [subject.authorization] : []
  )
  if (authorizations.length === 0 && outcome === null) {
    return null
  }

  const sleep = async (): Promise<void> => {
    setPending(true)
    // Why: the subjects the user saw are the baseline; a re-render mid-sleep must not replace them.
    const subjects = plan.reclaimable
    try {
      const results = await onSleep(authorizations)
      if (!onObserve) {
        onOutcome({ results, reclaim: null })
        return
      }
      // Why: the effect is already true; show it before the slower observation lands.
      onOutcome({ results, reclaim: 'pending' })
      let reclaim: ObservedReclaim
      try {
        // Why: only after the coordinator returned — that ordering is what makes absence mean exit.
        reclaim = await onObserve({ subjects, results })
      } catch (err) {
        console.warn('[sleep] post-effect observation failed', err)
        reclaim = {
          status: 'unmeasured',
          reason: 'sweep-unavailable',
          sleptPaneCount: results.filter((r) => r.outcome === 'slept').length
        }
      }
      onOutcome({ results, reclaim })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {authorizations.length > 0 && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="self-start"
          disabled={pending}
          onClick={() => void sleep()}
          data-testid="sleep-reclaim-action"
        >
          {pending
            ? translate(
                'auto.components.status.bar.resource.sleepReclaim.sleeping',
                'Putting agents to sleep…'
              )
            : authorizations.length === 1
              ? translate(
                  'auto.components.status.bar.resource.sleepReclaim.sleepOne',
                  'Sleep 1 agent now'
                )
              : translate(
                  'auto.components.status.bar.resource.sleepReclaim.sleepMany',
                  'Sleep {{value0}} agents now',
                  { value0: authorizations.length }
                )}
        </Button>
      )}
      {/* Why: a previous outcome is hidden while a new sleep runs, but this sleep's own stays up while it is measured. */}
      {outcome !== null && (!pending || outcome.reclaim === 'pending') && (
        <>
          <SleepReclaimResultSummary results={outcome.results} />
          {outcome.reclaim !== null && <SleepReclaimObservedReclaim reclaim={outcome.reclaim} />}
        </>
      )}
    </div>
  )
}

function SleepReclaimResultSummary({
  results
}: {
  results: AgentSleepResult[]
}): React.JSX.Element {
  const slept = results.filter((r) => r.outcome === 'slept').length
  const failed = results.filter((r) => r.outcome === 'failed').length
  // Why: changed, no-longer-eligible and already-running all mean "left awake on purpose".
  const kept = results.length - slept - failed
  const parts: string[] = []
  if (slept > 0) {
    parts.push(
      translate(
        'auto.components.status.bar.resource.sleepReclaim.resultSlept',
        '{{value0}} put to sleep',
        {
          value0: slept
        }
      )
    )
  }
  if (kept > 0) {
    parts.push(
      translate(
        'auto.components.status.bar.resource.sleepReclaim.resultKept',
        '{{value0}} kept awake because they changed since shown',
        { value0: kept }
      )
    )
  }
  if (failed > 0) {
    parts.push(
      translate(
        'auto.components.status.bar.resource.sleepReclaim.resultFailed',
        '{{value0}} could not be put to sleep',
        { value0: failed }
      )
    )
  }
  return (
    <div
      role="status"
      className="text-muted-foreground"
      data-testid="sleep-reclaim-result"
      data-slept-count={slept}
      data-kept-count={kept}
      data-failed-count={failed}
    >
      {parts.join(' · ')}
    </div>
  )
}
