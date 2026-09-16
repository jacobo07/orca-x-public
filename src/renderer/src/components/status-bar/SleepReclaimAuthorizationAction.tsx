import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { SleepAuthorizationPlan } from '@/lib/agent-sleep-authorization-plan'
import type { AgentSleepAuthorization, AgentSleepResult } from '@/lib/agent-hibernation-coordinator'
import { translate } from '@/i18n/i18n'

export type SleepAuthorizedPanes = (
  authorizations: AgentSleepAuthorization[]
) => Promise<AgentSleepResult[]>

/**
 * The explicit "sleep these now" control. It forwards what the user was shown —
 * never a live re-read — and reports what the coordinator actually did. It says
 * nothing about memory freed: the figure above was an estimate made before.
 */
export function SleepReclaimAuthorizationAction({
  plan,
  onSleep
}: {
  plan: SleepAuthorizationPlan
  onSleep: SleepAuthorizedPanes
}): React.JSX.Element | null {
  const [pending, setPending] = useState(false)
  const [results, setResults] = useState<AgentSleepResult[] | null>(null)

  const authorizations = plan.reclaimable.flatMap((subject) =>
    subject.authorization ? [subject.authorization] : []
  )
  if (authorizations.length === 0 && results === null) {
    return null
  }

  const sleep = async (): Promise<void> => {
    setPending(true)
    try {
      setResults(await onSleep(authorizations))
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
      {results !== null && !pending && <SleepReclaimResultSummary results={results} />}
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
