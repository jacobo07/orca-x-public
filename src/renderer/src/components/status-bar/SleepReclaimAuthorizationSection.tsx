import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { AgentHibernationExclusionReason } from '@/lib/agent-hibernation-planner'
import type { SleepAuthorizationPlan } from '@/lib/agent-sleep-authorization-plan'
import { translate } from '@/i18n/i18n'
import { formatMemory } from './resource-memory-byte-format'
import type { ObserveReclaimAfterSleep } from '@/lib/agent-sleep-observed-reclaim'
import {
  SleepReclaimAuthorizationAction,
  type SleepActionOutcome,
  type SleepAuthorizedPanes
} from './SleepReclaimAuthorizationAction'

/**
 * What the canonical authorization plan says, rendered.
 *
 * Adds no eligibility logic and no reclaim arithmetic: every count and every
 * byte below is read straight off the plan. Deleting this file must leave
 * planner and coordinator correctness untouched — if it would not, the
 * projection has started deciding something.
 */

function describeExclusionReason(reason: AgentHibernationExclusionReason): string {
  switch (reason) {
    case 'feature-disabled':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.featureDisabled',
        'Agent sleep is off'
      )
    case 'worktree-active':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.worktreeActive',
        'In the open workspace'
      )
    case 'runtime-liveness-unknown':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.runtimeLivenessUnknown',
        'Remote terminal state not confirmed'
      )
    case 'tab-foreground':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.tabForeground',
        'Tab is open in front'
      )
    case 'agent-busy':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.agentBusy',
        'Agent still working'
      )
    case 'agent-interrupted':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.agentInterrupted',
        'Agent was interrupted'
      )
    case 'has-subagents':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.hasSubagents',
        'Subagents still running'
      )
    case 'dispatch-unsettled':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.dispatchUnsettled',
        'Dispatch not settled'
      )
    case 'already-sleeping':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.alreadySleeping',
        'Already asleep'
      )
    case 'pane-mismatch':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.paneMismatch',
        'Pane moved'
      )
    case 'not-resumable-agent':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.notResumable',
        'Could not be resumed'
      )
    case 'not-idle-long-enough':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.notIdleLongEnough',
        'Idle too briefly'
      )
    case 'recent-input':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.recentInput',
        'Typed in recently'
      )
    case 'no-live-pane':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.noLivePane',
        'No live terminal'
      )
    case 'mobile-locked':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.mobileLocked',
        'Held by a mobile client'
      )
    case 'tab-pinned':
      return translate(
        'auto.components.status.bar.resource.sleepReclaim.reason.tabPinned',
        'Pinned tab'
      )
  }
}

export function SleepReclaimAuthorizationSection({
  plan,
  onSleep,
  onObserve
}: {
  plan: SleepAuthorizationPlan
  /** Absent means read-only: no control that can destroy anything is rendered. */
  onSleep?: SleepAuthorizedPanes
  /** Post-effect observation; absent means the result claims nothing about memory. */
  onObserve?: ObserveReclaimAfterSleep
}): React.JSX.Element | null {
  const [showProtected, setShowProtected] = useState(false)
  // Why: held here, not in the action — a successful sleep can empty the plan,
  // which unmounts the action, and the user must still see what happened.
  const [sleepOutcome, setSleepOutcome] = useState<SleepActionOutcome | null>(null)

  const protectedReasons = useMemo(() => {
    const counts = new Map<AgentHibernationExclusionReason, number>()
    for (const subject of plan.excluded) {
      if (subject.exclusionReason === null) {
        continue
      }
      counts.set(subject.exclusionReason, (counts.get(subject.exclusionReason) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [plan.excluded])

  if (plan.reclaimable.length === 0 && plan.excluded.length === 0 && sleepOutcome === null) {
    return null
  }

  const { knownBytes, knownCount, unknownCount } = plan.estimate
  // Why: never show an unnamed number. Today's planner cannot produce measured
  // bytes without a metric (metric is null only with no snapshot), but the plan
  // type does not encode that, so a future producer must not reach a bare figure.
  const canStateSize = plan.metricCopy !== null && knownCount > 0

  return (
    <section
      className="border-b border-border px-3 py-2 text-[11px]"
      aria-label={translate(
        'auto.components.status.bar.resource.sleepReclaim.sectionLabel',
        'Idle agent memory'
      )}
      data-testid="sleep-reclaim-authorization"
      // Why: locale-proof handles for E2E; both are read straight off the plan.
      data-reclaimable-count={plan.reclaimable.length}
      data-excluded-count={plan.excluded.length}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-foreground">
          {plan.reclaimable.length === 1
            ? translate(
                'auto.components.status.bar.resource.sleepReclaim.idleOne',
                '1 idle agent can sleep'
              )
            : translate(
                'auto.components.status.bar.resource.sleepReclaim.idleMany',
                '{{value0}} idle agents can sleep',
                {
                  value0: plan.reclaimable.length
                }
              )}
        </span>
        {canStateSize && (
          <span className="shrink-0 tabular-nums text-muted-foreground" data-testid="reclaim-known">
            {translate(
              'auto.components.status.bar.resource.sleepReclaim.measured',
              '~{{value0}} {{value1}}',
              {
                value0: formatMemory(knownBytes),
                value1: plan.metricCopy?.summaryLabel ?? ''
              }
            )}
          </span>
        )}
      </div>

      {unknownCount > 0 && (
        <div className="mt-0.5 text-muted-foreground" data-testid="reclaim-unknown">
          {unknownCount === 1
            ? translate(
                'auto.components.status.bar.resource.sleepReclaim.unknownOne',
                '1 of them has not been measured, so it is not in this figure'
              )
            : translate(
                'auto.components.status.bar.resource.sleepReclaim.unknownMany',
                '{{value0}} of them have not been measured, so they are not in this figure',
                { value0: unknownCount }
              )}
        </div>
      )}

      {onSleep && (
        <SleepReclaimAuthorizationAction
          plan={plan}
          onSleep={onSleep}
          onObserve={onObserve}
          outcome={sleepOutcome}
          onOutcome={setSleepOutcome}
        />
      )}

      {protectedReasons.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowProtected((shown) => !shown)}
            aria-expanded={showProtected}
            className="mt-1 inline-flex items-center gap-1 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {showProtected ? (
              <ChevronDown className="size-3" aria-hidden />
            ) : (
              <ChevronRight className="size-3" aria-hidden />
            )}
            {plan.excluded.length === 1
              ? translate(
                  'auto.components.status.bar.resource.sleepReclaim.protectedOne',
                  '1 pane is kept awake'
                )
              : translate(
                  'auto.components.status.bar.resource.sleepReclaim.protectedMany',
                  '{{value0}} panes are kept awake',
                  {
                    value0: plan.excluded.length
                  }
                )}
          </button>
          {showProtected && (
            <ul className="mt-1 space-y-0.5 pl-4 text-muted-foreground">
              {protectedReasons.map(([reason, count]) => (
                <li key={reason} className="flex items-baseline justify-between gap-2">
                  <span className="truncate">{describeExclusionReason(reason)}</span>
                  <span className="shrink-0 tabular-nums">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
