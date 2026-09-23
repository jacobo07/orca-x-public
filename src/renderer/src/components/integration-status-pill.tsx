import { cn } from '@/lib/utils'

export type IntegrationStatusTone = 'connected' | 'attention' | 'unknown' | 'neutral'

// One recipe per tone, all of it through the status tokens: see docs/STYLEGUIDE.md
// "Status semantics". These were raw Tailwind scale literals, which is why the same "be
// careful" meaning had drifted into amber here, orange in the experimental settings and an
// inline yellow in the cache timer.
const TONE_CLASSES: Record<IntegrationStatusTone, { pill: string; dot: string }> = {
  connected: {
    pill: 'border-status-success-border bg-status-success-background text-status-success',
    dot: 'bg-status-success'
  },
  attention: {
    pill: 'border-status-warning-border bg-status-warning-background text-status-warning',
    dot: 'bg-status-warning'
  },
  // Hollow where every other tone is filled. Unknown has to stay readable at this size, in
  // greyscale, and for someone who cannot separate the hues — so the shape carries it and the
  // colour only reinforces it.
  unknown: {
    pill: 'border-status-unknown-border bg-status-unknown-background text-status-unknown',
    dot: 'border border-status-unknown bg-transparent'
  },
  neutral: {
    pill: 'border-border bg-background text-muted-foreground',
    dot: 'bg-muted-foreground'
  }
}

export function IntegrationStatusPill({
  tone,
  children
}: {
  tone: IntegrationStatusTone
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        TONE_CLASSES[tone].pill
      )}
    >
      <span className={cn('size-1.5 rounded-full', TONE_CLASSES[tone].dot)} />
      {children}
    </span>
  )
}
