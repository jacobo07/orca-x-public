import React from 'react'
import { cn } from '@/lib/utils'
import {
  formatAutomationLastRunCell,
  type AutomationLastRunSnapshot
} from './automation-list-last-run'

export function AutomationListLastRunCell({
  snapshot,
  now
}: {
  snapshot: AutomationLastRunSnapshot
  now: number
}): React.JSX.Element {
  const cell = formatAutomationLastRunCell(snapshot, now)
  const failed = cell.tone === 'failed'
  // Why: only a failure is actionable, so only a failure colours the row's text. Success gets the
  // dot alone — enough to stop `unknown` from borrowing its appearance, quiet enough that a healthy
  // list does not read as a wall of green. Everything else (running, skipped, unknown) stays grey:
  // not actionable, and not claimed to have gone well.
  const succeeded = cell.tone === 'succeeded'
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 truncate',
        // `destructive` is scoped to irreversible actions in docs/STYLEGUIDE.md; a run outcome is
        // a state, which is what --status-error is for.
        failed ? 'text-status-error' : 'text-muted-foreground'
      )}
      title={cell.title}
    >
      {cell.tone !== 'never' ? (
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            failed
              ? 'bg-status-error'
              : succeeded
                ? 'bg-status-success'
                : 'bg-muted-foreground/70'
          )}
          aria-hidden="true"
        />
      ) : null}
      <span className="truncate">{cell.text}</span>
    </span>
  )
}
