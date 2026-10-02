import { cn } from '@/lib/utils'

/** The six SYSTEM states of docs/STYLEGUIDE.md "Status semantics" (config/status-semantics.jsonc). */
export type StatusState =
  | 'HEALTHY'
  | 'PRESSURED'
  | 'CRITICAL'
  | 'UNKNOWN'
  | 'NEEDS_APPROVAL'
  | 'IDLE'

export const STATUS_STATES: readonly StatusState[] = [
  'HEALTHY',
  'PRESSURED',
  'CRITICAL',
  'UNKNOWN',
  'NEEDS_APPROVAL',
  'IDLE'
]

type MarkSpec = { cssVar: string; shape: 'filled' | 'hollow'; className: string }

// Literal class strings so Tailwind sees them; the test binds cssVar + shape to the manifest.
export const STATUS_MARK: Record<StatusState, MarkSpec> = {
  HEALTHY: { cssVar: 'status-success', shape: 'filled', className: 'bg-[var(--status-success)]' },
  PRESSURED: { cssVar: 'status-warning', shape: 'filled', className: 'bg-[var(--status-warning)]' },
  CRITICAL: { cssVar: 'status-error', shape: 'filled', className: 'bg-[var(--status-error)]' },
  UNKNOWN: {
    cssVar: 'status-unknown',
    shape: 'hollow',
    className: 'border border-[var(--status-unknown)] bg-transparent'
  },
  NEEDS_APPROVAL: {
    cssVar: 'agent-question',
    shape: 'filled',
    className: 'bg-[var(--agent-question)]'
  },
  IDLE: {
    cssVar: 'muted-foreground',
    shape: 'hollow',
    className: 'border border-muted-foreground bg-transparent'
  }
}

/**
 * The dot for a system state. Shape carries UNKNOWN/IDLE without colour; `label` names the state
 * for assistive tech when no visible word sits beside the mark.
 */
export function StatusMark({
  state,
  label,
  className
}: {
  state: StatusState
  label?: string
  className?: string
}): React.JSX.Element {
  const spec = STATUS_MARK[state]
  return (
    <span
      data-status-mark={state}
      data-status-shape={spec.shape}
      className={cn('inline-block size-2 shrink-0 rounded-full', spec.className, className)}
      {...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}
    />
  )
}
