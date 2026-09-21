import React from 'react'
import { translate } from '@/i18n/i18n'
import type {
  ObservedReclaim,
  ObservedReclaimUnmeasuredReason
} from '@/lib/agent-sleep-reclaim-projection'
import { formatMemory } from './resource-memory-byte-format'
import { getResourceMemoryMetricCopy } from './resource-memory-metric-copy'

/**
 * What the follow-up sweep proved, rendered. No arithmetic: every number is
 * read off the observer's result, and an unmeasured result shows no number.
 */
export function SleepReclaimObservedReclaim({
  reclaim
}: {
  reclaim: ObservedReclaim | 'pending'
}): React.JSX.Element | null {
  if (reclaim === 'pending') {
    return (
      <div
        className="text-muted-foreground"
        data-testid="sleep-reclaim-observed"
        data-status="pending"
      >
        {translate(
          'auto.components.status.bar.resource.sleepReclaim.observed.pending',
          'Checking which of their processes exited…'
        )}
      </div>
    )
  }
  if (reclaim.status === 'unmeasured') {
    // Why: with nothing slept there is no effect to observe, so there is nothing to say.
    if (reclaim.reason === 'nothing-slept') {
      return null
    }
    return (
      // Not muted: muted is what a measured value and a pending check already use, so
      // "we did not measure this" was rendering as "nothing to see here".
      <div
        className="text-status-unknown"
        data-testid="sleep-reclaim-observed"
        data-status="unmeasured"
        data-reason={reclaim.reason}
      >
        {translate(
          'auto.components.status.bar.resource.sleepReclaim.observed.unmeasured',
          'Memory released was not measured: {{value0}}',
          { value0: describeUnmeasured(reclaim.reason) }
        )}
      </div>
    )
  }

  const parts: string[] = [
    reclaim.bytes > 0
      ? translate(
          'auto.components.status.bar.resource.sleepReclaim.observed.released',
          'Their exited processes had used {{value0}} {{value1}}',
          {
            value0: formatMemory(reclaim.bytes),
            value1: getResourceMemoryMetricCopy(reclaim.metric).summaryLabel
          }
        )
      : translate(
          'auto.components.status.bar.resource.sleepReclaim.observed.noneExited',
          'None of their measured processes has exited yet'
        )
  ]
  if (reclaim.bytes > 0 && reclaim.stillRunningProcessCount > 0) {
    parts.push(
      translate(
        'auto.components.status.bar.resource.sleepReclaim.observed.stillRunning',
        '{{value0}} of their processes still running',
        { value0: reclaim.stillRunningProcessCount }
      )
    )
  }
  if (reclaim.unmeasuredPaneCount > 0) {
    parts.push(
      translate(
        'auto.components.status.bar.resource.sleepReclaim.observed.unmeasuredPanes',
        '{{value0}} slept without a measurement',
        { value0: reclaim.unmeasuredPaneCount }
      )
    )
  }
  return (
    <div
      className="text-muted-foreground"
      data-testid="sleep-reclaim-observed"
      data-status="measured"
      data-bytes={reclaim.bytes}
      data-still-running={reclaim.stillRunningProcessCount}
      data-measured-panes={reclaim.measuredPaneCount}
      data-unmeasured-panes={reclaim.unmeasuredPaneCount}
      data-metric={reclaim.metric}
    >
      {parts.join(' · ')}
    </div>
  )
}

function describeUnmeasured(
  reason: Exclude<ObservedReclaimUnmeasuredReason, 'nothing-slept'>
): string {
  switch (reason) {
    case 'no-baseline':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.observed.reason.noBaseline',
        'there was no reading of their processes from before'
      )
    case 'sweep-unavailable':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.observed.reason.sweepUnavailable',
        'the follow-up reading was unavailable'
      )
    case 'sweep-failed':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.observed.reason.sweepFailed',
        'the follow-up reading failed'
      )
    case 'sweep-predates-request':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.observed.reason.sweepTooEarly',
        'the follow-up reading started too early'
      )
    case 'metric-changed':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.observed.reason.metricChanged',
        'the two readings used different measures'
      )
  }
}
